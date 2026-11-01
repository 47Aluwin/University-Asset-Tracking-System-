// Phase 4: condition history, damage reports, department-managed maintenance, costs, attachments.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { api, createDepartment, createUser, login, setup, type TestCtx } from './helpers.ts';

let ctx: TestCtx;
let deptA: string;
let deptB: string;
let cat: string;
let locA: string;
let locB: string;
let admin: string;
let staffA: string;
let staffA2: string;
let staffB: string;
let manager: string;
let staffAId: string;
const YEAR = new Date().getUTCFullYear();

async function registeredAsset(token = staffA, dept: 'A' | 'B' = 'A') {
  const call = api(ctx.app, token);
  const c = await call('POST', '/assets', {
    name: 'Centrifuge', categoryId: cat, serialNumber: `SN-${randomUUID().slice(0, 8)}`,
    departmentId: dept === 'A' ? deptA : deptB, locationId: dept === 'A' ? locA : locB, acquisitionDate: '2025-02-01',
    acquisitionMethod: 'purchase', costStatus: 'recorded', acquisitionCost: '2400.00', currency: 'USD', condition: 'good',
  });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  await call('POST', `/assets/${c.body.id}/label-prints`, { layout: 'sheet' });
  return (await call('POST', `/assets/${c.body.id}/confirm-label`, { code: c.body.qrPayload, method: 'scan' })).body;
}

const newRequest = async (token: string, assetId: string, problem = 'Motor makes a grinding noise') =>
  api(ctx.app, token)('POST', '/maintenance', { assetId, problem, priority: 'high' });

const status = (token: string, id: string, version: number, to: string, extra: Record<string, unknown> = {}) =>
  api(ctx.app, token)('POST', `/maintenance/${id}/status`, { to, version, ...extra });

/** multipart/form-data body with one file, as a browser or phone would send it. */
function upload(token: string, path: string, data: Buffer, filename: string, contentType: string, headers: Record<string, string> = {}) {
  const boundary = '----uats' + randomUUID();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return ctx.app
    .inject({ method: 'POST', url: `/api/v1${path}`, payload: body, headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}`, ...headers } })
    .then((r) => ({ status: r.statusCode, body: r.json() }));
}

// Smallest valid-looking files for each accepted type (only the leading bytes are checked).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PDF = Buffer.from('%PDF-1.4\n% test document\n');

before(async () => {
  ctx = await setup();
  deptA = await createDepartment(ctx.db, 'AAA');
  deptB = await createDepartment(ctx.db, 'BBB');
  await createUser(ctx.db, 'admin@uni.test', 'SYSTEM_ADMIN');
  staffAId = await createUser(ctx.db, 'staff.a@uni.test', 'DEPARTMENT_STAFF', deptA);
  await createUser(ctx.db, 'staff.a2@uni.test', 'DEPARTMENT_STAFF', deptA);
  await createUser(ctx.db, 'staff.b@uni.test', 'DEPARTMENT_STAFF', deptB);
  await createUser(ctx.db, 'manager@uni.test', 'ASSET_MANAGER');
  admin = await login(ctx.app, 'admin@uni.test');
  staffA = await login(ctx.app, 'staff.a@uni.test');
  staffA2 = await login(ctx.app, 'staff.a2@uni.test');
  staffB = await login(ctx.app, 'staff.b@uni.test');
  manager = await login(ctx.app, 'manager@uni.test');
  await api(ctx.app, admin)('PUT', '/settings/institution_time_zone', { value: 'UTC' });
  cat = (await api(ctx.app, admin)('POST', '/categories', { name: 'Lab equipment' })).body.id;
  locA = (await api(ctx.app, staffA)('POST', '/locations', { departmentId: deptA, building: 'Science', room: '101' })).body.id;
  locB = (await api(ctx.app, staffB)('POST', '/locations', { departmentId: deptB, building: 'Library', room: 'G1' })).body.id;
});
after(() => ctx.close());

describe('condition history and damage reports', () => {
  test('a condition change is recorded as history and updates the current condition', async () => {
    const a = await registeredAsset();
    const r = await api(ctx.app, staffA)('POST', `/assets/${a.id}/condition`, { condition: 'fair', notes: 'Scratches on the casing' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.asset.condition, 'fair');
    const h = await api(ctx.app, staffA)('GET', `/assets/${a.id}/condition-history`);
    assert.equal(h.body.items[0].previousCondition, 'good');
    assert.equal(h.body.items[0].newCondition, 'fair');
    assert.equal(h.body.items[0].source, 'condition_update');
    const same = await api(ctx.app, staffA)('POST', `/assets/${a.id}/condition`, { condition: 'fair' });
    assert.equal(same.status, 400, 'no change without new information');
  });

  test('editing condition directly is refused for registered assets', async () => {
    const a = await registeredAsset();
    const r = await api(ctx.app, staffA)('PATCH', `/assets/${a.id}`, { version: a.version, condition: 'damaged' });
    assert.equal(r.body.error.code, 'USE_WORKFLOW');
    assert.match(r.body.error.message, /Update condition/);
  });

  test('a damage report needs a description and can open a maintenance request at the same time', async () => {
    const a = await registeredAsset();
    const bad = await api(ctx.app, staffA)('POST', `/assets/${a.id}/condition`, { condition: 'damaged', damageDescription: 'x' });
    assert.equal(bad.status, 400);
    const r = await api(ctx.app, staffA)('POST', `/assets/${a.id}/condition`, {
      condition: 'damaged',
      damageDescription: 'Cracked lid after it was dropped',
      requestMaintenance: { problem: 'Lid needs replacing', priority: 'urgent' },
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.maintenanceRequestId);
    const m = await api(ctx.app, staffA)('GET', `/maintenance/${r.body.maintenanceRequestId}`);
    assert.equal(m.body.conditionAtReport, 'damaged', 'the request records the condition being reported');
    assert.equal(m.body.priority, 'urgent');
    assert.equal(r.body.asset.openMaintenance, 1);
  });

  test('a condition change reported late does not overwrite a newer one', async () => {
    const a = await registeredAsset();
    await api(ctx.app, staffA)('POST', `/assets/${a.id}/condition`, { condition: 'fair' });
    const late = await api(ctx.app, staffA)('POST', `/assets/${a.id}/condition`, {
      condition: 'unusable', damageDescription: 'Recorded offline two days ago', eventTime: new Date(Date.now() - 2 * 86400000).toISOString(),
    });
    assert.equal(late.status, 201);
    assert.equal(late.body.asset.condition, 'fair', 'current condition keeps the newest record');
    const h = await api(ctx.app, staffA)('GET', `/assets/${a.id}/condition-history`);
    assert.equal(h.body.items.length, 2, 'both are kept in history');
  });

  test('only the owning department records condition; the Asset Management Team cannot', async () => {
    const a = await registeredAsset();
    assert.equal((await api(ctx.app, staffB)('POST', `/assets/${a.id}/condition`, { condition: 'fair' })).status, 403);
    assert.equal((await api(ctx.app, manager)('POST', `/assets/${a.id}/condition`, { condition: 'fair' })).status, 403);
  });
});

describe('department-managed maintenance', () => {
  test('a request gets a reference, starts as submitted, and has a status history', async () => {
    const a = await registeredAsset();
    const r = await newRequest(staffA, a.id);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.reference, new RegExp(`^MR-${YEAR}-\\d{5}$`));
    assert.equal(r.body.status, 'submitted');
    assert.equal(r.body.requiresApproval, false);
    assert.deepEqual(r.body.can.nextStatuses, ['under_review', 'in_progress', 'rejected', 'cancelled'], 'no approval step unless the department turns it on');
    const d = await api(ctx.app, staffA)('GET', `/maintenance/${r.body.id}`);
    assert.deepEqual(d.body.history.map((h: any) => h.to), ['submitted']);
  });

  test('the full repair path: in progress → awaiting external service → completed → condition confirmed', async () => {
    const a = await registeredAsset();
    await api(ctx.app, staffA)('POST', `/assets/${a.id}/condition`, { condition: 'damaged', damageDescription: 'Will not spin up' });
    let r = (await newRequest(staffA, a.id)).body;
    r = (await status(staffA, r.id, r.version, 'in_progress', { note: 'Diagnosing' })).body;
    assert.equal(r.status, 'in_progress');
    const noProvider = await status(staffA, r.id, r.version, 'awaiting_external');
    assert.equal(noProvider.status, 400, 'external service needs a named provider');
    r = (await status(staffA, r.id, r.version, 'awaiting_external', { provider: { type: 'external', name: 'LabFix Ltd', contact: '+675 000 0000' } })).body;
    assert.equal(r.provider.name, 'LabFix Ltd');
    assert.equal((await status(staffA, r.id, r.version, 'completed')).body.error.code, 'USE_COMPLETE');
    const noWork = await api(ctx.app, staffA)('POST', `/maintenance/${r.id}/complete`, { version: r.version, workPerformed: '', outcome: 'repaired' });
    assert.equal(noWork.status, 400, 'cannot close without recording what was done');
    const done = await api(ctx.app, staffA)('POST', `/maintenance/${r.id}/complete`, { version: r.version, workPerformed: 'Replaced drive belt and bearings', outcome: 'repaired' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.status, 'completed');
    // Completion alone does not make the asset usable again.
    assert.equal((await api(ctx.app, staffA)('GET', `/assets/${a.id}`)).body.condition, 'damaged');
    assert.equal(done.body.can.confirmCondition, true);
    const conf = await api(ctx.app, staffA)('POST', `/maintenance/${r.id}/confirm-condition`, { version: done.body.version, condition: 'good', note: 'Tested for 30 minutes' });
    assert.equal(conf.status, 200);
    assert.equal(conf.body.resultingCondition, 'good');
    assert.equal(conf.body.conditionConfirmedBy, 'Test DEPARTMENT_STAFF');
    assert.equal((await api(ctx.app, staffA)('GET', `/assets/${a.id}`)).body.condition, 'good');
    const again = await api(ctx.app, staffA)('POST', `/maintenance/${r.id}/confirm-condition`, { version: conf.body.version, condition: 'good' });
    assert.equal(again.status, 409);
    const hist = await api(ctx.app, staffA)('GET', `/assets/${a.id}/condition-history`);
    assert.equal(hist.body.items[0].source, 'maintenance_confirmation');
    assert.equal(hist.body.items[0].maintenance.reference, r.reference);
    const d = await api(ctx.app, staffA)('GET', `/maintenance/${r.id}`);
    assert.deepEqual(d.body.history.map((h: any) => h.to), ['submitted', 'in_progress', 'awaiting_external', 'completed']);
  });

  test('invalid moves and stale updates are refused', async () => {
    const a = await registeredAsset();
    const r = (await newRequest(staffA, a.id)).body;
    assert.equal((await status(staffA, r.id, r.version, 'awaiting_parts')).status, 409, 'cannot wait for parts before work starts');
    const moved = (await status(staffA, r.id, r.version, 'under_review')).body;
    const stale = await status(staffA, r.id, r.version, 'in_progress');
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
    assert.equal((await status(staffA, r.id, moved.version, 'in_progress')).status, 200);
  });

  test('rejecting or cancelling needs a reason and closes the request', async () => {
    const a = await registeredAsset();
    const r = (await newRequest(staffA, a.id)).body;
    assert.equal((await status(staffA, r.id, r.version, 'rejected')).status, 400);
    const rej = (await status(staffA, r.id, r.version, 'rejected', { note: 'Covered by warranty, return to supplier' })).body;
    assert.equal(rej.status, 'rejected');
    assert.equal(rej.closingReason, 'Covered by warranty, return to supplier');
    assert.deepEqual(rej.can.nextStatuses, []);
    assert.equal((await status(staffA, r.id, rej.version, 'in_progress')).status, 409);
    const cost = await api(ctx.app, staffA)('POST', `/maintenance/${r.id}/costs`, { kind: 'parts', description: 'Lid', amount: '50', currency: 'USD' });
    assert.equal(cost.status, 409);
  });

  test('departments can require approval; the reporter cannot approve their own request', async () => {
    await api(ctx.app, admin)('PATCH', `/departments/${deptA}`, { maintenanceRequiresApproval: true });
    const a = await registeredAsset();
    const r = (await newRequest(staffA, a.id)).body;
    assert.equal(r.requiresApproval, true);
    assert.ok(!r.can.nextStatuses.includes('in_progress'), 'work cannot start before approval');
    assert.equal((await status(staffA, r.id, r.version, 'in_progress')).status, 409);
    const self = await status(staffA, r.id, r.version, 'approved');
    assert.equal(self.body.error.code, 'SELF_APPROVAL');
    const ok = await status(staffA2, r.id, r.version, 'approved', { note: 'Approved for repair' });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.approvedAt);
    assert.ok(ok.body.can.nextStatuses.includes('in_progress'));
    assert.equal((await status(manager, r.id, ok.body.version, 'in_progress')).status, 403, 'the Asset Management Team is not a maintenance team');
    assert.equal((await status(staffA, r.id, ok.body.version, 'in_progress')).status, 200);
    await api(ctx.app, admin)('PATCH', `/departments/${deptA}`, { maintenanceRequiresApproval: false });
  });

  test('a policy change does not alter requests already in progress', async () => {
    const a = await registeredAsset();
    const r = (await newRequest(staffA, a.id)).body;
    await api(ctx.app, admin)('PATCH', `/departments/${deptA}`, { maintenanceRequiresApproval: true });
    const d = await api(ctx.app, staffA)('GET', `/maintenance/${r.id}`);
    assert.equal(d.body.requiresApproval, false, 'the rule in force when it was reported still applies');
    await api(ctx.app, admin)('PATCH', `/departments/${deptA}`, { maintenanceRequiresApproval: false });
  });

  test('a retried submission with the same operation id creates one request', async () => {
    const a = await registeredAsset();
    const op = randomUUID();
    const send = () => ctx.app.inject({ method: 'POST', url: '/api/v1/maintenance', payload: { assetId: a.id, problem: 'Display flickers' }, headers: { authorization: `Bearer ${staffA}`, 'x-operation-id': op } });
    const [r1, r2] = [await send(), await send()];
    assert.equal(r1.statusCode, 201);
    assert.equal(r2.statusCode, 200);
    assert.equal(r1.json().id, r2.json().id);
  });
});

describe('costs', () => {
  test('costs are recorded per line with a currency and totalled per currency, never combined', async () => {
    const a = await registeredAsset();
    const r = (await newRequest(staffA, a.id)).body;
    const add = (amount: string, currency: string, kind = 'parts') =>
      api(ctx.app, staffA)('POST', `/maintenance/${r.id}/costs`, { kind, description: `${kind} ${amount}`, amount, currency, invoiceRef: 'INV-1' });
    assert.equal((await add('0', 'USD')).status, 400);
    assert.equal((await add('12.345', 'USD')).status, 400);
    assert.equal((await add('10', 'US')).status, 400);
    assert.equal((await add('120.50', 'USD')).status, 201);
    assert.equal((await add('79.50', 'usd', 'labour')).status, 201);
    assert.equal((await add('300', 'PGK', 'external_service')).status, 201);
    const d = await api(ctx.app, staffA)('GET', `/maintenance/${r.id}`);
    assert.equal(d.body.costs.length, 3);
    assert.deepEqual(d.body.costTotals, [
      { currency: 'PGK', amount: '300.00' },
      { currency: 'USD', amount: '200.00' },
    ]);
  });

  test('people without financial access see no costs, and cannot add them', async () => {
    const a = await registeredAsset();
    const r = (await newRequest(staffA, a.id)).body;
    await api(ctx.app, staffA)('POST', `/maintenance/${r.id}/costs`, { kind: 'parts', description: 'Belt', amount: '40', currency: 'USD' });
    const g = await api(ctx.app, admin)('POST', `/users/${(await ctx.db.query(`SELECT id FROM users WHERE email='staff.b@uni.test'`)).rows[0].id}/grants`, {
      departmentId: deptA, accessLevel: 'read', reason: 'Shared equipment review',
    });
    const tb = await login(ctx.app, 'staff.b@uni.test');
    const d = await api(ctx.app, tb)('GET', `/maintenance/${r.id}`);
    assert.equal(d.status, 200, 'read grant can view the request');
    assert.equal(d.body.costs, null);
    assert.equal(d.body.costTotals, null);
    assert.equal((await api(ctx.app, tb)('POST', `/maintenance/${r.id}/costs`, { kind: 'parts', description: 'x1', amount: '1', currency: 'USD' })).status, 403);
    const mgr = await api(ctx.app, manager)('GET', `/maintenance/${r.id}`);
    assert.equal(mgr.body.costTotals[0].amount, '40.00', 'the Asset Management Team can monitor costs');
    await api(ctx.app, admin)('POST', `/users/${(await ctx.db.query(`SELECT id FROM users WHERE email='staff.b@uni.test'`)).rows[0].id}/grants/${g.body.id}/revoke`);
  });
});

describe('attachments', () => {
  test('photos are checked by their contents, stored privately and served only to permitted users', async () => {
    const a = await registeredAsset();
    const r = (await newRequest(staffA, a.id)).body;
    const up = await upload(staffA, `/maintenance/${r.id}/attachments`, JPEG, 'damage photo.JPG', 'image/jpeg');
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.contentType, 'image/jpeg');
    assert.equal(up.body.sha256, createHash('sha256').update(JPEG).digest('hex'));
    const d = await api(ctx.app, staffA)('GET', `/maintenance/${r.id}`);
    assert.equal(d.body.attachments[0].fileName, 'damage photo.jpg');
    const file = await ctx.app.inject({ method: 'GET', url: `/api/v1/attachments/${up.body.id}`, headers: { authorization: `Bearer ${staffA}` } });
    assert.equal(file.statusCode, 200);
    assert.deepEqual(file.rawPayload, JPEG);
    assert.equal(file.headers['content-type'], 'image/jpeg');
    assert.equal(file.headers['x-content-type-options'], 'nosniff');
    assert.match(String(file.headers['content-security-policy']), /sandbox/);
    assert.equal((await ctx.app.inject({ method: 'GET', url: `/api/v1/attachments/${up.body.id}` })).statusCode, 401);
    assert.equal((await ctx.app.inject({ method: 'GET', url: `/api/v1/attachments/${up.body.id}`, headers: { authorization: `Bearer ${staffB}` } })).statusCode, 403);
    const mgr = await ctx.app.inject({ method: 'GET', url: `/api/v1/attachments/${up.body.id}`, headers: { authorization: `Bearer ${manager}` } });
    assert.equal(mgr.statusCode, 200, 'oversight can view');
  });

  test('disguised, oversized and damaged uploads are refused', async () => {
    const a = await registeredAsset();
    const r = (await newRequest(staffA, a.id)).body;
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    assert.equal((await upload(staffA, `/maintenance/${r.id}/attachments`, html, 'photo.jpg', 'image/jpeg')).status, 415, 'a script named .jpg is rejected');
    const big = Buffer.concat([JPEG, Buffer.alloc(6 * 1024 * 1024)]);
    assert.equal((await upload(staffA, `/maintenance/${r.id}/attachments`, big, 'big.jpg', 'image/jpeg')).status, 413);
    const bad = await upload(staffA, `/maintenance/${r.id}/attachments`, JPEG, 'x.jpg', 'image/jpeg', { 'x-content-sha256': '0'.repeat(64) });
    assert.equal(bad.body.error.code, 'CHECKSUM_MISMATCH');
    const pdf = await upload(staffA, `/maintenance/${r.id}/attachments`, PDF, '../../etc/invoice.pdf', 'application/pdf');
    assert.equal(pdf.status, 201);
    const d = await api(ctx.app, staffA)('GET', `/maintenance/${r.id}`);
    const stored = d.body.attachments.find((x: any) => x.id === pdf.body.id);
    assert.equal(stored.fileName, 'invoice.pdf', 'path tricks in the name are stripped');
    const dl = await ctx.app.inject({ method: 'GET', url: `/api/v1/attachments/${pdf.body.id}`, headers: { authorization: `Bearer ${staffA}` } });
    assert.match(String(dl.headers['content-disposition']), /^attachment;/, 'PDFs download rather than open in the page');
    assert.equal((await upload(staffB, `/maintenance/${r.id}/attachments`, JPEG, 'x.jpg', 'image/jpeg')).status, 403);
    assert.equal((await upload(manager, `/maintenance/${r.id}/attachments`, JPEG, 'x.jpg', 'image/jpeg')).status, 403);
  });

  test('damage photos attach to the condition record', async () => {
    const a = await registeredAsset();
    const c = await api(ctx.app, staffA)('POST', `/assets/${a.id}/condition`, { condition: 'damaged', damageDescription: 'Dent on the side panel' });
    const up = await upload(staffA, `/condition-events/${c.body.conditionEventId}/attachments`, JPEG, 'dent.jpg', 'image/jpeg');
    assert.equal(up.status, 201);
    const h = await api(ctx.app, staffA)('GET', `/assets/${a.id}/condition-history`);
    assert.equal(h.body.items[0].attachments[0].id, up.body.id);
  });

  test('a request opened from a damage report shows that report’s photos', async () => {
    const a = await registeredAsset();
    const c = await api(ctx.app, staffA)('POST', `/assets/${a.id}/condition`, {
      condition: 'damaged', damageDescription: 'Broken hinge on the door', requestMaintenance: { problem: 'Replace the hinge', priority: 'normal' },
    });
    const up = await upload(staffA, `/condition-events/${c.body.conditionEventId}/attachments`, JPEG, 'hinge.jpg', 'image/jpeg');
    const d = await api(ctx.app, staffA)('GET', `/maintenance/${c.body.maintenanceRequestId}`);
    assert.deepEqual(d.body.attachments.map((x: any) => x.id), [up.body.id]);
    const file = await ctx.app.inject({ method: 'GET', url: `/api/v1/attachments/${up.body.id}`, headers: { authorization: `Bearer ${staffB}` } });
    assert.equal(file.statusCode, 403, 'still only visible to people who may see the department');
  });
});

describe('oversight and listing', () => {
  test('staff list their own department’s requests; the Asset Management Team sees all, read-only', async () => {
    const a = await registeredAsset();
    const b = await registeredAsset(staffB, 'B');
    await newRequest(staffA, a.id, 'Department A problem');
    const rb = (await newRequest(staffB, b.id, 'Department B problem')).body;
    const listA = await api(ctx.app, staffA)('GET', '/maintenance?open=true&pageSize=100');
    assert.ok(listA.body.items.every((x: any) => x.department.id === deptA));
    assert.equal((await api(ctx.app, staffA)('GET', `/maintenance/${rb.id}`)).status, 403);
    const all = await api(ctx.app, manager)('GET', '/maintenance?open=true&pageSize=100');
    assert.ok(all.body.items.some((x: any) => x.department.id === deptA) && all.body.items.some((x: any) => x.department.id === deptB));
    assert.ok(all.body.items.every((x: any) => x.can.changeStatus === false && x.can.nextStatuses.length === 0));
    assert.equal((await newRequest(manager, a.id)).status, 403);
    const urgentFirst = await api(ctx.app, staffA)('GET', '/maintenance?open=true&pageSize=100');
    const order = urgentFirst.body.items.map((x: any) => ['urgent', 'high', 'normal', 'low'].indexOf(x.priority));
    assert.deepEqual(order, [...order].sort((x, y) => x - y), 'open requests listed most urgent first');
  });

  test('every maintenance action is in the audit log', async () => {
    const { rows } = await ctx.db.query(`SELECT DISTINCT action FROM audit_events WHERE action LIKE 'maintenance.%' OR action IN ('asset.condition','attachment.upload') ORDER BY action`);
    assert.deepEqual(rows.map((r) => r.action), [
      'asset.condition', 'attachment.upload', 'maintenance.complete', 'maintenance.confirm_condition', 'maintenance.cost_add', 'maintenance.create', 'maintenance.status',
    ]);
  });
});
