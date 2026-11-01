// iOS / Android: actions and reference data saved on the device in SQLite (ats-local.db), so they survive
// the app being closed or the phone restarting. Photos waiting to upload are copied into the app's private
// documents folder, because the photo picker's own cache can be cleared by the system.
import { Directory, File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';

import type { QueuedOp, QueueStore } from '@shared/offline-queue';

/** True where saved actions survive a restart (phones). */
export const persistent = true;

let opened: Promise<SQLite.SQLiteDatabase> | null = null;
function db() {
  opened ??= (async () => {
    const d = await SQLite.openDatabaseAsync('ats-local.db');
    await d.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS pending_ops (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    `);
    return d;
  })();
  return opened;
}

export const queueStore: QueueStore = {
  async load() {
    const rows = await (await db()).getAllAsync<{ json: string }>('SELECT json FROM pending_ops');
    return rows.map((r) => JSON.parse(r.json) as QueuedOp);
  },
  async save(op) {
    await (await db()).runAsync('INSERT OR REPLACE INTO pending_ops (id, user_id, json) VALUES (?, ?, ?)', op.id, op.userId, JSON.stringify(op));
  },
  async remove(id) {
    await (await db()).runAsync('DELETE FROM pending_ops WHERE id = ?', id);
  },
};

export const kv = {
  async get<T>(key: string): Promise<T | undefined> {
    const r = await (await db()).getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
    return r ? (JSON.parse(r.value) as T) : undefined;
  },
  async set(key: string, value: unknown) {
    await (await db()).runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, JSON.stringify(value));
  },
  async remove(key: string) {
    await (await db()).runAsync('DELETE FROM kv WHERE key = ?', key);
  },
  async clear() {
    await (await db()).runAsync('DELETE FROM kv WHERE key <> ?', 'device-id');
  },
};

const photoDir = () => new Directory(Paths.document, 'pending-photos');

/** Copies a picked photo somewhere the system will not clear before it is uploaded. Returns the new uri. */
export function keepFile(uri: string, name: string): string {
  const dir = photoDir();
  if (!dir.exists) dir.create({ intermediates: true });
  const dest = new File(dir, name);
  if (dest.exists) dest.delete();
  new File(uri).copy(dest);
  return dest.uri;
}

/** Deletes a kept photo once the server has it. Only files in our own folder are ever deleted. */
export function dropFile(uri: string) {
  try {
    const f = new File(uri);
    if (f.uri.includes('/pending-photos/') && f.exists) f.delete();
  } catch {
    // Already gone: nothing to do.
  }
}
