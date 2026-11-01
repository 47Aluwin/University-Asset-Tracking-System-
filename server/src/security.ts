import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';

// OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane).
const ARGON_OPTS = { algorithm: 2 /* Argon2id */, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (pw: string) => hash(pw, ARGON_OPTS);

export async function verifyPassword(stored: string | null | undefined, pw: string): Promise<boolean> {
  if (!stored) {
    // Spend comparable time when there is no hash, to avoid revealing which accounts exist.
    await verify(DUMMY_HASH, pw).catch(() => false);
    return false;
  }
  try {
    return await verify(stored, pw);
  } catch {
    return false;
  }
}

// Hash of a random value nobody knows; used only to equalise timing.
const DUMMY_HASH = await hash(randomBytes(24).toString('hex'), ARGON_OPTS);

/** New random token (returned to the client once) and its SHA-256 hash (the only thing stored). */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'Enter a valid email address.' }));

export const PasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters.')
  .max(256, 'Password is too long.');

export function checkPasswordAgainstEmail(password: string, email: string): string | null {
  const local = email.split('@')[0] ?? '';
  if (password.toLowerCase() === email.toLowerCase()) return 'Password must not be your email address.';
  if (local.length >= 4 && password.toLowerCase().includes(local.toLowerCase()))
    return 'Password must not contain your email name.';
  return null;
}

/** Remove secrets from objects before they are written to the audit log. */
export function redact<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/password|token|secret|hash/i.test(k)) continue;
    out[k] = redact(v);
  }
  return out as T;
}
