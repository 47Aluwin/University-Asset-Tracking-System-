// Browser: the web app works online only, so nothing is kept after the page closes.
import { MemoryStore, type QueueStore } from '@shared/offline-queue';

export const persistent = false;
export const queueStore: QueueStore = new MemoryStore();

const mem = new Map<string, string>();
export const kv = {
  async get<T>(key: string): Promise<T | undefined> {
    const v = mem.get(key);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  },
  async set(key: string, value: unknown) {
    mem.set(key, JSON.stringify(value));
  },
  async remove(key: string) {
    mem.delete(key);
  },
  async clear() {
    mem.clear();
  },
};

export const keepFile = (uri: string, _name: string) => uri;
export const dropFile = (_uri: string) => {};
