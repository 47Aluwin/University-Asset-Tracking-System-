// Phase 6: offline queue + synchronisation, run end to end: the app's own queue code (shared/offline-queue.ts)
// sends to the real API. Covers the brief's gate: restart survival, duplicate prevention, conflicts surfaced,
// correct event times — plus reserved ID blocks, offline photos, clock skew, retries and sign-in expiry.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { api, createDepartment, createUser, login, setup, type TestCtx } from './helpers.ts';
import {
  NetworkError,
  OfflineQueue,
  type QueuedOp,
  type QueueStore,
  type SendRequest,
  type SendResult,
  type Transport,
} from '../../shared/offline-queue.ts';

let ctx: TestCtx;
let dir: string;
let deptA: string;
let cat: string;
let locA1: string;
let locA2: string;
let admin: string;
let staffA: string;
let staffA2: string;
let staffAId: string;
let staffA2Id: string;

/** A store that writes every change to a JSON file, like the app's SQLite database survives a restart. */
class FileStore implements QueueStore {
  private file: string;
  constructor(file: string) {
    this.file = file;
  }
  private read(): Record<string, QueuedOp> {
    return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
  }
  async load() {
    return Object.values(this.read());
  }
  async save(op: QueuedOp) {
    const all = this.read();
    all[op.id] = op;
    writeFileSync(this.file, JSON.stringify(all));
  }
  async remove(id: string) {
    const all = this.read();
    delete all[id];
    writeFileSync(this.file, JSON.stringify(all));
  }
}

const files = new Map<string, Buffer>(); // "photos on the device", by uri

/** Sends a queued request to the real API in the same way the app's fetch transport does. */
function transportFor(getToken: () => string): Transport {
  return async (r: SendRequest): Promise<SendResult> => {
    const headers: Record<string, string> = { authorization: `Bearer ${getToken()}`, 'x-operation-id': r.operationId };
    let payload: any;
    if (r.file) {
      const data = files.get(r.file.uri)!;
      const boundary = '----uats' + randomUUID();
      payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${r.file.name}"\r\nContent-Type: ${r.file.type}\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
      if (r.file.sha256) headers['x-content-sha256'] = r.file.sha256;
    } else if (r.body !== undefined) {
      payload = r.body;
    }
    const res = await ctx.app.inject({ method: r.method, url: `/api/v1${r.path}`, headers, payload });
    let body: any = null;
    try {
      body = res.json();
    } catch {}
    return { status: res.statusCode, body };
  };
}
const offline: Transport = async () => {
  throw new NetworkError();
};
/** The request reaches the server and is processed, but the reply is lost on the way back. */
const replyLost = (t: Transport): Transport => async (r) => {
  await t(r);
  throw new NetworkError('Connection dropped before the reply arrived.');
};

const newQueue = (store: QueueStore, t: Transport, now?: () => number) => new OfflineQueue(store, t, { newId: randomUUID, now });
const count = async (sql: string, params: unknown[] = []) => Number((await ctx.db.query(sql, params)).rows[0].n);

async function registeredAsset(token = staffA) {
  const call = api(ctx.app, token);
  const c = await call('POST', '/assets', {
    name: 'Field radio', categoryId: cat, serialNumber: `SN-${randomUUID().slice(0, 8)}`, departmentId: deptA, locationId: locA1,
    acquisitionDate: '2025-02-01', acquisitionMethod: 'purchase', costStatus: 'recorded', acquisitionCost: '300.00', currency: 'USD', condition: 'good',
  });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  await call('POST', `/assets/${c.body.id}/label-prints`, { layout: 'sheet' });
  return (await call('POST', `/assets/${c.body.id}/confirm-label`, { code: c.body.qrPayload, method: 'scan' })).body;
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 9)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

before(async () => {
  ctx = await setup();
  dir = mkdtempSync(path.join(tmpdir(), 'uats-queue-'));
  deptA = await createDepartment(ctx.db, 'AAA');
  await createUser(ctx.db, 'admin@uni.test', 'SYSTEM_ADMIN');
  staffAId = await createUser(ctx.db, 'staff.a@uni.test', 'DEPARTMENT_STAFF', deptA);
  staffA2Id = await createUser(ctx.db, 'staff.a2@uni.test', 'DEPARTMENT_STAFF', deptA);
  admin = await login(ctx.app, 'admin@uni.test');
  staffA = await login(ctx.app, 'staff.a@uni.test');
  staffA2 = await login(ctx.app, 'staff.a2@uni.test');
  await api(ctx.app, admin)('PUT', '/settings/institution_time_zone', { value: 'UTC' });
  cat = (await api(ctx.app, admin)('POST', '/categories', { name: 'Radios' })).body.id;
  locA1 = (await api(ctx.app, staffA)('POST', '/locations', { departmentId: deptA, building: 'Field station', room: 'Store' })).body.id;
  locA2 = (await api(ctx.app, staffA)('POST', '/locations', { departmentId: deptA, building: 'Field station', room: 'Hut 2' })).body.id;
});
after(async () => {
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('restart survival and event times', () => {
  test('actions saved offline survive an app restart and sync later with their original event times', async () => {
    const a = await registeredAsset();
    const file = path.join(dir, 'restart.json');
    const q1 = newQueue(new FileStore(file), offline);
    await q1.init();
    const scannedAt = new Date(Date.now() - 3 * 3600_000).toISOString(); // three hours ago, in the field
    const v = await q1.enqueue(staffAId, { kind: 'verify', label: `Verify ${a.institutionalId}`, method: 'POST', path: `/assets/${a.id}/verifications`, body: { method: 'scan', observedLocationId: locA2, eventTime: scannedAt }, eventTime: scannedAt });
    const c = await q1.enqueue(staffAId, { kind: 'condition', label: 'Damage report', method: 'POST', path: `/assets/${a.id}/condition`, body: { condition: 'damaged', damageDescription: 'Aerial snapped off', eventTime: scannedAt, requestMaintenance: { problem: 'Replace the aerial', priority: 'high' } } });
    files.set('file:///photo-1.jpg', JPEG);
    await q1.enqueue(staffAId, { kind: 'photo', label: 'Photo', method: 'POST', path: `/condition-events/{{op:${c.id}.conditionEventId}}/attachments`, file: { uri: 'file:///photo-1.jpg', name: 'aerial.jpg', type: 'image/jpeg', sha256: sha(JPEG) }, dependsOn: [c.id] });
    const s1 = await q1.sync(staffAId);
    assert.equal(s1.offline, true);
    assert.equal(s1.synced, 0);
    // Simulate the app being killed in the middle of a send.
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    saved[v.id].status = 'syncing';
    writeFileSync(file, JSON.stringify(saved));

    // "Restart": a brand-new queue reading the same storage, now with a connection.
    const q2 = newQueue(new FileStore(file), transportFor(() => staffA));
    await q2.init();
    assert.deepEqual(q2.list().map((o) => o.status), ['pending', 'pending', 'pending'], 'nothing lost, interrupted send waits again');
    const s2 = await q2.sync(staffAId);
    assert.deepEqual([s2.synced, s2.remaining], [3, 0]);
    assert.ok(q2.list().every((o) => o.status === 'synced'));

    const ve = (await ctx.db.query('SELECT event_time, received_at, operation_id FROM verification_events WHERE asset_id = $1 ORDER BY received_at DESC LIMIT 1', [a.id])).rows[0];
    assert.equal(new Date(ve.event_time).toISOString(), scannedAt, 'device event time kept');
    assert.ok(new Date(ve.received_at).getTime() > Date.parse(scannedAt), 'server receive time recorded separately');
    assert.equal(ve.operation_id, v.id);
    const asset = (await api(ctx.app, staffA)('GET', `/assets/${a.id}`)).body;
    assert.equal(asset.condition, 'damaged');
    assert.equal(asset.verification.lastVerifiedAt && new Date(asset.verification.lastVerifiedAt).toISOString(), scannedAt);
    assert.equal(await count(`SELECT count(*) AS n FROM attachments WHERE owner_id = $1`, [(q2.get(c.id)!.result as any).conditionEventId]), 1, 'photo uploaded and linked');
  });

  test('an action 10 minutes in the future (wrong device clock) is refused and not retried; a week-old one is flagged late', async () => {
    const a = await registeredAsset();
    const q = newQueue(new FileStore(path.join(dir, 'clock.json')), transportFor(() => staffA));
    await q.init();
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    const old = new Date(Date.now() - 10 * 86400_000).toISOString();
    const f = await q.enqueue(staffAId, { kind: 'verify', label: 'Future', method: 'POST', path: `/assets/${a.id}/verifications`, body: { method: 'scan', eventTime: future } });
    const o = await q.enqueue(staffAId, { kind: 'verify', label: 'Old scan', method: 'POST', path: `/assets/${a.id}/verifications`, body: { method: 'scan', eventTime: old } });
    await q.sync(staffAId);
    assert.equal(q.get(f.id)!.status, 'rejected');
    assert.equal(q.get(f.id)!.lastError!.code, 'EVENT_IN_FUTURE');
    assert.equal(q.get(o.id)!.status, 'synced');
    assert.equal(await count(`SELECT count(*) AS n FROM asset_flags WHERE asset_id = $1 AND kind = 'late_event'`, [a.id]), 1);
    const again = await q.sync(staffAId);
    assert.equal(again.rejected + again.synced, 0, 'a rejected action is not resent automatically');
  });
});

describe('duplicate prevention', () => {
  test('when replies are lost, resending every kind of action records each one exactly once', async () => {
    const a = await registeredAsset();
    const store = new FileStore(path.join(dir, 'dupes.json'));
    const real = transportFor(() => staffA);
    const q = newQueue(store, replyLost(real));
    await q.init();
    files.set('file:///photo-2.jpg', JPEG);
    const block = (await api(ctx.app, staffA)('POST', '/assets/id-blocks', { deviceId: 'phone-1', count: 2 })).body.ids;
    const ops: QueuedOp[] = [];
    ops.push(await q.enqueue(staffAId, { kind: 'verify', label: 'v', method: 'POST', path: `/assets/${a.id}/verifications`, body: { method: 'scan' } }));
    ops.push(await q.enqueue(staffAId, { kind: 'move', label: 'm', method: 'POST', path: `/assets/${a.id}/movements`, body: { toLocationId: locA2 } }));
    const cond = await q.enqueue(staffAId, { kind: 'condition', label: 'c', method: 'POST', path: `/assets/${a.id}/condition`, body: { condition: 'fair', notes: 'Scuffed' } });
    ops.push(cond);
    ops.push(await q.enqueue(staffAId, { kind: 'photo', label: 'p', method: 'POST', path: `/condition-events/{{op:${cond.id}.conditionEventId}}/attachments`, file: { uri: 'file:///photo-2.jpg', name: 'p.jpg', type: 'image/jpeg' }, dependsOn: [cond.id] }));
    ops.push(await q.enqueue(staffAId, { kind: 'maintenance', label: 'r', method: 'POST', path: '/maintenance', body: { assetId: a.id, problem: 'Battery does not hold charge' } }));
    // Edited after the same person's own move and condition update (which change the version, not the notes).
    ops.push(await q.enqueue(staffAId, { kind: 'edit', label: 'e', method: 'PATCH', path: `/assets/${a.id}`, body: { notes: 'Checked in the field', version: a.version, baseValues: { notes: a.notes } } }));
    const create = await q.enqueue(staffAId, { kind: 'register', label: 'new', method: 'POST', path: '/assets', body: {
      name: 'Solar panel', categoryId: cat, serialNumber: `SP-${randomUUID().slice(0, 6)}`, departmentId: deptA, locationId: locA1, acquisitionDate: '2025-06-01',
      acquisitionMethod: 'purchase', costStatus: 'recorded', acquisitionCost: '80.00', currency: 'USD', condition: 'good', institutionalId: block[0] } });
    const print = await q.enqueue(staffAId, { kind: 'label-print', label: 'print', method: 'POST', path: `/assets/{{op:${create.id}.id}}/label-prints`, body: { layout: 'single' }, dependsOn: [create.id] });
    await q.enqueue(staffAId, { kind: 'confirm-label', label: 'confirm', method: 'POST', path: `/assets/{{op:${create.id}.id}}/confirm-label`, body: { code: `UATS:${block[0]}`, method: 'scan' }, dependsOn: [print.id] });

    // Each pass: the server processes the next action, but the reply never arrives.
    for (let i = 0; i < 9; i++) await q.sync(staffAId);
    assert.ok(q.list().every((o) => o.status === 'pending'), 'nothing is marked done without a reply');
    // Connection restored: everything is resent with the same operation ids.
    const good = newQueue(store, real);
    await good.init();
    for (let i = 0; i < 3; i++) await good.sync(staffAId);
    assert.ok(good.list().every((o) => o.status === 'synced'), JSON.stringify(good.list().filter((o) => o.status !== 'synced').map((o) => [o.kind, o.lastError])));

    assert.equal(await count('SELECT count(*) AS n FROM verification_events WHERE asset_id = $1', [a.id]), 1, 'one field scan, sent many times');
    assert.equal(await count('SELECT count(*) AS n FROM movement_events WHERE asset_id = $1', [a.id]), 1);
    assert.equal(await count(`SELECT count(*) AS n FROM condition_events WHERE asset_id = $1`, [a.id]), 1);
    assert.equal(await count('SELECT count(*) AS n FROM attachments WHERE asset_id = $1', [a.id]), 1);
    assert.equal(await count('SELECT count(*) AS n FROM maintenance_requests WHERE asset_id = $1', [a.id]), 1);
    const after = (await api(ctx.app, staffA)('GET', `/assets/${a.id}`)).body;
    assert.equal(after.version, a.version + 1 + 2, 'one edit (plus the move and condition updates), never a false conflict');
    assert.equal(await count(`SELECT count(*) AS n FROM sync_conflicts WHERE entity_id = $1`, [a.id]), 0);
    const created = good.get(create.id)!.result as any;
    assert.equal(created.institutionalId, block[0], 'the ID printed offline is the final ID');
    assert.equal(await count('SELECT count(*) AS n FROM assets WHERE institutional_id = $1', [block[0]]), 1);
    assert.equal(await count('SELECT count(*) AS n FROM label_print_events WHERE asset_id = $1', [created.id]), 1, 'one print, not a reprint');
    assert.equal((await api(ctx.app, staffA)('GET', `/assets/${created.id}`)).body.registrationStatus, 'registered');
  });

  test('two copies of the same action sent at the same moment create one record', async () => {
    const a = await registeredAsset();
    const send = transportFor(() => staffA);
    const op = randomUUID();
    const req = { method: 'POST' as const, path: '/maintenance', body: { assetId: a.id, problem: 'Display flickers' }, operationId: op };
    const [r1, r2] = await Promise.all([send(req), send(req)]);
    assert.ok(r1.status < 300 && r2.status < 300, 'both copies get the result'); // the repeat is answered 200 (replay)
    assert.equal(r1.body.id, r2.body.id);
    assert.equal(await count('SELECT count(*) AS n FROM maintenance_requests WHERE asset_id = $1', [a.id]), 1);
  });

  test('an operation id cannot be reused by another user or for a different action', async () => {
    const a = await registeredAsset();
    const op = randomUUID();
    const mine = await transportFor(() => staffA)({ method: 'POST', path: `/assets/${a.id}/label-prints`, body: { layout: 'sheet', reason: 'Damaged label' }, operationId: op });
    assert.equal(mine.status, 201);
    const other = await transportFor(() => staffA2)({ method: 'POST', path: `/assets/${a.id}/label-prints`, body: { layout: 'sheet', reason: 'Damaged label' }, operationId: op });
    assert.equal(other.status, 409);
    assert.equal(other.body.error.code, 'OPERATION_ID_REUSED');
    const bad = await ctx.app.inject({ method: 'POST', url: `/api/v1/assets/${a.id}/label-prints`, headers: { authorization: `Bearer ${staffA}`, 'x-operation-id': 'not-a-uuid' }, payload: { layout: 'sheet', reason: 'x y z' } });
    assert.equal(bad.statusCode, 400);
  });
});

describe('reserved ID blocks', () => {
  test('a block is taken from the same counter, so online registrations never reuse those IDs', async () => {
    const block = (await api(ctx.app, staffA)('POST', '/assets/id-blocks', { deviceId: 'phone-2', count: 3 }));
    assert.equal(block.status, 201);
    const ids: string[] = block.body.ids;
    assert.equal(ids.length, 3);
    assert.ok(Date.parse(block.body.expiresAt) > Date.now() + 29 * 86400_000);
    const online = await registeredAsset(staffA2);
    assert.ok(!ids.includes(online.institutionalId));
    assert.ok(online.institutionalId > ids[2], 'later than the block');
    const mine = (await api(ctx.app, staffA)('GET', '/assets/id-blocks')).body.items.map((x: any) => x.institutionalId);
    for (const id of ids) assert.ok(mine.includes(id));
    const audit = await count(`SELECT count(*) AS n FROM audit_events WHERE action = 'asset_id.reserve' AND actor_user_id = $1`, [staffAId]);
    assert.ok(audit >= 1);
  });

  test('reserved IDs can only be used once, and only by the person who reserved them', async () => {
    const [id1] = (await api(ctx.app, staffA)('POST', '/assets/id-blocks', { deviceId: 'phone-3', count: 1 })).body.ids;
    const body = (over: Record<string, unknown> = {}) => ({
      name: 'Tripod', categoryId: cat, serialNumber: `TR-${randomUUID().slice(0, 6)}`, departmentId: deptA, locationId: locA1, acquisitionDate: '2025-06-01',
      acquisitionMethod: 'purchase', costStatus: 'recorded', acquisitionCost: '40.00', currency: 'USD', condition: 'good', institutionalId: id1, ...over,
    });
    const other = await api(ctx.app, staffA2)('POST', '/assets', body());
    assert.equal(other.status, 409);
    assert.equal(other.body.error.code, 'RESERVED_ID_INVALID');
    assert.equal((await api(ctx.app, staffA)('POST', '/assets', body())).status, 201);
    const twice = await api(ctx.app, staffA)('POST', '/assets', body());
    assert.equal(twice.body.error.code, 'RESERVED_ID_INVALID');
    assert.equal((await api(ctx.app, staffA)('POST', '/assets', body({ institutionalId: 'UAT-1999-000001' }))).status, 409, 'an ID nobody reserved');
  });

  test('when the block runs out the app registers without an ID and the server assigns one on sync', async () => {
    const q = newQueue(new FileStore(path.join(dir, 'noblock.json')), transportFor(() => staffA));
    await q.init();
    const c = await q.enqueue(staffAId, { kind: 'register', label: 'no ID yet', method: 'POST', path: '/assets', body: {
      name: 'Generator', categoryId: cat, serialNumber: `G-${randomUUID().slice(0, 6)}`, departmentId: deptA, locationId: locA1, acquisitionDate: '2025-06-01',
      acquisitionMethod: 'purchase', costStatus: 'recorded', acquisitionCost: '900.00', currency: 'USD', condition: 'good' } });
    await q.sync(staffAId);
    const r = q.get(c.id)!.result as any;
    assert.match(r.institutionalId, /^UAT-\d{4}-\d{6}$/);
    assert.equal(r.registrationStatus, 'awaiting_label', 'label is printed after sync, once the ID is known');
  });

  test('a user cannot hoard IDs; staff without registration rights cannot reserve', async () => {
    const r = await api(ctx.app, staffA2)('POST', '/assets/id-blocks', { deviceId: 'phone-4', count: 50 });
    assert.equal(r.status, 201);
    assert.equal((await api(ctx.app, staffA2)('POST', '/assets/id-blocks', { deviceId: 'phone-4', count: 50 })).status, 201);
    const r2 = await api(ctx.app, staffA2)('POST', '/assets/id-blocks', { deviceId: 'phone-4', count: 1 });
    assert.equal(r2.status, 409, 'at most 100 unused reserved IDs per person');
    assert.equal(r2.body.error.code, 'TOO_MANY_RESERVED');
    await createUser(ctx.db, 'manager@uni.test', 'ASSET_MANAGER');
    const m = await login(ctx.app, 'manager@uni.test');
    assert.equal((await api(ctx.app, m)('POST', '/assets/id-blocks', { deviceId: 'x', count: 1 })).status, 403);
  });
});

describe('conflicts', () => {
  test('an offline edit to an asset changed meanwhile is kept for review, never applied blindly', async () => {
    const a = await registeredAsset();
    const q = newQueue(new FileStore(path.join(dir, 'conflict.json')), transportFor(() => staffA));
    await q.init();
    const e = await q.enqueue(staffAId, { kind: 'edit', label: 'Edit notes', method: 'PATCH', path: `/assets/${a.id}`, body: { notes: 'Offline note', model: 'RX-2', version: a.version, baseValues: { notes: a.notes, model: a.model } } });
    // Meanwhile a colleague edits the same asset online.
    assert.equal((await api(ctx.app, staffA2)('PATCH', `/assets/${a.id}`, { notes: 'Office note', version: a.version })).status, 200);
    const s = await q.sync(staffAId);
    assert.equal(s.conflicts, 1);
    assert.equal(q.get(e.id)!.status, 'conflict');
    const now = (await api(ctx.app, staffA)('GET', `/assets/${a.id}`)).body;
    assert.equal(now.notes, 'Office note', 'the newer server value is untouched');

    // Sending it again does not create a second conflict.
    await q.retry(e.id);
    await q.sync(staffAId);
    assert.equal(await count('SELECT count(*) AS n FROM sync_conflicts WHERE entity_id = $1', [a.id]), 1);

    const list = (await api(ctx.app, staffA)('GET', '/sync-conflicts')).body.items.filter((c: any) => c.asset.id === a.id);
    assert.equal(list.length, 1);
    const c = list[0];
    assert.deepEqual(c.proposed, { notes: 'Offline note', model: 'RX-2' });
    assert.deepEqual(c.serverValues, { notes: 'Office note', model: null });
    assert.deepEqual([c.baseVersion, c.serverVersion], [a.version, a.version + 1]);
    assert.equal(c.can.resolve, true);

    // The asset manager can see it but not resolve it; another department's staff cannot see it.
    await createUser(ctx.db, 'manager2@uni.test', 'ASSET_MANAGER');
    const mgr = await login(ctx.app, 'manager2@uni.test');
    const seen = (await api(ctx.app, mgr)('GET', '/sync-conflicts')).body.items.find((x: any) => x.id === c.id);
    assert.equal(seen.can.resolve, false);
    assert.equal((await api(ctx.app, mgr)('POST', `/sync-conflicts/${c.id}/resolve`, { action: 'apply' })).status, 403);
    const deptB = await createDepartment(ctx.db, 'BBB');
    await createUser(ctx.db, 'staff.b@uni.test', 'DEPARTMENT_STAFF', deptB);
    const sb = await login(ctx.app, 'staff.b@uni.test');
    assert.ok(!(await api(ctx.app, sb)('GET', '/sync-conflicts')).body.items.some((x: any) => x.id === c.id));

    const applied = await api(ctx.app, staffA2)('POST', `/sync-conflicts/${c.id}/resolve`, { action: 'apply', note: 'Both notes checked; field note is right' });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.status, 'applied');
    const fixed = (await api(ctx.app, staffA)('GET', `/assets/${a.id}`)).body;
    assert.deepEqual([fixed.notes, fixed.model], ['Offline note', 'RX-2']);
    assert.equal((await api(ctx.app, staffA2)('POST', `/sync-conflicts/${c.id}/resolve`, { action: 'discard' })).status, 409, 'resolved only once');
    assert.equal(await count(`SELECT count(*) AS n FROM audit_events WHERE action IN ('sync.conflict', 'sync.conflict_applied') AND entity_id = $1`, [a.id]), 2);
  });

  test('a conflict can be discarded, leaving the asset as it is', async () => {
    const a = await registeredAsset();
    const op = randomUUID();
    await api(ctx.app, staffA2)('PATCH', `/assets/${a.id}`, { notes: 'Newer', version: a.version });
    const r = await transportFor(() => staffA)({ method: 'PATCH', path: `/assets/${a.id}`, body: { notes: 'Older', version: a.version }, operationId: op });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'SYNC_CONFLICT');
    const d = await api(ctx.app, staffA)('POST', `/sync-conflicts/${r.body.error.details.conflictId}/resolve`, { action: 'discard', note: 'Out of date' });
    assert.equal(d.body.status, 'discarded');
    assert.equal((await api(ctx.app, staffA)('GET', `/assets/${a.id}`)).body.notes, 'Newer');
  });

  test('online edits without an operation id keep the normal "reload and reapply" message', async () => {
    const a = await registeredAsset();
    await api(ctx.app, staffA2)('PATCH', `/assets/${a.id}`, { notes: 'x1', version: a.version });
    const r = await api(ctx.app, staffA)('PATCH', `/assets/${a.id}`, { notes: 'x2', version: a.version });
    assert.equal(r.body.error.code, 'VERSION_CONFLICT');
  });
});

describe('failures and retries', () => {
  test('a damaged photo upload is refused by checksum, and actions depending on a refused one are not sent', async () => {
    const a = await registeredAsset();
    const q = newQueue(new FileStore(path.join(dir, 'checksum.json')), transportFor(() => staffA));
    await q.init();
    const c = await q.enqueue(staffAId, { kind: 'condition', label: 'c', method: 'POST', path: `/assets/${a.id}/condition`, body: { condition: 'fair', notes: 'Dent' } });
    files.set('file:///torn.jpg', JPEG.subarray(0, 120)); // only part of the photo was read
    const p = await q.enqueue(staffAId, { kind: 'photo', label: 'p', method: 'POST', path: `/condition-events/{{op:${c.id}.conditionEventId}}/attachments`, file: { uri: 'file:///torn.jpg', name: 'dent.jpg', type: 'image/jpeg', sha256: sha(JPEG) }, dependsOn: [c.id] });
    await q.sync(staffAId);
    assert.equal(q.get(p.id)!.status, 'rejected');
    assert.equal(q.get(p.id)!.lastError!.code, 'CHECKSUM_MISMATCH');
    assert.equal(await count('SELECT count(*) AS n FROM attachments WHERE asset_id = $1', [a.id]), 0);

    const bad = await q.enqueue(staffAId, { kind: 'condition', label: 'bad', method: 'POST', path: `/assets/${a.id}/condition`, body: { condition: 'damaged', damageDescription: 'x', requestMaintenance: { problem: 'x' } } }); // too short
    const dep = await q.enqueue(staffAId, { kind: 'photo', label: 'dep', method: 'POST', path: `/condition-events/{{op:${bad.id}.conditionEventId}}/attachments`, file: { uri: 'file:///photo-1.jpg', name: 'x.jpg', type: 'image/jpeg' }, dependsOn: [bad.id] });
    await q.sync(staffAId);
    assert.equal(q.get(bad.id)!.status, 'rejected');
    assert.equal(q.get(dep.id)!.status, 'rejected');
    assert.equal(q.get(dep.id)!.lastError!.code, 'DEPENDENCY_FAILED');
    // The user fixes the report and sends it again; then the photo can follow.
    await q.retry(bad.id, { body: { condition: 'damaged', damageDescription: 'Casing cracked' } });
    await q.retry(dep.id);
    await q.sync(staffAId);
    assert.deepEqual([q.get(bad.id)!.status, q.get(dep.id)!.status], ['synced', 'synced']);
  });

  test('server errors are retried later with growing waits; an expired sign-in pauses sending', async () => {
    const a = await registeredAsset();
    let clock = Date.now();
    let mode: 'down' | 'up' | 'expired' = 'down';
    const real = transportFor(() => staffA);
    const t: Transport = async (r) => (mode === 'down' ? { status: 503, body: { error: { code: 'UNAVAILABLE', message: 'Maintenance' } } } : mode === 'expired' ? { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Sign in required.' } } } : real(r));
    const q = newQueue(new FileStore(path.join(dir, 'retry.json')), t, () => clock);
    await q.init();
    const v = await q.enqueue(staffAId, { kind: 'verify', label: 'v', method: 'POST', path: `/assets/${a.id}/verifications`, body: { method: 'manual' } });
    await q.sync(staffAId);
    assert.equal(q.get(v.id)!.status, 'failed');
    const wait1 = Date.parse(q.get(v.id)!.nextAttemptAt!) - clock;
    mode = 'up';
    assert.equal((await q.sync(staffAId)).synced, 0, 'waits before retrying');
    clock += wait1 + 1;
    mode = 'down';
    await q.sync(staffAId);
    const wait2 = Date.parse(q.get(v.id)!.nextAttemptAt!) - clock;
    assert.ok(wait2 > wait1, 'waits grow');
    clock += wait2 + 1;
    mode = 'expired';
    const s = await q.sync(staffAId);
    assert.equal(s.signInNeeded, true);
    assert.equal(q.get(v.id)!.status, 'pending');
    mode = 'up';
    await q.sync(staffAId);
    assert.equal(q.get(v.id)!.status, 'synced');
  });

  test("one person's saved actions are never sent with another person's sign-in", async () => {
    const a = await registeredAsset();
    let token = staffA;
    const q = newQueue(new FileStore(path.join(dir, 'users.json')), transportFor(() => token));
    await q.init();
    await q.enqueue(staffAId, { kind: 'verify', label: 'mine', method: 'POST', path: `/assets/${a.id}/verifications`, body: { method: 'scan' } });
    token = staffA2; // someone else signs in on the same phone
    const s = await q.sync(staffA2Id);
    assert.equal(s.synced, 0);
    assert.equal(q.unsynced(staffAId).length, 1);
    assert.equal(await count('SELECT count(*) AS n FROM verification_events WHERE asset_id = $1 AND verified_by = $2', [a.id, staffA2Id]), 0);
  });
});
