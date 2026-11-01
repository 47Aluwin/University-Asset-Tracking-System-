// Keeps the offline queue moving: sends saved actions when the app starts, when the connection comes back,
// when the app returns to the foreground, and every minute while anything is waiting.
import * as Network from 'expo-network';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import type { SyncSummary } from '@shared/offline-queue';

import { useSession } from '../session';
import { offlineCapable, prefetchForOffline, queue, queueReady, topUpReservedIds, type QueuedOp } from './index';

type OfflineValue = {
  /** This user's saved actions, oldest first (including recently synced ones). */
  ops: QueuedOp[];
  /** Not yet accepted by the server and still to be sent. */
  waiting: number;
  /** Refused by the server or in conflict: need the user's attention. */
  problems: number;
  online: boolean;
  syncing: boolean;
  last: { at: string; summary: SyncSummary } | null;
  syncNow: () => Promise<void>;
  retry: (id: string, body?: unknown) => Promise<void>;
  discard: (id: string) => Promise<void>;
};

const OfflineContext = createContext<OfflineValue | null>(null);

export function OfflineProvider({ children }: { children: ReactNode }) {
  const { user, can } = useSession();
  const userId = user?.id ?? null;
  const [version, setVersion] = useState(0);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [last, setLast] = useState<OfflineValue['last']>(null);
  const busy = useRef(false);

  useEffect(() => queue.subscribe(() => setVersion((v) => v + 1)) as unknown as () => void, []);

  const syncNow = useCallback(async () => {
    if (!userId || busy.current) return;
    busy.current = true;
    setSyncing(true);
    try {
      await queueReady();
      const summary = await queue.sync(userId);
      setLast({ at: new Date().toISOString(), summary });
      setOnline(!summary.offline);
      if (!summary.offline) {
        await prefetchForOffline();
        if (can('assets.register')) await topUpReservedIds(userId);
      }
    } finally {
      busy.current = false;
      setSyncing(false);
    }
  }, [userId, can]);

  // Start-up, connection changes and returning to the app.
  useEffect(() => {
    if (!userId) return;
    void syncNow();
    const net = Network.addNetworkStateListener((s) => {
      const up = s.isConnected !== false && s.isInternetReachable !== false;
      setOnline(up);
      if (up) void syncNow();
    });
    const app = AppState.addEventListener('change', (s) => s === 'active' && void syncNow());
    return () => {
      net.remove();
      app.remove();
    };
  }, [userId, syncNow]);

  const ops = useMemo(() => (userId ? queue.list(userId) : []), [userId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = ops.filter((o) => o.status === 'pending' || o.status === 'failed' || o.status === 'syncing').length;
  const problems = ops.filter((o) => o.status === 'rejected' || o.status === 'conflict').length;

  // While something is waiting, try again every minute (the queue itself respects each action's back-off).
  useEffect(() => {
    if (!userId || !waiting || !offlineCapable) return;
    const t = setInterval(() => void syncNow(), 60_000);
    return () => clearInterval(t);
  }, [userId, waiting, syncNow]);

  const value = useMemo<OfflineValue>(
    () => ({
      ops,
      waiting,
      problems,
      online,
      syncing,
      last,
      syncNow,
      retry: async (id, body) => {
        await queue.retry(id, body === undefined ? undefined : { body });
        await syncNow();
      },
      discard: (id) => queue.discard(id),
    }),
    [ops, waiting, problems, online, syncing, last, syncNow],
  );
  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline(): OfflineValue {
  const ctx = useContext(OfflineContext);
  if (!ctx) throw new Error('useOffline must be used inside OfflineProvider');
  return ctx;
}
