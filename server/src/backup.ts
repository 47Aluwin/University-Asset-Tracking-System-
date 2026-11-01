// Backups: the database plus the uploaded files, with a manifest (row counts per table and a SHA-256 for every
// file) so a restore can be checked, not just assumed. The database is dumped first and the files copied after,
// because files are always written before the rows that refer to them.
//  - Production (PostgreSQL): `pg_dump --format=custom`, restored with `pg_restore` (see docs/operations.md).
//  - Development (embedded PGlite): pg_dump compiled for PGlite, as plain SQL.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Db } from './db.ts';

export type Manifest = {
  createdAt: string;
  engine: 'pglite' | 'postgres';
  database: string;
  migrations: string[];
  tables: Record<string, number>;
  files: { key: string; size: number; sha256: string }[];
};

export async function tableCounts(db: Db): Promise<Record<string, number>> {
  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.table_name] = Number((await db.query(`SELECT count(*) AS n FROM "${r.table_name}"`)).rows[0].n);
  return out;
}

async function listFiles(dir: string, base = dir): Promise<Manifest['files']> {
  const out: Manifest['files'] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // no uploads yet
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (e.isFile()) {
      const data = await readFile(full);
      out.push({ key: path.relative(base, full).split(path.sep).join('/'), size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function run(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('error', (e) => reject(new Error(`${cmd} could not be started (${e.message}). Install the PostgreSQL client tools.`)));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

/** Writes a backup into `outDir` (which must not exist yet) and returns its manifest. */
export async function backup(opts: { db: Db; uploadDir: string; outDir: string; databaseUrl?: string }): Promise<Manifest> {
  await mkdir(path.dirname(path.resolve(opts.outDir)), { recursive: true });
  await mkdir(opts.outDir, { recursive: false });
  let database: string;
  if (opts.db.engine === 'pglite') {
    // Development-only tool, loaded only here so production installs do not need it.
    const { pgDump } = await import('@electric-sql/pglite-tools');
    const file = await pgDump({ pg: opts.db.raw as any, args: ['--inserts', '--no-owner', '--no-privileges'] });
    database = 'database.sql';
    await writeFile(path.join(opts.outDir, database), await file.text());
  } else {
    if (!opts.databaseUrl) throw new Error('DATABASE_URL is needed to back up PostgreSQL.');
    database = 'database.dump';
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${path.join(opts.outDir, database)}`, opts.databaseUrl]);
  }
  // Counted right after the dump. Take backups in a quiet period, or treat the counts as "at least" (docs/operations.md).
  const tables = await tableCounts(opts.db);
  await cp(opts.uploadDir, path.join(opts.outDir, 'uploads'), { recursive: true }).catch((e) => {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  });
  const files = await listFiles(path.join(opts.outDir, 'uploads'));
  const migrations = (await opts.db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version as string);
  const manifest: Manifest = { createdAt: new Date().toISOString(), engine: opts.db.engine, database, migrations, tables, files };
  await writeFile(path.join(opts.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Development restore: loads a PGlite backup into an empty database and copies the files back. */
export async function restorePglite(backupDir: string, target: Db, uploadDir: string) {
  const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.engine !== 'pglite') throw new Error('This is a PostgreSQL backup: restore it with pg_restore (docs/operations.md).');
  const existing = (await target.query(`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'`)).rows[0].n;
  if (Number(existing) > 0) throw new Error('The target database is not empty. Restore into a new, empty database.');
  await mkdir(uploadDir, { recursive: true });
  if ((await readdir(uploadDir)).length) throw new Error('The target upload folder is not empty. Restore into a new, empty folder.');
  await target.exec(await readFile(path.join(backupDir, manifest.database), 'utf8'));
  // pg_dump scripts empty the session's search_path; the embedded database keeps that one session, so put it back.
  await target.exec('RESET search_path;');
  const from = path.join(backupDir, 'uploads');
  if ((await stat(from).catch(() => null))?.isDirectory()) {
    for (const entry of await readdir(from)) {
      await cp(path.join(from, entry), path.join(uploadDir, entry), { recursive: true, errorOnExist: true, force: false });
    }
  }
  return manifest;
}

/** Checks a restored database and upload folder against the backup's manifest. */
export async function verifyRestore(backupDir: string, db: Db, uploadDir: string): Promise<{ ok: boolean; problems: string[] }> {
  const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8')) as Manifest;
  const problems: string[] = [];
  const counts = await tableCounts(db);
  for (const [t, n] of Object.entries(manifest.tables)) {
    if (counts[t] === undefined) problems.push(`table ${t} is missing`);
    else if (counts[t] !== n) problems.push(`table ${t}: ${counts[t]} rows, backup recorded ${n}`);
  }
  const files = new Map((await listFiles(uploadDir)).map((f) => [f.key, f]));
  for (const f of manifest.files) {
    const got = files.get(f.key);
    if (!got) problems.push(`file ${f.key} is missing`);
    else if (got.sha256 !== f.sha256) problems.push(`file ${f.key} differs from the backup`);
  }
  // Every attachment row must point at a file that exists.
  for (const r of (await db.query('SELECT storage_key FROM attachments')).rows) {
    if (!files.has(r.storage_key)) problems.push(`attachment file ${r.storage_key} is missing`);
  }
  const migrations = (await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);
  if (JSON.stringify(migrations) !== JSON.stringify(manifest.migrations)) problems.push('migration history differs');
  return { ok: problems.length === 0, problems };
}
