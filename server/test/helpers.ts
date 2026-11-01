import type { Assistant } from '../src/assistant.ts';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { migrate, openPglite, openPostgres, type Db } from '../src/db.ts';
import { MemoryMailer } from '../src/mailer.ts';
import { LocalFileStore } from '../src/storage.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashPassword } from '../src/security.ts';

export const PASSWORD = 'Correct-Horse-Battery-9';

export type TestCtx = {
  app: FastifyInstance;
  db: Db;
  mailer: MemoryMailer;
  /** Where this test's uploaded files are stored. */
  uploadDir: string;
  close: () => Promise<void>;
};

/**
 * Fresh in-memory PostgreSQL (PGlite) database with all migrations applied.
 * With TEST_DB=pg-wire the same tests run through the production `pg` driver (connection pool, wire protocol,
 * type parsing) against PGlite exposed on a local socket — see docs/testing.md for what this does and does not prove.
 */
async function openTestDb(): Promise<{ db: Db; stop: () => Promise<void> }> {
  if (process.env.TEST_DB !== 'pg-wire' && process.env.npm_lifecycle_event !== 'test:pg-wire') {
    const db = await openPglite();
    return { db, stop: async () => {} };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const lite = new PGlite();
  await lite.waitReady;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = new PGLiteSocketServer({ db: lite, port, host: '127.0.0.1', maxConnections: 20 });
  await server.start();
  const db = await openPostgres(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`);
  return {
    db,
    stop: async () => {
      await server.stop();
      await lite.close();
    },
  };
}

export async function setup(opts: { rateLimit?: boolean; env?: Record<string, string>; assistant?: Assistant | null } = {}): Promise<TestCtx> {
  const { db, stop } = await openTestDb();
  await migrate(db);
  const config = loadConfig({
    NODE_ENV: 'test',
    RATE_LIMIT_ENABLED: opts.rateLimit ? 'true' : 'false',
    PUBLIC_APP_URL: 'http://app.test',
    ...opts.env,
  });
  const mailer = new MemoryMailer();
  // Each test file gets its own throw-away upload folder in the OS temp directory.
  const uploadDir = mkdtempSync(path.join(tmpdir(), 'uats-uploads-'));
  const store = new LocalFileStore(uploadDir);
  const app = await buildApp({ db, config: { ...config, uploadDir }, mailer, store, assistant: opts.assistant ?? null });
  return {
    app,
    db,
    mailer,
    uploadDir,
    close: async () => {
      await app.close();
      await db.close();
      await stop();
      rmSync(uploadDir, { recursive: true, force: true });
    },
  };
}

export async function createDepartment(db: Db, code: string, currency = 'USD'): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO departments (code, name, default_currency) VALUES ($1, $2, $3) RETURNING id`,
    [code, `Test department ${code}`, currency],
  );
  return rows[0].id;
}

/** Inserts a user directly (test fixture only) with the shared test password. */
export async function createUser(
  db: Db,
  email: string,
  role: 'SYSTEM_ADMIN' | 'ASSET_MANAGER' | 'DEPARTMENT_STAFF',
  departmentId: string | null = null,
): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO users (email, full_name, password_hash, role, department_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [email, `Test ${role}`, await hashPassword(PASSWORD), role, departmentId],
  );
  return rows[0].id;
}

export async function login(app: FastifyInstance, email: string, password = PASSWORD): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.statusCode} ${res.body}`);
  return res.json().token;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Small request helper: api(app, token)('POST', '/users', body) */
export function api(app: FastifyInstance, token?: string) {
  return async (method: Method, url: string, payload?: unknown) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      payload: payload as any,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    let body: any = undefined;
    try {
      body = res.json();
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, headers: res.headers };
  };
}

export const tokenFromLink = (link: string) => new URL(link).searchParams.get('token')!;
