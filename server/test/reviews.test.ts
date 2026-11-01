// Post-registration review and correction (brief §9): review queue, approve / return with reason, department
// corrections with before/after values, re-review, append-only history, and permissions.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { api, createDepartment, createUser, login, setup, type TestCtx } from './helpers.ts';

let ctx: TestCtx;
let deptA: string;
let deptB: string;
let cat: string;
let locA: string;
let admin: string;
let manager: string;
let staffA: string;
let staffB: string;
let staffBId: string;

async function asset(register = true) {
  const call = api(ctx.app, staffA);
  const c = await call('POST', '/assets', {
    name: 'Microscope', categoryId: cat, serialNumber: `SN-${randomUUID().slice(0, 8)}`, departmentId: deptA, locationId: locA,
    acquisitionDate: '2025-02-01', acquisitionMethod: 'purchase', costStatus: 'recorded', acquisitionCost: '1500.00', currency: 'USD', condition: 'good',
  });
  assert.equal(c.status, 201);
  if (!register) return c.body;
  await call('POST', `/assets/${c.body.id}/label-prints`, { layout: 'sheet' });
  return (await call('POST', `/assets/${c.body.id}/confirm-label`, { code: c.body.qrPayload, method: 'scan' })).body;
}
const review = (token: string, a: any, body: Record<string, unknown>) => api(ctx.app, token)('POST', `/assets/${a.id}/review`, { version: a.version, ...body });

before(async () => {
  ctx = await setup();
  deptA = await createDepartment(ctx.db, 'AAA');
  deptB = await createDepartment(ctx.db, 'BBB');
  await createUser(ctx.db, 'admin@uni.test', 'SYSTEM_ADMIN');
  await createUser(ctx.db, 'manager@uni.test', 'ASSET_MANAGER');
  await createUser(ctx.db, 'staff.a@uni.test', 'DEPARTMENT_STAFF', deptA);
  staffBId = await createUser(ctx.db, 'staff.b@uni.test', 'DEPARTMENT_STAFF', deptB);
  admin = await login(ctx.app, 'admin@uni.test');
  manager = await login(ctx.app, 'manager@uni.test');
  staffA = await login(ctx.app, 'staff.a@uni.test');
  staffB = await login(ctx.app, 'staff.b@uni.test');
  cat = (await api(ctx.app, admin)('POST', '/categories', { name: 'Lab equipment' })).body.id;
  locA = (await api(ctx.app, staffA)('POST', '/locations', { departmentId: deptA, building: 'Science', room: '101' })).body.id;
});
after(() => ctx.close());

describe('review queue', () => {
  test('review never blocks registration; newly registered records wait in the queue', async () => {
    const a = await asset();
    assert.equal(a.registrationStatus, 'registered', 'registered without waiting for review');
    assert.equal(a.review.status, 'not_reviewed');
    assert.equal(a.can.review, false, 'department staff do not review');
    const m = (await api(ctx.app, manager)('GET', `/assets/${a.id}`)).body;
    assert.equal(m.can.review, true);
    const queue = (await api(ctx.app, manager)('GET', '/assets?review=needs_review&pageSize=100')).body.items.map((x: any) => x.id);
    assert.ok(queue.includes(a.id));
    const unregistered = await asset(false);
    assert.ok(!queue.includes(unregistered.id), 'only registered records are reviewed');
    const r = await review(manager, unregistered, { action: 'approve' });
    assert.equal(r.body.error.code, 'NOT_REGISTERED');
  });
});

describe('approve and return', () => {
  test('the Asset Management Team approves; staff cannot review; a record is approved once', async () => {
    const a = await asset();
    assert.equal((await review(staffA, a, { action: 'approve' })).status, 403);
    const ok = await review(manager, a, { action: 'approve', note: 'Matches the invoice' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.review.status, 'approved');
    assert.equal(ok.body.review.last.by, 'Test ASSET_MANAGER');
    assert.equal(ok.body.registrationStatus, 'registered', 'registration status is separate');
    const again = await review(manager, ok.body, { action: 'approve' });
    assert.equal(again.body.error.code, 'NOT_AWAITING_REVIEW');
  });

  test('return for correction needs a reason; the record, its ID and QR code are kept', async () => {
    const a = await asset();
    assert.equal((await review(manager, a, { action: 'return', note: 'no' })).body.error.code, 'REASON_REQUIRED');
    const r = await review(manager, a, { action: 'return', note: 'Serial number does not match the plate', fields: ['serialNumber'] });
    assert.equal(r.status, 200);
    assert.equal(r.body.review.status, 'returned_for_correction');
    assert.deepEqual(r.body.review.last.fields, ['serialNumber']);
    assert.equal(r.body.review.last.note, 'Serial number does not match the plate');
    assert.deepEqual([r.body.id, r.body.institutionalId, r.body.qrPayload, r.body.registrationStatus], [a.id, a.institutionalId, a.qrPayload, 'registered']);
    const staffView = (await api(ctx.app, staffA)('GET', `/assets/${a.id}`)).body;
    assert.equal(staffView.can.submitCorrections, true);
    const returned = (await api(ctx.app, staffA)('GET', '/assets?review=returned_for_correction')).body.items.map((x: any) => x.id);
    assert.ok(returned.includes(a.id), 'the department sees what it must correct');
    assert.equal(await count(`SELECT count(*) AS n FROM assets WHERE serial_number = $1`, [a.serialNumber]), 1, 'no replacement record');
  });

  test('a stale review is refused', async () => {
    const a = await asset();
    await api(ctx.app, staffA)('PATCH', `/assets/${a.id}`, { notes: 'Updated', version: a.version });
    assert.equal((await review(manager, a, { action: 'approve' })).body.error.code, 'VERSION_CONFLICT');
  });
});

describe('corrections and re-review', () => {
  test('the department corrects the record; before/after values reach the reviewer; re-review approves it', async () => {
    const a = await asset();
    const returned = (await review(manager, a, { action: 'return', note: 'Serial and model are wrong', fields: ['serialNumber', 'model'] })).body;
    const early = await api(ctx.app, staffA)('POST', `/assets/${a.id}/corrections-done`, { version: returned.version });
    assert.equal(early.body.error.code, 'NOTE_REQUIRED', 'nothing changed and no explanation');
    const edited = (await api(ctx.app, staffA)('PATCH', `/assets/${a.id}`, { serialNumber: 'SN-CORRECT-1', model: 'BX-53', version: returned.version })).body;
    const done = await api(ctx.app, staffA)('POST', `/assets/${a.id}/corrections-done`, { version: edited.version, note: 'Checked against the plate' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.review.status, 'corrected_awaiting_rereview');
    const queue = (await api(ctx.app, manager)('GET', '/assets?review=corrected_awaiting_rereview')).body.items.map((x: any) => x.id);
    assert.ok(queue.includes(a.id));

    const approved = await review(manager, done.body, { action: 'approve', note: 'Corrected' });
    assert.equal(approved.body.review.status, 'approved');
    const history = (await api(ctx.app, staffA)('GET', `/assets/${a.id}/reviews`)).body.items;
    assert.deepEqual(history.map((h: any) => h.action), ['approved', 'corrections_submitted', 'returned']);
    assert.deepEqual(history[1].changes, { serialNumber: { before: a.serialNumber, after: 'SN-CORRECT-1' }, model: { before: null, after: 'BX-53' } });
    assert.equal(history[1].by, 'Test DEPARTMENT_STAFF');
    assert.deepEqual(history[2].fields, ['serialNumber', 'model']);
    assert.ok(history.every((h: any) => h.at && h.by));
  });

  test('only the responsible department can submit corrections', async () => {
    const a = await asset();
    const r = (await review(manager, a, { action: 'return', note: 'Wrong category used' })).body;
    assert.equal((await api(ctx.app, staffB)('POST', `/assets/${a.id}/corrections-done`, { version: r.version, note: 'Done here' })).status, 403);
    assert.equal((await api(ctx.app, manager)('POST', `/assets/${a.id}/corrections-done`, { version: r.version, note: 'Done here' })).status, 403);
    const ok = await api(ctx.app, staffA)('POST', `/assets/${a.id}/corrections-done`, { version: r.version, note: 'Category is right: it is lab equipment' });
    assert.equal(ok.status, 200, 'a correction can be explained without a change');
  });

  test('review history is append-only and hides costs from people without financial access', async () => {
    const a = await asset();
    const r = (await review(manager, a, { action: 'return', note: 'Cost looks wrong', fields: ['acquisitionCost'] })).body;
    const e = (await api(ctx.app, staffA)('PATCH', `/assets/${a.id}`, { acquisitionCost: '1450.00', version: r.version })).body;
    await api(ctx.app, staffA)('POST', `/assets/${a.id}/corrections-done`, { version: e.version });
    await assert.rejects(ctx.db.query(`UPDATE asset_reviews SET note = 'x' WHERE asset_id = $1`, [a.id]), /append-only/);
    await assert.rejects(ctx.db.query(`DELETE FROM asset_reviews WHERE asset_id = $1`, [a.id]), /append-only/);

    const g = await api(ctx.app, admin)('POST', `/users/${staffBId}/grants`, { departmentId: deptA, accessLevel: 'read', reason: 'Audit 2026 review' });
    const tb = await login(ctx.app, 'staff.b@uni.test');
    const hist = (await api(ctx.app, tb)('GET', `/assets/${a.id}/reviews`)).body.items;
    assert.equal(hist[0].action, 'corrections_submitted');
    assert.deepEqual(hist[0].changes, {}, 'the cost change is hidden');
    const full = (await api(ctx.app, staffA)('GET', `/assets/${a.id}/reviews`)).body.items;
    assert.deepEqual(full[0].changes, { acquisitionCost: { before: '1500.00', after: '1450.00' } });
    await api(ctx.app, admin)('POST', `/users/${staffBId}/grants/${g.body.id}/revoke`);
    const audit = await count(`SELECT count(*) AS n FROM audit_events WHERE entity_id = $1 AND action IN ('asset.review_return','asset.corrections_submitted')`, [a.id]);
    assert.equal(audit, 2);
  });
});

async function count(sql: string, params: unknown[]) {
  return Number((await ctx.db.query(sql, params)).rows[0].n);
}
