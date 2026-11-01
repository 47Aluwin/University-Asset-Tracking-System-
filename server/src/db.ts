// Thin database adapter so the same SQL runs on embedded PGlite (dev/test) and PostgreSQL (production).
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Row = Record<string, any>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export interface Db extends Queryable {
  /** Runs fn inside a transaction; rolls back if it throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Runs a script that may contain several statements (no parameters). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  readonly engine: 'pglite' | 'postgres';
  /** The embedded database itself (PGlite only), for backups. */
  readonly raw?: unknown;
}

export async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir) await mkdir(path.dirname(path.resolve(dataDir)), { recursive: true });
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  const wrap = (q: { query: (s: string, p?: unknown[]) => Promise<any> }): Queryable => ({
    async query(sql, params) {
      const r = await q.query(sql, params as any[]);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  });
  const base = wrap(pg);
  return {
    engine: 'pglite',
    raw: pg,
    query: base.query,
    tx: (fn) => pg.transaction((t) => fn(wrap(t))),
    exec: async (sql) => {
      await pg.exec(sql);
    },
    close: () => pg.close(),
  };
}

export async function openPostgres(url: string): Promise<Db> {
  const pgMod = await import('pg');
  const pool = new pgMod.default.Pool({ connectionString: url, max: 10 });
  // numeric and bigint come back as strings from pg; callers cast in SQL where a number is needed.
  return {
    engine: 'postgres',
    async query(sql, params) {
      const r = await pool.query(sql, params as any[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          async query(sql, params) {
            const r = await client.query(sql, params as any[]);
            return { rows: r.rows, rowCount: r.rowCount ?? 0 };
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async exec(sql) {
      // Dedicated connection so a failed multi-statement script can be rolled back on the same session.
      const client = await pool.connect();
      try {
        await client.query(sql);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Applies pending numbered .sql migrations in order. Each migration runs in its own transaction. */
export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Set((await db.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const done: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await db.exec(`BEGIN;\n${sql}\n;INSERT INTO schema_migrations(version) VALUES ('${version}');\nCOMMIT;`).catch(
      async (err) => {
        await db.exec('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${version} failed: ${(err as Error).message}`);
      },
    );
    log(`applied migration ${version}`);
    done.push(version);
  }
  return done;
}

/** Migrations present in the code but not yet applied to this database (should be none in a healthy deployment). */
export async function pendingMigrations(db: Db): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d+_.*\.sql$/.test(f)).map((f) => f.replace(/\.sql$/, ''));
  const applied = new Set((await db.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  return files.filter((f) => !applied.has(f)).sort();
}

export async function openDb(cfg: { databaseUrl?: string; pgliteDataDir?: string }): Promise<Db> {
  return cfg.databaseUrl ? openPostgres(cfg.databaseUrl) : openPglite(cfg.pgliteDataDir);
}
