// Phase 3: verification scans, schedules (due / overdue), discrepancies, relocation history,
// missing status, review flags and permissions.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { api, createDepartment, createUser, login, setup, type TestCtx } from './helpers.ts';

let ctx: TestCtx;
let deptA: string;
let deptB: string;
let cat: string;
let cat2: string;
let locA1: string;
let locA2: string;
let locB1: string;
let admin: string;
let staffA: string;
let staffB: string;
let manager: string;
let staffAId: string;

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
const days = (n: number) => minutes(n * 24 * 60);

/** Creates an asset in department A (or B) and completes registration via the real API. */
async function registeredAsset(token = staffA, dept: 'A' | 'B' = 'A', over: Record<string, unknown> = {}) {
  const call = api(ctx.app, token);
  const c = await call('POST', '/assets', {
    name: 'Microscope',
    categoryId: cat,
    serialNumber: `SN-${randomUUID().slice(0, 8)}`,
    departmentId: dept === 'A' ? deptA : deptB,
    locationId: dept === 'A' ? locA1 : locB1,
    acquisitionDate: '2025-01-10',
    acquisitionMethod: 'purchase',
    costStatus: 'recorded',
    acquisitionCost: '800.00',
    currency: 'USD',
    condition: 'good',
    ...over,
  });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  await call('POST', `/assets/${c.body.id}/label-prints`, { layout: 'sheet' });
  const r = await call('POST', `/assets/${c.body.id}/confirm-label`, { code: c.body.qrPayload, method: 'scan' });
  assert.equal(r.status, 200);
  return r.body;
}

const verify = (token: string, id: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  ctx.app
    .inject({ method: 'POST', url: `/api/v1/assets/${id}/verifications`, payload: { method: 'scan', ...body }, headers: { authorization: `Bearer ${token}`, ...headers } })
    .then((r) => ({ status: r.statusCode, body: r.json() }));

const move = (token: string, id: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  ctx.app
    .inject({ method: 'POST', url: `/api/v1/assets/${id}/movements`, payload: body, headers: { authorization: `Bearer ${token}`, ...headers } })
    .then((r) => ({ status: r.statusCode, body: r.json() }));

const getAsset = async (id: string, token = staffA) => (await api(ctx.app, token)('GET', `/assets/${id}`)).body;
const shiftDates = (id: string, sql: string) => ctx.db.query(`UPDATE assets SET ${sql} WHERE id = $1`, [id]);

before(async () => {
  ctx = await setup();
  deptA = await createDepartment(ctx.db, 'AAA');
  deptB = await createDepartment(ctx.db, 'BBB');
  await createUser(ctx.db, 'admin@uni.test', 'SYSTEM_ADMIN');
  staffAId = await createUser(ctx.db, 'staff.a@uni.test', 'DEPARTMENT_STAFF', deptA);
  await createUser(ctx.db, 'staff.b@uni.test', 'DEPARTMENT_STAFF', deptB);
  await createUser(ctx.db, 'manager@uni.test', 'ASSET_MANAGER');
  admin = await login(ctx.app, 'admin@uni.test');
  staffA = await login(ctx.app, 'staff.a@uni.test');
  staffB = await login(ctx.app, 'staff.b@uni.test');
  manager = await login(ctx.app, 'manager@uni.test');
  await api(ctx.app, admin)('PUT', '/settings/institution_time_zone', { value: 'UTC' });
  cat = (await api(ctx.app, admin)('POST', '/categories', { name: 'Lab equipment' })).body.id;
  cat2 = (await api(ctx.app, admin)('POST', '/categories', { name: 'Furniture' })).body.id;
  locA1 = (await api(ctx.app, staffA)('POST', '/locations', { departmentId: deptA, building: 'Science', room: '101' })).body.id;
  locA2 = (await api(ctx.app, staffA)('POST', '/locations', { departmentId: deptA, building: 'Science', room: '102' })).body.id;
  locB1 = (await api(ctx.app, staffB)('POST', '/locations', { departmentId: deptB, building: 'Library', room: 'G1' })).body.id;
});
after(() => ctx.close());

describe('verification scans', () => {
  test('scanning a registered asset records who saw it, where and when', async () => {
    const a = await registeredAsset();
    assert.equal(a.verification.status, 'not_yet_verified');
    const r = await verify(staffA, a.id);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.verification.outcome, 'verified');
    assert.equal(r.body.verification.verifiedBy, 'Test DEPARTMENT_STAFF');
    assert.deepEqual(r.body.verification.observedLocation, { building: 'Science', room: '101', department: 'Test department AAA' });
    assert.ok(r.body.verification.receivedAt);
    assert.equal(r.body.asset.verification.status, 'verified');
    assert.ok(r.body.asset.verification.lastVerifiedAt);
    assert.equal(r.body.asset.verification.lastVerifiedLocation.room, '101');
    const audit = await ctx.db.query(`SELECT context FROM audit_events WHERE action = 'asset.verify' AND entity_id = $1`, [a.id]);
    assert.equal(audit.rows[0].context.outcome, 'verified');
  });

  test('only registered, non-archived assets can be verified', async () => {
    const c = await api(ctx.app, staffA)('POST', '/assets', {
      name: 'Unlabelled', categoryId: cat, serialNumber: 'U-1', departmentId: deptA, locationId: locA1, acquisitionDate: '2025-01-10',
      acquisitionMethod: 'purchase', costStatus: 'recorded', acquisitionCost: '10', currency: 'USD', condition: 'good',
    });
    const r = await verify(staffA, c.body.id);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'NOT_REGISTERED');
    const a = await registeredAsset();
    await api(ctx.app, admin)('POST', `/assets/${a.id}/archive`, { reason: 'Test archive' });
    assert.equal((await verify(staffA, a.id)).body.error.code, 'ARCHIVED');
  });

  test('other departments and the Asset Management Team cannot record verifications', async () => {
    const a = await registeredAsset();
    assert.equal((await verify(staffB, a.id)).status, 403);
    assert.equal((await verify(manager, a.id)).status, 403);
    const n = await ctx.db.query(`SELECT count(*)::int AS n FROM verification_events WHERE asset_id = $1`, [a.id]);
    assert.equal(n.rows[0].n, 0, 'unauthorised scans never count as verification');
  });

  test('an accidental double scan within 10 minutes is recorded once; a later scan counts again', async () => {
    const a = await registeredAsset();
    const t0 = minutes(-30);
    const first = await verify(staffA, a.id, { eventTime: t0 });
    const again = await verify(staffA, a.id, { eventTime: minutes(-25) });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.verification.id, first.body.verification.id);
    const later = await verify(staffA, a.id, { eventTime: minutes(-5) });
    assert.equal(later.status, 201);
    const n = await ctx.db.query(`SELECT count(*)::int AS n FROM verification_events WHERE asset_id = $1`, [a.id]);
    assert.equal(n.rows[0].n, 2);
  });

  test('a repeat scan still counts if the asset was moved or reported missing in between', async () => {
    const a = await registeredAsset();
    await verify(staffA, a.id, { observedLocationId: locA2, eventTime: minutes(-6) });
    // Moved since the first scan: the next scan at the same place is new information, not a duplicate.
    await move(staffA, a.id, { toLocationId: locA2, eventTime: minutes(-5) });
    const afterMove = await verify(staffA, a.id, { observedLocationId: locA2, eventTime: minutes(-4) });
    assert.equal(afterMove.status, 201);
    assert.equal(afterMove.body.duplicate, false);
    assert.equal(afterMove.body.verification.outcome, 'verified', 'now seen where it is recorded');
    // Reported missing since the last scan: scanning it again must mark it found.
    await api(ctx.app, staffA)('POST', `/assets/${a.id}/report-missing`, { reason: 'Could not find it at the check' });
    const found = await verify(staffA, a.id, { observedLocationId: locA2, eventTime: minutes(-2) });
    assert.equal(found.status, 201);
    assert.equal(found.body.duplicate, false);
    assert.equal(found.body.asset.missing.status, 'none');
  });

  test('a retried submission with the same operation id is not recorded twice', async () => {
    const a = await registeredAsset();
    const op = randomUUID();
    const r1 = await verify(staffA, a.id, {}, { 'x-operation-id': op });
    const r2 = await verify(staffA, a.id, { eventTime: minutes(1) }, { 'x-operation-id': op });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.verification.id, r1.body.verification.id);
  });

  test('event time vs received time: future times refused, older offline scans never hide newer ones', async () => {
    const a = await registeredAsset();
    assert.equal((await verify(staffA, a.id, { eventTime: minutes(30) })).body.error.code, 'EVENT_IN_FUTURE');
    const newer = await verify(staffA, a.id, { eventTime: days(-1) });
    const older = await verify(staffA, a.id, { eventTime: days(-3) });
    assert.equal(older.status, 201);
    const now = await getAsset(a.id);
    assert.equal(now.verification.lastVerifiedAt, newer.body.verification.eventTime, 'latest sighting stays the newest one');
    assert.notEqual(older.body.verification.eventTime, older.body.verification.receivedAt, 'actual time and server time are kept separately');
  });

  test('events reported more than 7 days late are flagged for review', async () => {
    const a = await registeredAsset();
    await verify(staffA, a.id, { eventTime: days(-10) });
    const f = await ctx.db.query(`SELECT kind FROM asset_flags WHERE asset_id = $1`, [a.id]);
    assert.deepEqual(f.rows.map((r) => r.kind), ['late_event']);
  });

  test('seen somewhere else: flagged as a discrepancy; location only changes if staff choose to move it', async () => {
    const a = await registeredAsset();
    const r = await verify(staffA, a.id, { observedLocationId: locA2 });
    assert.equal(r.body.verification.outcome, 'location_discrepancy');
    assert.equal(r.body.asset.location.id, locA1, 'a sighting alone does not move the asset');
    assert.equal(r.body.asset.verification.status, 'verified', 'it was still physically seen');
    const flags = await ctx.db.query(`SELECT kind, details FROM asset_flags WHERE asset_id = $1`, [a.id]);
    assert.equal(flags.rows[0].kind, 'location_discrepancy');
    assert.equal(flags.rows[0].details.observed, 'Science, 102');

    const b = await registeredAsset();
    const r2 = await verify(staffA, b.id, { observedLocationId: locA2, alsoMoveHere: true });
    assert.equal(r2.body.asset.location.id, locA2);
    const mv = await api(ctx.app, staffA)('GET', `/assets/${b.id}/movements`);
    assert.equal(mv.body.items.length, 1);
    assert.equal(mv.body.items[0].source, 'verification');
    assert.deepEqual(mv.body.items[0].from, { building: 'Science', room: '101', department: 'Test department AAA' });
  });
});

describe('schedules and due / overdue', () => {
  let globalId: string;

  test('only administrators manage schedules; rules are validated', async () => {
    assert.equal((await api(ctx.app, staffA)('POST', '/verification-schedules', { departmentId: null, categoryId: null, intervalDays: 30, dueWindowDays: 7 })).status, 403);
    assert.equal((await api(ctx.app, manager)('POST', '/verification-schedules', { departmentId: null, categoryId: null, intervalDays: 30, dueWindowDays: 7 })).status, 403);
    const bad = await api(ctx.app, admin)('POST', '/verification-schedules', { departmentId: null, categoryId: null, intervalDays: 7, dueWindowDays: 7 });
    assert.equal(bad.status, 400);
    const ok = await api(ctx.app, admin)('POST', '/verification-schedules', { departmentId: null, categoryId: null, intervalDays: 30, dueWindowDays: 7, notes: 'Monthly' });
    assert.equal(ok.status, 201);
    globalId = ok.body.id;
    assert.equal((await api(ctx.app, admin)('POST', '/verification-schedules', { departmentId: null, categoryId: null, intervalDays: 90, dueWindowDays: 7 })).status, 409);
    const list = await api(ctx.app, staffA)('GET', '/verification-schedules');
    assert.equal(list.body.items[0].intervalDays, 30);
  });

  test('due date = last verification (or registration) + interval; due within the window; overdue after', async () => {
    const a = await registeredAsset();
    await shiftDates(a.id, `registered_at = now() - interval '5 days', last_verified_at = NULL`);
    let s = (await getAsset(a.id)).verification;
    assert.equal(s.status, 'not_yet_verified');
    assert.equal(s.intervalDays, 30);
    await shiftDates(a.id, `registered_at = now() - interval '25 days'`);
    s = (await getAsset(a.id)).verification;
    assert.equal(s.status, 'due', 'inside the 7-day window before the due date');
    await shiftDates(a.id, `registered_at = now() - interval '40 days'`);
    s = (await getAsset(a.id)).verification;
    assert.equal(s.status, 'overdue');
    assert.equal(s.overdueDays, 10);
    const asset = await getAsset(a.id);
    assert.equal(asset.missing.status, 'none', 'overdue never means missing');
    await verify(staffA, a.id);
    s = (await getAsset(a.id)).verification;
    assert.equal(s.status, 'verified');
    const expected = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    assert.equal(s.dueDate, expected);
  });

  test('the most specific schedule wins (department + category beats institution-wide)', async () => {
    const a = await registeredAsset();
    const b = await registeredAsset(staffA, 'A', { categoryId: cat2 });
    const sp = await api(ctx.app, admin)('POST', '/verification-schedules', { departmentId: deptA, categoryId: cat, intervalDays: 7, dueWindowDays: 2 });
    assert.equal(sp.status, 201);
    assert.equal((await getAsset(a.id)).verification.intervalDays, 7);
    assert.equal((await getAsset(b.id)).verification.intervalDays, 30, 'other category keeps the general rule');
    // Deactivating a rule falls back to the general one; the history is untouched.
    await api(ctx.app, admin)('PATCH', `/verification-schedules/${sp.body.id}`, { isActive: false });
    assert.equal((await getAsset(a.id)).verification.intervalDays, 30);
    const audit = await ctx.db.query(`SELECT action FROM audit_events WHERE entity_type = 'verification_schedule' ORDER BY id`);
    assert.deepEqual(audit.rows.map((r) => r.action), ['schedule.create', 'schedule.create', 'schedule.update']);
  });

  test('asset list filters by verification status and sorts most overdue first', async () => {
    const late = await registeredAsset(staffA, 'A', { name: 'Very overdue' });
    await shiftDates(late.id, `registered_at = now() - interval '200 days', last_verified_at = NULL`);
    const over = await api(ctx.app, staffA)('GET', '/assets?verification=overdue&sort=most_overdue&pageSize=100');
    assert.ok(over.body.items.length >= 1);
    assert.ok(over.body.items.every((x: any) => x.verification.status === 'overdue'));
    assert.equal(over.body.items[0].name, 'Very overdue');
    const both = await api(ctx.app, staffA)('GET', '/assets?verification=due_or_overdue&pageSize=100');
    assert.ok(both.body.items.every((x: any) => ['due', 'overdue'].includes(x.verification.status)));
    await api(ctx.app, admin)('PATCH', `/verification-schedules/${globalId}`, { isActive: false });
    const none = await api(ctx.app, staffA)('GET', '/assets?verification=overdue');
    assert.equal(none.body.total, 0, 'without any schedule nothing is overdue');
    await api(ctx.app, admin)('PATCH', `/verification-schedules/${globalId}`, { isActive: true });
  });

  test('time zone: dates follow the institution setting (Port Moresby is UTC+10)', async () => {
    const a = await registeredAsset();
    // 20:00 UTC on 10 January is already 06:00 on 11 January in Port Moresby.
    await shiftDates(a.id, `last_verified_at = '2026-01-10T20:00:00Z'`);
    assert.equal((await getAsset(a.id)).verification.dueDate, '2026-02-09', 'UTC: 10 Jan + 30 days');
    await api(ctx.app, admin)('PUT', '/settings/institution_time_zone', { value: 'Pacific/Port_Moresby' });
    assert.equal((await getAsset(a.id)).verification.dueDate, '2026-02-10', 'Port Moresby: 11 Jan + 30 days');
    await api(ctx.app, admin)('PUT', '/settings/institution_time_zone', { value: 'UTC' });
  });
});

describe('relocation and movement history', () => {
  test('a move updates the current location and keeps the previous one in history', async () => {
    const a = await registeredAsset();
    const r = await move(staffA, a.id, { toLocationId: locA2, reason: 'Lab reorganised' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.asset.location.id, locA2);
    assert.deepEqual(r.body.movement.from, { building: 'Science', room: '101', department: 'Test department AAA' });
    assert.deepEqual(r.body.movement.to, { building: 'Science', room: '102', department: 'Test department AAA' });
    assert.equal((await move(staffA, a.id, { toLocationId: locA2 })).status, 400, 'already there');
    const back = await move(staffA, a.id, { toLocationId: locA1 });
    assert.equal(back.status, 201);
    const hist = await api(ctx.app, staffA)('GET', `/assets/${a.id}/movements`);
    assert.equal(hist.body.items.length, 2);
    assert.equal(r.body.asset.verification.lastVerifiedAt, null, 'a move is not a verification');
  });

  test('moving to another department needs permission there and a reason, and is flagged', async () => {
    const a = await registeredAsset();
    assert.equal((await move(staffA, a.id, { toLocationId: locB1, reason: 'Loan' })).status, 403);
    const g = await api(ctx.app, admin)('POST', `/users/${staffAId}/grants`, { departmentId: deptB, accessLevel: 'operate', reason: 'Joint project 2026' });
    const t = await login(ctx.app, 'staff.a@uni.test');
    assert.equal((await move(t, a.id, { toLocationId: locB1 })).status, 400, 'reason required');
    const r = await move(t, a.id, { toLocationId: locB1, reason: 'Transferred to Library' });
    assert.equal(r.status, 201);
    assert.equal(r.body.asset.department.id, deptB, 'ownership follows the move');
    const f = await ctx.db.query(`SELECT kind, department_id FROM asset_flags WHERE asset_id = $1`, [a.id]);
    assert.equal(f.rows[0].kind, 'cross_department_move');
    assert.equal(f.rows[0].department_id, deptB);
    await api(ctx.app, admin)('POST', `/users/${staffAId}/grants/${g.body.id}/revoke`);
    staffA = await login(ctx.app, 'staff.a@uni.test');
    assert.equal((await api(ctx.app, staffA)('GET', `/assets/${a.id}`)).status, 403, 'once moved, it belongs to the other department');
  });

  test('unregistered assets are corrected with Edit, not Relocate; asset managers cannot relocate', async () => {
    const c = await api(ctx.app, staffA)('POST', '/assets', {
      name: 'Not yet', categoryId: cat, serialNumber: 'NY-1', departmentId: deptA, locationId: locA1, acquisitionDate: '2025-01-10',
      acquisitionMethod: 'purchase', costStatus: 'recorded', acquisitionCost: '10', currency: 'USD', condition: 'good',
    });
    assert.equal((await move(staffA, c.body.id, { toLocationId: locA2 })).body.error.code, 'USE_EDIT');
    const a = await registeredAsset();
    assert.equal((await move(manager, a.id, { toLocationId: locA2 })).status, 403);
    const edit = await api(ctx.app, staffA)('PATCH', `/assets/${a.id}`, { version: a.version, locationId: locA2 });
    assert.equal(edit.body.error.code, 'USE_WORKFLOW');
    assert.match(edit.body.error.message, /Relocate/);
  });

  test('retries are not recorded twice; an older late-arriving move does not overwrite a newer one', async () => {
    const a = await registeredAsset();
    const op = randomUUID();
    const r1 = await move(staffA, a.id, { toLocationId: locA2 }, { 'x-operation-id': op });
    const r2 = await move(staffA, a.id, { toLocationId: locA2 }, { 'x-operation-id': op });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.movement.id, r1.body.movement.id);
    const old = await move(staffA, a.id, { toLocationId: locA1, eventTime: days(-2) });
    assert.equal(old.status, 201);
    assert.equal(old.body.asset.location.id, locA2, 'current location keeps the newer move');
    const f = await ctx.db.query(`SELECT kind FROM asset_flags WHERE asset_id = $1`, [a.id]);
    assert.ok(f.rows.some((x) => x.kind === 'late_event'));
    const hist = await api(ctx.app, staffA)('GET', `/assets/${a.id}/movements`);
    assert.equal(hist.body.items.length, 2, 'both moves are in the history');
  });
});

describe('missing assets and review flags', () => {
  test('staff report missing; only oversight roles confirm; a later scan marks it found and flags it', async () => {
    const a = await registeredAsset();
    assert.equal((await api(ctx.app, staffA)('POST', `/assets/${a.id}/report-missing`, { reason: 'x' })).status, 400);
    const r = await api(ctx.app, staffA)('POST', `/assets/${a.id}/report-missing`, { reason: 'Not in room 101 at stock-take' });
    assert.equal(r.status, 200);
    assert.equal(r.body.missing.status, 'reported_missing');
    assert.equal((await api(ctx.app, staffA)('POST', `/assets/${a.id}/report-missing`, { reason: 'Again please' })).status, 409);
    assert.equal((await api(ctx.app, staffA)('POST', `/assets/${a.id}/confirm-missing`, { note: 'I am sure' })).status, 403);
    const c = await api(ctx.app, manager)('POST', `/assets/${a.id}/confirm-missing`, { note: 'Searched all labs' });
    assert.equal(c.status, 200);
    assert.equal(c.body.missing.status, 'confirmed_missing');
    const reportFlag = await ctx.db.query(`SELECT status FROM asset_flags WHERE asset_id = $1 AND kind = 'reported_missing'`, [a.id]);
    assert.equal(reportFlag.rows[0].status, 'resolved', 'the report is answered by the decision');
    const found = await verify(staffA, a.id);
    assert.equal(found.body.asset.missing.status, 'none');
    const ff = await ctx.db.query(`SELECT details FROM asset_flags WHERE asset_id = $1 AND kind = 'found_after_missing'`, [a.id]);
    assert.equal(ff.rows[0].details.previousStatus, 'confirmed_missing');
    const actions = await ctx.db.query(`SELECT action FROM audit_events WHERE entity_id = $1 AND action LIKE 'asset.%missing' ORDER BY id`, [a.id]);
    assert.deepEqual(actions.rows.map((x) => x.action), ['asset.report_missing', 'asset.confirm_missing']);
  });

  test('a reviewer can clear a missing report without a scan', async () => {
    const a = await registeredAsset();
    await api(ctx.app, staffA)('POST', `/assets/${a.id}/report-missing`, { reason: 'Could not find it' });
    const r = await api(ctx.app, admin)('POST', `/assets/${a.id}/clear-missing`, { note: 'Was out for repair' });
    assert.equal(r.body.missing.status, 'none');
    const list = await api(ctx.app, staffA)('GET', '/assets?missing=any&pageSize=100');
    assert.ok(!list.body.items.some((x: any) => x.id === a.id));
  });

  test('flags: staff see their own department’s, only reviewers resolve them, with a note', async () => {
    const a = await registeredAsset();
    await verify(staffA, a.id, { observedLocationId: locA2 });
    const mine = await api(ctx.app, staffA)('GET', `/flags?assetId=${a.id}`);
    assert.equal(mine.body.total, 1);
    assert.equal(mine.body.items[0].canResolve, false);
    const others = await api(ctx.app, staffB)('GET', `/flags?assetId=${a.id}`);
    assert.equal(others.body.total, 0, 'other departments do not see them');
    const id = mine.body.items[0].id;
    assert.equal((await api(ctx.app, staffA)('POST', `/flags/${id}/resolve`, { note: 'Fixed it' })).status, 403);
    assert.equal((await api(ctx.app, manager)('POST', `/flags/${id}/resolve`, { note: '' })).status, 400);
    const ok = await api(ctx.app, manager)('POST', `/flags/${id}/resolve`, { note: 'Moved back to 101' });
    assert.equal(ok.status, 200);
    assert.equal((await api(ctx.app, manager)('POST', `/flags/${id}/resolve`, { note: 'Again' })).status, 409);
    const resolved = await api(ctx.app, manager)('GET', `/flags?assetId=${a.id}&status=resolved`);
    assert.equal(resolved.body.items[0].resolvedBy, 'Test ASSET_MANAGER');
    assert.equal(resolved.body.items[0].resolutionNote, 'Moved back to 101');
    assert.equal((await getAsset(a.id)).openFlags, 0);
  });
});
