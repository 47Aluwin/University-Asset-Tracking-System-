// Offline queue for fieldwork done without a connection (Phase 6).
//
// Each action is saved on the device first, with an operation id it keeps forever and the time it happened.
// When a connection is available the queue sends actions to the normal API endpoints, oldest first. The server
// processes each operation id once, so an action that is sent twice (e.g. the reply was lost) is recorded once.
//
// Storage and network are supplied by the caller, so the same code runs in the app (SQLite + fetch) and in
// tests (memory or file storage + the real API).

export type OpStatus = 'pending' | 'syncing' | 'synced' | 'failed' | 'rejected' | 'conflict';

export type QueuedFile = { uri: string; name: string; type: string; sha256?: string };

export type QueuedOp = {
  /** Operation id (UUID), sent as X-Operation-Id on every attempt. */
  id: string;
  /** Who created it; only that user's token is ever used to send it. */
  userId: string;
  kind: string;
  /** Plain-language description shown in the app, e.g. "Verify UAT-2026-000123". */
  label: string;
  method: 'POST' | 'PATCH';
  /** API path. May contain {{op:<id>.<field>}} to use a value from an earlier action's server reply. */
  path: string;
  body?: unknown;
  file?: QueuedFile;
  dependsOn?: string[];
  /** When it happened, by the device clock (ISO). Sent in the body as eventTime where the endpoint takes one. */
  eventTime: string;
  createdAt: string;
  status: OpStatus;
  attempts: number;
  nextAttemptAt?: string;
  lastError?: { code: string; message: string; status?: number };
  /** The server's reply once synced (or its conflict reply). */
  result?: unknown;
  syncedAt?: string;
  /** Groups actions about the same asset (server id or a local reference). */
  assetRef?: string;
};

export interface QueueStore {
  load(): Promise<QueuedOp[]>;
  save(op: QueuedOp): Promise<void>;
  remove(id: string): Promise<void>;
}

export type SendRequest = { method: 'POST' | 'PATCH'; path: string; body?: unknown; file?: QueuedFile; operationId: string };
export type SendResult = { status: number; body: any };
/** Sends one request. Must throw NetworkError when the server could not be reached. */
export type Transport = (r: SendRequest) => Promise<SendResult>;

export class NetworkError extends Error {
  constructor(message = 'No connection to the server.') {
    super(message);
    this.name = 'NetworkError';
  }
}

export type SyncSummary = { synced: number; failed: number; rejected: number; conflicts: number; remaining: number; offline: boolean; signInNeeded: boolean };

const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 60 * 60_000;
/** Back-off before retry n: 15 s, 30 s, 1 min … capped at 1 hour. */
export const retryDelay = (attempts: number) => Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);

const PLACEHOLDER = /\{\{op:([0-9a-f-]{36})\.([A-Za-z0-9_.]+)\}\}/g;

function pick(obj: unknown, path: string): unknown {
  return path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
}

export type NewOp = Pick<QueuedOp, 'kind' | 'label' | 'method' | 'path'> &
  Partial<Pick<QueuedOp, 'body' | 'file' | 'dependsOn' | 'assetRef' | 'eventTime' | 'id'>>;

export class OfflineQueue {
  private ops = new Map<string, QueuedOp>();
  private listeners = new Set<() => void>();
  private running: Promise<SyncSummary> | null = null;
  private loaded = false;

  private store: QueueStore;
  private transport: Transport;
  private opts: { newId: () => string; now?: () => number };

  constructor(store: QueueStore, transport: Transport, opts: { newId: () => string; now?: () => number }) {
    this.store = store;
    this.transport = transport;
    this.opts = opts;
  }

  private now() {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Loads saved actions. Anything left "syncing" when the app was closed goes back to waiting. */
  async init() {
    if (this.loaded) return;
    for (const op of await this.store.load()) {
      if (op.status === 'syncing') op.status = 'pending';
      this.ops.set(op.id, op);
    }
    this.loaded = true;
    this.emit();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  list(userId?: string): QueuedOp[] {
    return [...this.ops.values()].filter((o) => !userId || o.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  get(id: string) {
    return this.ops.get(id);
  }
  /** Actions not yet accepted by the server (waiting, failed, rejected or in conflict). */
  unsynced(userId?: string) {
    return this.list(userId).filter((o) => o.status !== 'synced');
  }

  private async put(op: QueuedOp) {
    this.ops.set(op.id, op);
    await this.store.save(op);
    this.emit();
  }

  async enqueue(userId: string, n: NewOp): Promise<QueuedOp> {
    const now = new Date(this.now()).toISOString();
    const op: QueuedOp = {
      id: n.id ?? this.opts.newId(),
      userId,
      kind: n.kind,
      label: n.label,
      method: n.method,
      path: n.path,
      body: n.body,
      file: n.file,
      dependsOn: n.dependsOn,
      assetRef: n.assetRef,
      eventTime: n.eventTime ?? now,
      createdAt: now,
      status: 'pending',
      attempts: 0,
    };
    await this.put(op);
    return op;
  }

  /** Sends waiting actions for this user. Only one sync runs at a time; extra calls share the running one. */
  sync(userId: string): Promise<SyncSummary> {
    if (!this.running) this.running = this.run(userId).finally(() => (this.running = null));
    return this.running;
  }

  private resolve<T>(value: T): T {
    const sub = (s: string) =>
      s.replace(PLACEHOLDER, (_m, id: string, field: string) => {
        const v = pick(this.ops.get(id)?.result, field);
        if (v === undefined || v === null) throw new Error(`Missing value ${field} from an earlier action.`);
        return String(v);
      });
    const walk = (v: unknown): unknown =>
      typeof v === 'string' ? sub(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
    return walk(value) as T;
  }

  private async run(userId: string): Promise<SyncSummary> {
    const sum: SyncSummary = { synced: 0, failed: 0, rejected: 0, conflicts: 0, remaining: 0, offline: false, signInNeeded: false };
    let progressed = true;
    // Repeat passes so an action whose dependency synced in this run is sent in the same run.
    while (progressed && !sum.offline && !sum.signInNeeded) {
      progressed = false;
      for (const op of this.list(userId)) {
        if (op.status !== 'pending' && op.status !== 'failed') continue;
        if (op.nextAttemptAt && Date.parse(op.nextAttemptAt) > this.now()) continue;
        const deps = (op.dependsOn ?? []).map((d) => this.ops.get(d));
        const blocked = deps.find((d) => !d || d.status === 'rejected' || d.status === 'conflict');
        if (blocked !== undefined) {
          await this.put({
            ...op,
            status: 'rejected',
            lastError: { code: 'DEPENDENCY_FAILED', message: `Depends on "${blocked?.label ?? 'an earlier action'}", which was not accepted.` },
          });
          sum.rejected++;
          progressed = true;
          continue;
        }
        if (deps.some((d) => d!.status !== 'synced')) continue; // wait for the earlier action

        let req: SendRequest;
        try {
          req = { method: op.method, path: this.resolve(op.path), body: this.resolve(op.body), file: op.file, operationId: op.id };
        } catch (e) {
          await this.put({ ...op, status: 'rejected', lastError: { code: 'DEPENDENCY_FAILED', message: (e as Error).message } });
          sum.rejected++;
          continue;
        }
        await this.put({ ...op, status: 'syncing' });
        let res: SendResult;
        try {
          res = await this.transport(req);
        } catch (e) {
          // No connection (or the reply was lost): keep waiting; the same operation id makes the resend safe.
          const offline = e instanceof NetworkError;
          await this.put({
            ...op,
            status: 'pending',
            attempts: op.attempts + (offline ? 0 : 1),
            nextAttemptAt: offline ? undefined : new Date(this.now() + retryDelay(op.attempts + 1)).toISOString(),
            lastError: { code: offline ? 'NETWORK' : 'SEND_FAILED', message: (e as Error).message },
          });
          if (offline) sum.offline = true;
          break;
        }
        const code: string = res.body?.error?.code ?? `HTTP_${res.status}`;
        const message: string = res.body?.error?.message ?? `The server replied ${res.status}.`;
        if (res.status >= 200 && res.status < 300) {
          await this.put({ ...op, status: 'synced', result: res.body, syncedAt: new Date(this.now()).toISOString(), lastError: undefined, attempts: op.attempts + 1 });
          sum.synced++;
          progressed = true;
        } else if (res.status === 409 && code === 'SYNC_CONFLICT') {
          await this.put({ ...op, status: 'conflict', result: res.body, lastError: { code, message, status: 409 }, attempts: op.attempts + 1 });
          sum.conflicts++;
        } else if (res.status === 401) {
          await this.put({ ...op, status: 'pending', lastError: { code, message: 'Sign in again to send this.', status: 401 } });
          sum.signInNeeded = true;
          break;
        } else if (res.status === 408 || res.status === 429 || res.status >= 500) {
          const attempts = op.attempts + 1;
          await this.put({ ...op, status: 'failed', attempts, nextAttemptAt: new Date(this.now() + retryDelay(attempts)).toISOString(), lastError: { code, message, status: res.status } });
          sum.failed++;
        } else {
          // Refused by the server's rules (e.g. validation, permissions): not retried automatically.
          await this.put({ ...op, status: 'rejected', lastError: { code, message, status: res.status }, attempts: op.attempts + 1, result: res.body });
          sum.rejected++;
          progressed = true;
        }
      }
    }
    sum.remaining = this.list(userId).filter((o) => o.status === 'pending' || o.status === 'failed').length;
    return sum;
  }

  /** Send a failed or rejected action again (e.g. after fixing the cause). */
  async retry(id: string, changes?: { body?: unknown }) {
    const op = this.ops.get(id);
    if (!op || op.status === 'synced' || op.status === 'syncing') return;
    await this.put({ ...op, ...(changes ?? {}), status: 'pending', nextAttemptAt: undefined, lastError: undefined });
  }

  /** Removes an action that has not been accepted by the server. Actions depending on it are removed too. */
  async discard(id: string) {
    const op = this.ops.get(id);
    if (!op || op.status === 'synced' || op.status === 'syncing') return;
    for (const d of this.list().filter((o) => o.dependsOn?.includes(id))) await this.discard(d.id);
    this.ops.delete(id);
    await this.store.remove(id);
    this.emit();
  }

  /** Forget synced actions older than `ms` (their results are on the server). */
  async pruneSynced(ms: number) {
    const cutoff = this.now() - ms;
    for (const op of this.list()) {
      if (op.status === 'synced' && op.syncedAt && Date.parse(op.syncedAt) < cutoff && !this.list().some((o) => o.status !== 'synced' && o.dependsOn?.includes(op.id))) {
        this.ops.delete(op.id);
        await this.store.remove(op.id);
      }
    }
    this.emit();
  }

  /** Removes everything for a user (sign-out after the user agreed to lose unsynced work). */
  async clearUser(userId: string) {
    for (const op of this.list(userId)) {
      this.ops.delete(op.id);
      await this.store.remove(op.id);
    }
    this.emit();
  }
}

/** Simple in-memory store (tests, and the web app, which works online only). */
export class MemoryStore implements QueueStore {
  rows = new Map<string, QueuedOp>();
  async load() {
    return [...this.rows.values()].map((o) => structuredClone(o));
  }
  async save(op: QueuedOp) {
    this.rows.set(op.id, structuredClone(op));
  }
  async remove(id: string) {
    this.rows.delete(id);
  }
}
