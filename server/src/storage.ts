// File storage for attachments. Files are stored under random keys, never under user-supplied names,
// and are only ever served through the API after a permission check.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

export interface FileStore {
  /** Saves bytes and returns the storage key. */
  put(data: Buffer, extension: string): Promise<string>;
  open(key: string): Readable;
}

/** Local disk (development and single-server deployments). Production may swap in S3-compatible storage. */
export class LocalFileStore implements FileStore {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = path.resolve(dir);
  }
  async put(data: Buffer, extension: string) {
    const now = new Date();
    const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomBytes(16).toString('hex')}.${extension}`;
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data, { flag: 'wx' }); // never overwrite
    return key;
  }
  open(key: string) {
    return createReadStream(this.resolve(key));
  }
  private resolve(key: string) {
    if (!/^\d{4}\/\d{2}\/[0-9a-f]{32}\.(jpg|png|webp|pdf)$/.test(key)) throw new Error('Invalid storage key.');
    return path.join(this.dir, key);
  }
}

/**
 * Identifies the real file type from its first bytes (never trusts the name or declared type).
 * Only the formats the system accepts are recognised.
 */
export function sniffFileType(data: Buffer): { contentType: string; extension: string } | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { contentType: 'image/jpeg', extension: 'jpg' };
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: 'image/png', extension: 'png' };
  }
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  if (data.length >= 5 && data.toString('ascii', 0, 5) === '%PDF-') return { contentType: 'application/pdf', extension: 'pdf' };
  return null;
}

export const sha256Hex = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Keeps a readable, harmless version of the uploaded file name for display only. */
export function cleanFileName(name: string | undefined, extension: string): string {
  const base = (name ?? '')
    .replace(/\.[^.]*$/, '')
    .normalize('NFKD')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .slice(0, 80);
  return `${base || 'file'}.${extension}`;
}
