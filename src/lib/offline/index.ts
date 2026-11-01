// Offline fieldwork for the app. Every write from a fieldwork screen goes through perform():
//  - online: it is sent at once and the screen gets the server's reply, exactly as before;
//  - offline (phones): it is saved on the device and sent later by the queue, with the same operation id;
//  - offline (web): the web app is online-only, so the action is not kept and the user is told.
// Reads use the last copy saved on the phone when there is no connection (see setReadCache in api.ts).
import {
  NetworkError,
  OfflineQueue,
  type NewOp,
  type QueuedOp,
  type SendRequest,
  type SendResult,
} from '@shared/offline-queue';

import { API_URL, ApiError, api, getApiToken, newOperationId, setReadCache } from '../api';
import type { Asset, Me } from '../types';
import { dropFile, keepFile, kv, persistent, queueStore } from './storage';

export { persistent as offlineCapable };
export type { QueuedOp };

// ---------------------------------------------------------------- sending

async function send(r: SendRequest): Promise<SendResult> {
  const token = getApiToken();
  if (!token) return { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Sign in required.' } } };
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'X-Operation-Id': r.operationId };
  let body: BodyInit | undefined;
  if (r.file) {
    const form = new FormData();
    if (persistent) form.append('file', { uri: r.file.uri, name: r.file.name, type: r.file.type } as unknown as Blob);
    else form.append('file', await (await fetch(r.file.uri)).blob(), r.file.name);
    if (r.file.sha256) headers['X-Content-SHA256'] = r.file.sha256;
    body = form;
  } else if (r.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(r.body);
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}${r.path}`, { method: r.method, headers, body });
  } catch {
    throw new NetworkError();
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

export const queue = new OfflineQueue(queueStore, send, { newId: newOperationId });
let ready: Promise<void> | null = null;
export const queueReady = () => (ready ??= queue.init());

// Photos are deleted from the phone once the server has them.
queue.subscribe(() => {
  for (const op of queue.list()) if (op.status === 'synced' && op.file) dropFile(op.file.uri);
});

// ---------------------------------------------------------------- performing actions

export type Action = NewOp & { id: string };

/** Gives an action its operation id up front, so later actions can refer to its result: {{op:<id>.field}}. */
export const action = (a: NewOp): Action => ({ ...a, id: a.id ?? newOperationId() });

export type Performed =
  | { status: 'done'; result: any; ops: QueuedOp[] }
  | { status: 'saved'; ops: QueuedOp[] }
  | { status: 'conflict'; ops: QueuedOp[] };

/**
 * Sends a group of related actions (e.g. a damage report and its photos). The first is the main one: if the
 * server refuses it, nothing is kept and the error is thrown, as an online form would. Extra photos that fail
 * stay in the queue, where they can be retried.
 */
export async function perform(userId: string, actions: Action[]): Promise<Performed> {
  await queueReady();
  for (const a of actions) {
    const file = a.file ? { ...a.file, uri: keepFile(a.file.uri, `${a.id}-${a.file.name}`) } : undefined;
    await queue.enqueue(userId, { ...a, file });
  }
  const main = actions[0].id;
  await queue.sync(userId);
  // A sync already running when these were added may have missed them: run once more.
  if (queue.get(main)?.status === 'pending' && !queue.get(main)?.lastError) await queue.sync(userId);
  const ops = actions.map((a) => queue.get(a.id)).filter((o): o is QueuedOp => !!o);
  const first = queue.get(main)!;

  if (first.status === 'synced') return { status: 'done', result: first.result, ops };
  if (first.status === 'conflict') return { status: 'conflict', ops };
  if (first.status === 'rejected' || !persistent) {
    const err = first.lastError;
    const details = (first.result as any)?.error?.details;
    await queue.discard(main); // also removes the actions that depended on it
    throw err?.code === 'NETWORK' || !err
      ? new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.')
      : new ApiError(err.status ?? 400, err.code, err.message, details);
  }
  return { status: 'saved', ops };
}

// ---------------------------------------------------------------- reading while offline

/** Answers GET requests from the last saved copy when the server cannot be reached (phones only). */
const CACHEABLE = [/^\/auth\/me$/, /^\/assets\/[0-9a-f-]{36}$/, /^\/locations(\?.*)?$/, /^\/departments$/, /^\/categories$/, /^\/label-template$/];

if (persistent) {
  setReadCache({
    async get(path) {
      const lookup = /^\/assets\/lookup\?code=([^&]+)$/.exec(path);
      if (lookup) {
        // Offline scan: find the asset by the ID in its code, among assets saved on this phone.
        const code = decodeURIComponent(lookup[1]).replace(/^UATS:/, '').trim().toUpperCase();
        const id = await kv.get<string>(`asset-code:${code}`);
        return id ? kv.get(`GET ${`/assets/${id}`}`) : undefined;
      }
      return CACHEABLE.some((re) => re.test(path)) ? kv.get(`GET ${path}`) : undefined;
    },
    async put(path, data) {
      if (!CACHEABLE.some((re) => re.test(path))) return;
      await kv.set(`GET ${path}`, data);
      if (/^\/assets\/[0-9a-f-]{36}$/.test(path)) await kv.set(`asset-code:${(data as Asset).institutionalId}`, (data as Asset).id);
    },
  });
}

/** Saves the user's assets and reference lists on the phone so fieldwork can continue without a connection. */
export async function prefetchForOffline() {
  if (!persistent) return;
  const last = await kv.get<number>('prefetched-at');
  if (last && Date.now() - last < 6 * 3600_000) return;
  await Promise.all(['/departments', '/categories', '/locations', '/label-template'].map((p) => api(p).catch(() => null)));
  for (let page = 1; page <= 10; page++) {
    const r = await api<{ items: Asset[]; total: number; pageSize: number }>('/assets', { query: { pageSize: 100, page } }).catch(() => null);
    if (!r) return;
    for (const a of r.items) {
      await kv.set(`GET /assets/${a.id}`, a);
      await kv.set(`asset-code:${a.institutionalId}`, a.id);
    }
    if (page * r.pageSize >= r.total) break;
  }
  await kv.set('prefetched-at', Date.now());
}

// ---------------------------------------------------------------- signed-in user while offline

export const saveSignedInUser = (user: Me) => (persistent ? kv.set('me', user) : Promise.resolve());
export const savedSignedInUser = () => (persistent ? kv.get<Me>('me') : Promise.resolve(undefined));

/** Sign-out: removes this user's saved actions, photos and cached data from the phone. */
export async function clearOfflineData(userId: string) {
  await queueReady();
  for (const op of queue.list(userId)) if (op.file) dropFile(op.file.uri);
  await queue.clearUser(userId);
  await kv.clear();
}

// ---------------------------------------------------------------- reserved asset IDs

type Reserved = { institutionalId: string; expiresAt: string };
const BLOCK_SIZE = 20;
const REFILL_BELOW = 5;

async function deviceId() {
  let id = await kv.get<string>('device-id');
  if (!id) {
    id = newOperationId();
    await kv.set('device-id', id);
  }
  return id;
}

const usable = (r: Reserved) => Date.parse(r.expiresAt) > Date.now() + 86400_000; // stop a day before expiry

/** Keeps a small block of asset IDs reserved on this phone for registering assets offline. */
export async function topUpReservedIds(userId: string) {
  if (!persistent) return;
  const key = `reserved-ids:${userId}`;
  let ids = ((await kv.get<Reserved[]>(key)) ?? []).filter(usable);
  if (ids.length >= REFILL_BELOW) return kv.set(key, ids);
  try {
    // Pick up IDs this person reserved earlier (e.g. before reinstalling), then reserve more.
    const mine = (await api<{ items: Reserved[] }>('/assets/id-blocks')).items.filter(usable);
    const known = new Set(ids.map((r) => r.institutionalId));
    const used = new Set((await kv.get<string[]>(`used-ids:${userId}`)) ?? []);
    ids = [...ids, ...mine.filter((r) => !known.has(r.institutionalId) && !used.has(r.institutionalId))];
    if (ids.length < REFILL_BELOW) {
      const r = await api<{ ids: string[]; expiresAt: string }>('/assets/id-blocks', { body: { deviceId: await deviceId(), count: BLOCK_SIZE } });
      ids = [...ids, ...r.ids.map((institutionalId) => ({ institutionalId, expiresAt: r.expiresAt }))];
    }
  } catch {
    // Offline or not allowed to register: keep what we have.
  }
  await kv.set(key, ids);
}

/** Takes the next reserved ID for an offline registration, or null if none is left. */
export async function takeReservedId(userId: string): Promise<string | null> {
  if (!persistent) return null;
  const key = `reserved-ids:${userId}`;
  const ids = ((await kv.get<Reserved[]>(key)) ?? []).filter(usable);
  const next = ids.shift();
  await kv.set(key, ids);
  if (next) await kv.set(`used-ids:${userId}`, [...((await kv.get<string[]>(`used-ids:${userId}`)) ?? []), next.institutionalId].slice(-200));
  return next?.institutionalId ?? null;
}

export const reservedIdCount = async (userId: string) => ((await kv.get<Reserved[]>(`reserved-ids:${userId}`)) ?? []).filter(usable).length;

/** Puts back an ID whose registration the server refused (e.g. a form error), so it is not wasted. */
export async function returnReservedId(userId: string, institutionalId: string) {
  if (!persistent) return;
  const key = `reserved-ids:${userId}`;
  const ids = (await kv.get<Reserved[]>(key)) ?? [];
  await kv.set(key, [{ institutionalId, expiresAt: new Date(Date.now() + 2 * 86400_000).toISOString() }, ...ids]);
  await kv.set(`used-ids:${userId}`, ((await kv.get<string[]>(`used-ids:${userId}`)) ?? []).filter((x) => x !== institutionalId));
}
