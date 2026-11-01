import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { api, ApiError, setApiToken, setUnauthorizedHandler } from './api';
import { clearOfflineData, saveSignedInUser, savedSignedInUser } from './offline';
import { tokenStore } from './token-store';
import type { Me } from './types';

type SessionValue = {
  user: Me | null;
  isLoading: boolean;
  /** Started without a connection, using the account details saved on this phone. */
  startedOffline: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  /** UI hint only: does the user hold this permission (optionally for a department)? */
  can: (permission: string, departmentId?: string) => boolean;
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [startedOffline, setStartedOffline] = useState(false);

  const clear = useCallback(async () => {
    setApiToken(null);
    setUser(null);
    await tokenStore.clear().catch(() => {});
  }, []);

  // Restore a saved session on start.
  useEffect(() => {
    setUnauthorizedHandler(() => void clear());
    (async () => {
      try {
        const token = await tokenStore.get();
        if (token) {
          setApiToken(token);
          const r = await api<{ user: Me }>('/auth/me', { noAuthRedirect: true });
          setUser(r.user);
          void saveSignedInUser(r.user);
        }
      } catch (e) {
        // Expired/revoked session: forget it. No connection: on a phone, continue with the account details
        // saved at the last sign-in, so fieldwork can be saved offline. The server checks the sign-in again
        // before it accepts anything saved meanwhile.
        if (e instanceof ApiError && e.status === 401) await clear();
        else {
          const saved = await savedSignedInUser().catch(() => undefined);
          if (saved) {
            setUser(saved);
            setStartedOffline(true);
          } else setApiToken(null);
        }
      } finally {
        setLoading(false);
      }
    })();
    return () => setUnauthorizedHandler(null);
  }, [clear]);

  const signIn = useCallback(async (email: string, password: string) => {
    const r = await api<{ token: string; user: Me }>('/auth/login', {
      body: { email, password, client: Platform.OS === 'web' ? 'web' : 'mobile' },
      noAuthRedirect: true,
    });
    await tokenStore.set(r.token);
    setApiToken(r.token);
    setUser(r.user);
    setStartedOffline(false);
    void saveSignedInUser(r.user);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST', noAuthRedirect: true });
    } catch {
      // Sign out locally even if the server cannot be reached.
    }
    // Removes this person's saved actions, photos and cached data from the phone (the screen warns first).
    if (user) await clearOfflineData(user.id).catch(() => {});
    await clear();
  }, [clear, user]);

  const refresh = useCallback(async () => {
    const r = await api<{ user: Me }>('/auth/me');
    setUser(r.user);
    setStartedOffline(false);
    void saveSignedInUser(r.user);
  }, []);

  const can = useCallback(
    (permission: string, departmentId?: string) => {
      const scope = user?.permissions[permission];
      if (!scope) return false;
      if (scope === 'all' || departmentId === undefined) return true;
      return scope.includes(departmentId);
    },
    [user],
  );

  const value = useMemo(
    () => ({ user, isLoading, startedOffline, signIn, signOut, refresh, can }),
    [user, isLoading, startedOffline, signIn, signOut, refresh, can],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
