// Phase 7: backup and restore, actually performed. Data is created through the API, backed up, restored into a new
// empty database and upload folder, checked against the manifest, and then used by a fresh copy of the app.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildApp } from '../src/app.ts';
import { backup, restorePglite, verifyRestore } from '../src/backup.ts';
import { loadConfig } from '../src/config.ts';
import { openPglite, type Db } from '../src/db.ts';
import { MemoryMailer } from '../src/mailer.ts';
import { LocalFileStore } from '../src/storage.ts';
import { PASSWORD, api, createDepartment, createUser, login, setup, type TestCtx } from './helpers.ts';

let ctx: TestCtx;
let work: string;
let assetId: string;
let institutionalId: string;
let attachmentId: string;
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(randomUUID().repeat(20))]);

before(async () => {
  ctx = await setup();
  work = mkdtempSync(path.join(tmpdir(), 'uats-backup-'));
  const dept = await createDepartment(ctx.db, 'BAK');
  await createUser(ctx.db, 'admin@uni.test', 'SYSTEM_ADMIN');
  await createUser(ctx.db, 'staff@uni.test', 'DEPARTMENT_STAFF', dept);
  const admin = await login(ctx.app, 'admin@uni.test');
  const staff = await login(ctx.app, 'staff@uni.test');
  const cat = (await api(ctx.app, admin)('POST', '/categories', { name: 'Lab equipment' })).body.id;
  const loc = (await api(ctx.app, staff)('POST', '/locations', { departmentId: dept, building: 'Science', room: '1' })).body.id;
  const c = (await api(ctx.app, staff)('POST', '/assets', {
    name: 'Microscope', categoryId: cat, serialNumber: 'SN-1', departmentId: dept, locationId: loc, acquisitionDate: '2025-02-01',
    acquisitionMethod: 'purchase', costStatus: 'recorded', acquisitionCost: '1500.00', currency: 'USD', condition: 'good',
  })).body;
  await api(ctx.app, staff)('POST', `/assets/${c.id}/label-prints`, { layout: 'sheet' });
  await api(ctx.app, staff)('POST', `/assets/${c.id}/confirm-label`, { code: c.qrPayload, method: 'scan' });
  const cond = (await api(ctx.app, staff)('POST', `/assets/${c.id}/condition`, { condition: 'damaged', damageDescription: 'Cracked lens housing' })).body;
  const boundary = '----b' + randomUUID();
  const up = await ctx.app.inject({
    method: 'POST', url: `/api/v1/condition-events/${cond.conditionEventId}/attachments`,
    headers: { authorization: `Bearer ${staff}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="lens.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), PHOTO, Buffer.from(`\r\n--${boundary}--\r\n`)]),
  });
  assert.equal(up.statusCode, 201);
  attachmentId = up.json().id;
  assetId = c.id;
  institutionalId = c.institutionalId;
});
after(async () => {
  await ctx.close();
  rmSync(work, { recursive: true, force: true });
});

// These exercise the embedded-database backup. In pg-wire mode the PostgreSQL path (pg_dump) would be used, and
// pg_dump is not installed here; the production procedure is in docs/operations.md.
const skip = process.env.TEST_DB === 'pg-wire' || process.env.npm_lifecycle_event === 'test:pg-wire' ? 'pg_dump is not available in this environment' : false;

test('a backup restores into an empty database and folder, matches its manifest, and the app works on it', { skip }, async () => {
  const srcUploads = ctx.uploadDir;

  const out = path.join(work, 'backup-1');
  const manifest = await backup({ db: ctx.db, uploadDir: srcUploads, outDir: out });
  assert.equal(manifest.engine, 'pglite');
  assert.equal(manifest.tables.assets, 1);
  assert.ok(manifest.tables.audit_events > 5);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.migrations.length, 8);
  await assert.rejects(backup({ db: ctx.db, uploadDir: srcUploads, outDir: out }), /EEXIST/, 'never overwrites an earlier backup');

  // Restore into a brand-new database and upload folder.
  const restored: Db = await openPglite();
  const newUploads = path.join(work, 'restored-uploads');
  await restorePglite(out, restored, newUploads);
  const check = await verifyRestore(out, restored, newUploads);
  assert.deepEqual(check, { ok: true, problems: [] });
  await assert.rejects(restorePglite(out, restored, path.join(work, 'again')), /not empty/, 'refuses to restore over data');

  // A fresh copy of the app on the restored data.
  const app = await buildApp({
    db: restored,
    config: { ...loadConfig({ NODE_ENV: 'test', RATE_LIMIT_ENABLED: 'false', PUBLIC_APP_URL: 'http://app.test' }), uploadDir: newUploads },
    mailer: new MemoryMailer(),
    store: new LocalFileStore(newUploads),
  });
  try {
    const token = await login(app, 'staff@uni.test', PASSWORD); // password hashes came back too
    const a = await api(app, token)('GET', `/assets/${assetId}`);
    assert.equal(a.body.institutionalId, institutionalId);
    assert.equal(a.body.condition, 'damaged');
    const file = await app.inject({ method: 'GET', url: `/api/v1/attachments/${attachmentId}`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(file.statusCode, 200);
    assert.equal(createHash('sha256').update(file.rawPayload).digest('hex'), createHash('sha256').update(PHOTO).digest('hex'), 'photo is byte-identical');
    await assert.rejects(restored.query(`DELETE FROM audit_events`), /append-only|not allowed|denied/i, 'audit log protection restored');
    // The ID counter came back too: a new asset gets the next number, never a reused one.
    const adminT = await login(app, 'admin@uni.test');
    const next = await api(app, adminT)('POST', '/assets', {
      ...{ name: 'Second', serialNumber: 'SN-2', acquisitionDate: '2025-02-01', acquisitionMethod: 'purchase', costStatus: 'recorded', acquisitionCost: '10.00', currency: 'USD', condition: 'good' },
      categoryId: a.body.category.id, departmentId: a.body.department.id, locationId: a.body.location.id,
    });
    assert.equal(next.status, 201, JSON.stringify(next.body));
    assert.ok(next.body.institutionalId > institutionalId);
  } finally {
    await app.close();
    await restored.close();
  }
});

test('verification catches a restore that is missing a file', { skip }, async () => {
  const key = (await ctx.db.query('SELECT storage_key FROM attachments WHERE id = $1', [attachmentId])).rows[0].storage_key;
  const out = path.join(work, 'backup-2');
  await backup({ db: ctx.db, uploadDir: ctx.uploadDir, outDir: out });
  const restored = await openPglite();
  const dir = path.join(work, 'restored-2');
  await restorePglite(out, restored, dir);
  unlinkSync(path.join(dir, ...key.split('/')));
  const check = await verifyRestore(out, restored, dir);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => p.includes(key)));
  await restored.close();
});
