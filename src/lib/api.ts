// HTTP client for the ATS API. All authorisation happens on the server; this only attaches the token.

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1').replace(/\/$/, '');

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  /** Field-level messages from server validation, keyed by field path. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) {
      for (const d of this.details as { path?: string; message?: string }[]) {
        if (d.path && d.message && !out[d.path]) out[d.path] = d.message;
      }
    }
    return out;
  }
}

let currentToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setApiToken(token: string | null) {
  currentToken = token;
}
/** For components that must send the token themselves (e.g. loading a private image). */
export const getApiToken = () => currentToken;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

/** Phones: GET replies are saved, and the saved copy is used when the server cannot be reached. */
type ReadCache = { get(path: string): Promise<unknown>; put(path: string, data: unknown): Promise<void> };
let readCache: ReadCache | null = null;
export function setReadCache(c: ReadCache | null) {
  readCache = c;
}
/** Set when the last reply came from the phone's saved copy (the screen can say so). */
export let lastReadWasOffline = false;

type Options = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Skip the global sign-out on 401 (used by the sign-in call itself). */
  noAuthRedirect?: boolean;
  headers?: Record<string, string>;
};

/**
 * Random UUID used as an operation id, so a retried submission is processed only once by the server.
 * It is an identifier, not a secret, so a non-cryptographic fallback is acceptable where crypto is missing.
 */
export function newOperationId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function api<T = any>(path: string, opts: Options = {}): Promise<T> {
  const qs = opts.query
    ? '?' +
      Object.entries(opts.query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (currentToken) headers.Authorization = `Bearer ${currentToken}`;
  Object.assign(headers, opts.headers);

  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const fullPath = `${path}${qs === '?' ? '' : qs}`;
  let res: Response;
  try {
    res = await fetch(`${API_URL}${fullPath}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    if (method === 'GET' && readCache) {
      const saved = await readCache.get(fullPath).catch(() => undefined);
      if (saved !== undefined) {
        lastReadWasOffline = true;
        return saved as T;
      }
    }
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.');
  }

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && !opts.noAuthRedirect) onUnauthorized?.();
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'HTTP_' + res.status, e?.message ?? `Request failed (${res.status}).`, e?.details);
  }
  if (method === 'GET') {
    lastReadWasOffline = false;
    if (readCache) void readCache.put(fullPath, data).catch(() => {});
  }
  return data as T;
}

export const errorMessage = (e: unknown) =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong.';

/** A picked photo or document, from the camera, photo library or browser file input. */
export type UploadFile = { uri: string; name: string; type: string; file?: File | Blob };

/** Uploads one file as multipart/form-data. On phones React Native reads the file from its uri. */
export async function uploadFile<T = any>(path: string, f: UploadFile): Promise<T> {
  const form = new FormData();
  if (f.file) form.append('file', f.file, f.name);
  else form.append('file', { uri: f.uri, name: f.name, type: f.type } as unknown as Blob);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: currentToken ? { Authorization: `Bearer ${currentToken}` } : {},
      body: form,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    throw new ApiError(res.status, data?.error?.code ?? 'HTTP_' + res.status, data?.error?.message ?? `Upload failed (${res.status}).`, data?.error?.details);
  }
  return data as T;
}
