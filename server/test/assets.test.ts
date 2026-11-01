// Phase 2: asset registration, validation, identity, duplicates, labels, permissions, audit.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { api, createDepartment, createUser, login, setup, type TestCtx } from './helpers.ts';

let ctx: TestCtx;
let deptA: string;
let deptB: string;
let catLaptop: string;
let locA: string;
let locA2: string;
let locB: string;
let admin: string;
let staffA: string;
let staffB: string;
let manager: string;
let staffAId: string;

// IDs carry the registration year (institution time zone is UTC in these tests).
const YEAR = new Date().getUTCFullYear();

const asset = (over: Record<string, unknown> = {}) => ({
  name: 'Dell Latitude 5440 laptop',
  categoryId: catLaptop,
  manufacturer: 'Dell',
  model: 'Latitude 5440',
  serialNumber: `SN-${randomUUID().slice(0, 8)}`,
  manufacturerBarcode: '0884116412345',
  departmentId: deptA,
  locationId: locA,
  acquisitionDate: '2026-03-14',
  acquisitionMethod: 'purchase',
  costStatus: 'recorded',
  acquisitionCost: '1250.00',
  currency: 'USD',
  condition: 'excellent',
  ...over,
});

const create = (token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  ctx.app
    .inject({ method: 'POST', url: '/api/v1/assets', payload: body, headers: { authorization: `Bearer ${token}`, ...headers } })
    .then((r) => ({ status: r.statusCode, body: r.json(), headers: r.headers }));

/** Prints the label and confirms attachment, completing registration. */
async function register(token: string, a: { id: string; qrPayload: string }) {
  const call = api(ctx.app, token);
  assert.equal((await call('POST', `/assets/${a.id}/label-prints`, { copies: 1, layout: 'sheet' })).status, 201);
  const r = await call('POST', `/assets/${a.id}/confirm-label`, { code: a.qrPayload, method: 'scan' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

before(async () => {
  ctx = await setup();
  deptA = await createDepartment(ctx.db, 'AAA', 'USD');
  deptB = await createDepartment(ctx.db, 'BBB', 'EUR');
  await createUser(ctx.db, 'admin@uni.test', 'SYSTEM_ADMIN');
  staffAId = await createUser(ctx.db, 'staff.a@uni.test', 'DEPARTMENT_STAFF', deptA);
  await createUser(ctx.db, 'staff.b@uni.test', 'DEPARTMENT_STAFF', deptB);
  await createUser(ctx.db, 'manager@uni.test', 'ASSET_MANAGER');
  admin = await login(ctx.app, 'admin@uni.test');
  staffA = await login(ctx.app, 'staff.a@uni.test');
  staffB = await login(ctx.app, 'staff.b@uni.test');
  manager = await login(ctx.app, 'manager@uni.test');
  await api(ctx.app, admin)('PUT', '/settings/institution_time_zone', { value: 'UTC' });
});
after(() => ctx.close());

describe('reference data', () => {
  test('only admins manage categories; names are unique ignoring case', async () => {
    assert.equal((await api(ctx.app, staffA)('POST', '/categories', { name: 'Laptops' })).status, 403);
    assert.equal((await api(ctx.app, manager)('POST', '/categories', { name: 'Laptops' })).status, 403);
    const c = await api(ctx.app, admin)('POST', '/categories', { name: 'Laptops' });
    assert.equal(c.status, 201);
    catLaptop = c.body.id;
    assert.equal((await api(ctx.app, admin)('POST', '/categories', { name: 'laptops' })).status, 409);
    const list = await api(ctx.app, staffA)('GET', '/categories');
    assert.deepEqual(list.body.items.map((x: any) => x.name), ['Laptops']);
  });

  test('staff add locations in their own department only; duplicates refused', async () => {
    const own = await api(ctx.app, staffA)('POST', '/locations', { departmentId: deptA, building: 'Science Block', room: '101' });
    assert.equal(own.status, 201);
    locA = own.body.id;
    locA2 = (await api(ctx.app, staffA)('POST', '/locations', { departmentId: deptA, building: 'Science Block', room: '102' })).body.id;
    assert.equal((await api(ctx.app, staffA)('POST', '/locations', { departmentId: deptA, building: 'science block', room: '101' })).status, 409);
    assert.equal((await api(ctx.app, staffA)('POST', '/locations', { departmentId: deptB, building: 'Library', room: 'G1' })).status, 403);
    assert.equal((await api(ctx.app, manager)('POST', '/locations', { departmentId: deptB, building: 'Library', room: 'G1' })).status, 403);
    locB = (await api(ctx.app, staffB)('POST', '/locations', { departmentId: deptB, building: 'Library', room: 'G1' })).body.id;
    const seen = await api(ctx.app, staffA)('GET', '/locations');
    assert.ok(seen.body.items.every((l: any) => l.departmentId === deptA), 'staff only see own department locations');
    assert.equal((await api(ctx.app, staffA)('GET', `/locations?departmentId=${deptB}`)).status, 403);
  });
});

describe('registration', () => {
  test('creates an asset with a server-assigned ID and QR payload, awaiting its label', async () => {
    const r = await create(staffA, asset({ name: '  Projector  ', description: 'Room 101 ceiling unit' }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.institutionalId, new RegExp(`^UAT-${YEAR}-\\d{6}$`));
    assert.equal(r.body.qrPayload, `UATS:${r.body.institutionalId}`);
    assert.equal(r.body.name, 'Projector', 'text is trimmed');
    assert.equal(r.body.registrationStatus, 'awaiting_label');
    assert.equal(r.body.financial.acquisitionCost, '1250.00');
    assert.equal(r.body.financial.currency, 'USD');
    assert.equal(r.body.department.id, deptA);
    assert.equal(r.body.location.room, '101');
  });

  test('the client cannot choose the asset ID or status', async () => {
    // Only an ID the server reserved for this person (offline registration, Phase 6) is accepted.
    const r = await create(staffA, { ...asset(), institutionalId: 'UAT-2026-999999' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'RESERVED_ID_INVALID');
    const r2 = await create(staffA, { ...asset(), registrationStatus: 'registered' });
    assert.equal(r2.status, 400);
  });

  test('IDs are sequential and stay unique under concurrent registration', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, () => create(staffA, asset())));
    assert.ok(results.every((r) => r.status === 201));
    const ids = results.map((r) => r.body.institutionalId);
    assert.equal(new Set(ids).size, 25);
    const nums = ids.map((i) => Number(i.split('-')[2])).sort((a, b) => a - b);
    assert.equal(nums[24] - nums[0], 24, 'no gaps or repeats within the batch');
  });

  test('the database itself rejects a duplicate institutional ID', async () => {
    const { rows } = await ctx.db.query(`SELECT * FROM assets LIMIT 1`);
    const a = rows[0];
    await assert.rejects(
      ctx.db.query(
        `INSERT INTO assets (institutional_id, qr_payload, name, category_id, serial_number, owning_department_id, location_id,
           acquisition_date, acquisition_method, acquisition_cost, currency, cost_status, condition, registration_status, created_by)
         VALUES ($1,$2,'Copy',$3,'X',$4,$5,'2026-01-01','purchase',1,'USD','recorded','good','awaiting_label',$6)`,
        [a.institutional_id, a.qr_payload, a.category_id, a.owning_department_id, a.location_id, a.created_by],
      ),
      /duplicate key|unique/i,
    );
  });

  test('missing required fields are reported per field', async () => {
    const r = await create(staffA, { departmentId: deptA });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
    const paths = r.body.error.details.map((d: any) => d.path);
    for (const f of ['name', 'categoryId', 'locationId', 'acquisitionDate', 'acquisitionMethod', 'costStatus', 'currency', 'condition']) {
      assert.ok(paths.includes(f), `expected an error for ${f}; got ${paths}`);
    }
    assert.ok(!paths.includes('serialNumber'), 'the serial number is optional (no longer asked for)');
  });

  test('an asset can be registered without a serial number; no duplicate warning without one', async () => {
    const { serialNumber: _omit, ...noSerial } = asset({ manufacturerBarcode: '4006381333931' });
    const a = await create(staffA, noSerial);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.serialNumber, null);
    const b = await create(staffA, noSerial);
    assert.equal(b.status, 201, 'same barcode (same model) without serials is not treated as a duplicate');
  });

  test('dates must be real and not in the future; warranty cannot precede acquisition', async () => {
    const bad = await create(staffA, asset({ acquisitionDate: '2026-02-30' }));
    assert.equal(bad.status, 400);
    const future = await create(staffA, asset({ acquisitionDate: '2099-01-01' }));
    assert.equal(future.body.error.details[0].path, 'acquisitionDate');
    const warranty = await create(staffA, asset({ warrantyExpiry: '2025-01-01' }));
    assert.equal(warranty.body.error.details[0].path, 'warrantyExpiry');
    const historical = await create(staffA, asset({ acquisitionDate: '1998-06-01' }));
    assert.equal(historical.status, 201, 'legitimate historical dates are accepted');
  });

  test('money is validated as a decimal with an explicit currency', async () => {
    for (const bad of ['12.345', '-5', 'abc', '1e5']) {
      const r = await create(staffA, asset({ acquisitionCost: bad }));
      assert.equal(r.status, 400, `cost ${bad} should be rejected`);
    }
    const r = await create(staffA, asset({ acquisitionCost: '1,999.5', currency: 'eur' }));
    assert.equal(r.status, 201);
    assert.equal(r.body.financial.acquisitionCost, '1999.50');
    assert.equal(r.body.financial.currency, 'EUR');
    assert.equal((await create(staffA, asset({ currency: 'EURO' }))).status, 400);
  });

  test('cost policy: recorded > 0, verified zero, and audited unknown-cost exception for donations', async () => {
    assert.equal((await create(staffA, asset({ acquisitionCost: '0' }))).status, 400, 'recorded cost of zero refused');
    const zero = await create(staffA, asset({ acquisitionMethod: 'donation', costStatus: 'verified_zero', acquisitionCost: null }));
    assert.equal(zero.status, 201);
    assert.equal(zero.body.financial.acquisitionCost, '0.00');
    const noReason = await create(staffA, asset({ acquisitionMethod: 'donation', costStatus: 'unknown_exception', acquisitionCost: null }));
    assert.equal(noReason.body.error.details[0].path, 'costExceptionReason');
    const unknown = await create(
      staffA,
      asset({ acquisitionMethod: 'donation', costStatus: 'unknown_exception', acquisitionCost: null, costExceptionReason: 'Donor did not provide a value' }),
    );
    assert.equal(unknown.status, 201);
    assert.equal(unknown.body.financial.acquisitionCost, null, 'unknown cost is never stored as zero');
    const a = await ctx.db.query(`SELECT context FROM audit_events WHERE action = 'asset.create' AND entity_id = $1`, [unknown.body.id]);
    assert.equal(a.rows[0].context.costExceptionReason, 'Donor did not provide a value');
    // Policy switch: institution requires a cost.
    await api(ctx.app, admin)('PUT', '/settings/allow_unknown_cost', { value: false });
    const refused = await create(staffA, asset({ costStatus: 'unknown_exception', acquisitionCost: null, costExceptionReason: 'Donor did not say' }));
    assert.equal(refused.body.error.details[0].path, 'costStatus');
    await api(ctx.app, admin)('PUT', '/settings/allow_unknown_cost', { value: true });
  });

  test('donations need no purchase order; supplier and PO are optional', async () => {
    const r = await create(staffA, asset({ acquisitionMethod: 'donation', supplier: null, purchaseOrderRef: null }));
    assert.equal(r.status, 201);
  });

  test('location must belong to the asset’s department; category must be active', async () => {
    const r = await create(staffA, asset({ locationId: locB }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error.details[0].path, 'locationId');
    const c = await api(ctx.app, admin)('POST', '/categories', { name: 'Old stuff' });
    await api(ctx.app, admin)('PATCH', `/categories/${c.body.id}`, { isActive: false });
    const r2 = await create(staffA, asset({ categoryId: c.body.id }));
    assert.equal(r2.body.error.details[0].path, 'categoryId');
  });
});

describe('duplicates', () => {
  test('same serial number is flagged; staff may confirm a genuinely separate unit (audited)', async () => {
    const first = await create(staffA, asset({ serialNumber: 'DUP-123' }));
    assert.equal(first.status, 201);
    const second = await create(staffA, asset({ serialNumber: 'dup-123' }));
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'POSSIBLE_DUPLICATE');
    assert.equal(second.body.error.details.matches[0].institutionalId, first.body.institutionalId);
    const confirmed = await create(staffA, asset({ serialNumber: 'dup-123', confirmNotDuplicate: true }));
    assert.equal(confirmed.status, 201);
    const a = await ctx.db.query(`SELECT context FROM audit_events WHERE action = 'asset.create' AND entity_id = $1`, [confirmed.body.id]);
    assert.deepEqual(a.rows[0].context.duplicateConfirmed, [first.body.institutionalId]);
  });

  test('same serial from a different manufacturer is not a duplicate', async () => {
    await create(staffA, asset({ serialNumber: 'X-1', manufacturer: 'HP' }));
    const r = await create(staffA, asset({ serialNumber: 'X-1', manufacturer: 'Lenovo' }));
    assert.equal(r.status, 201);
  });

  test('shared manufacturer barcode (same model) never blocks registration', async () => {
    const r = await create(staffA, asset({ manufacturerBarcode: '5012345678900' }));
    const r2 = await create(staffA, asset({ manufacturerBarcode: '5012345678900' }));
    assert.equal(r.status, 201);
    assert.equal(r2.status, 201);
    assert.notEqual(r.body.institutionalId, r2.body.institutionalId);
    const check = await api(ctx.app, staffA)('POST', '/assets/check-duplicates', { serialNumber: 'brand-new', manufacturerBarcode: '5012345678900' });
    assert.equal(check.body.matches.length, 0);
    assert.equal(check.body.sameBarcodeCount, 2);
  });

  test('simultaneous submissions with the same operation id return one asset, never an error', async () => {
    const op = randomUUID();
    const body = asset();
    const results = await Promise.all([1, 2, 3].map(() => create(staffA, body, { 'x-operation-id': op })));
    assert.deepEqual(results.map((r) => r.status), [201, 201, 201]);
    assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
    const n = await ctx.db.query(`SELECT count(*)::int AS n FROM assets WHERE serial_number = $1`, [body.serialNumber]);
    assert.equal(n.rows[0].n, 1);
  });

  test('a failed submission does not use up its operation id', async () => {
    const op = randomUUID();
    const bad = await create(staffA, asset({ acquisitionDate: '2099-01-01' }), { 'x-operation-id': op });
    assert.equal(bad.status, 400);
    const good = await create(staffA, asset(), { 'x-operation-id': op });
    assert.equal(good.status, 201, 'the corrected retry is processed, not replayed as an error');
  });

  test('a retried submission with the same operation id creates the asset only once', async () => {
    const op = randomUUID();
    const body = asset();
    const a = await create(staffA, body, { 'x-operation-id': op });
    const b = await create(staffA, body, { 'x-operation-id': op });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(b.headers['idempotent-replay'], 'true');
    assert.equal(a.body.id, b.body.id);
    const n = await ctx.db.query(`SELECT count(*)::int AS n FROM assets WHERE serial_number = $1`, [body.serialNumber]);
    assert.equal(n.rows[0].n, 1);
    const other = await create(staffB, asset({ departmentId: deptB, locationId: locB }), { 'x-operation-id': op });
    assert.equal(other.status, 409, 'operation id cannot be reused by someone else');
  });
});

describe('permissions', () => {
  test('staff cannot register into another department; denial is audited', async () => {
    const r = await create(staffA, asset({ departmentId: deptB, locationId: locB }));
    assert.equal(r.status, 403);
    const a = await ctx.db.query(`SELECT 1 FROM audit_events WHERE action = 'authz.denied' AND entity_id = 'assets.register' AND actor_user_id = $1`, [staffAId]);
    assert.ok(a.rows.length >= 1);
  });

  test('asset managers can view all departments but cannot register, edit or print', async () => {
    const r = await create(manager, asset());
    assert.equal(r.status, 403);
    const list = await api(ctx.app, manager)('GET', '/assets?pageSize=100');
    assert.ok(list.body.total > 0);
    const someA = list.body.items.find((x: any) => x.department.id === deptA);
    assert.ok(someA.financial, 'managers see financial details');
    assert.equal(someA.can.edit, false);
    assert.equal((await api(ctx.app, manager)('PATCH', `/assets/${someA.id}`, { version: someA.version, name: 'Renamed' })).status, 403);
    assert.equal((await api(ctx.app, manager)('POST', `/assets/${someA.id}/label-prints`, { layout: 'sheet' })).status, 403);
  });

  test('staff only see their own department’s assets', async () => {
    const b = await create(staffB, asset({ departmentId: deptB, locationId: locB, currency: 'EUR', name: 'Library scanner' }));
    assert.equal(b.status, 201);
    const listA = await api(ctx.app, staffA)('GET', '/assets?pageSize=100');
    assert.ok(listA.body.items.every((x: any) => x.department.id === deptA));
    assert.equal((await api(ctx.app, staffA)('GET', `/assets/${b.body.id}`)).status, 403);
    assert.equal((await api(ctx.app, staffA)('GET', `/assets/${b.body.id}/history`)).status, 403);
    assert.equal((await api(ctx.app, staffA)('PATCH', `/assets/${b.body.id}`, { version: 1, name: 'Hijacked' })).status, 403);
    assert.equal((await api(ctx.app, staffA)('GET', `/assets?departmentId=${deptB}`)).body.total, 0, 'filtering to another department returns nothing');
  });

  test('duplicate warnings do not reveal the names of other departments’ assets', async () => {
    const secret = await create(staffB, asset({ departmentId: deptB, locationId: locB, currency: 'EUR', name: 'Confidential prototype', serialNumber: 'CROSS-1' }));
    assert.equal(secret.status, 201);
    const probe = await api(ctx.app, staffA)('POST', '/assets/check-duplicates', { serialNumber: 'CROSS-1' });
    assert.equal(probe.body.matches.length, 1);
    assert.equal(probe.body.matches[0].name, null);
    assert.equal(probe.body.matches[0].institutionalId, secret.body.institutionalId, 'ID and department are enough to resolve it');
    assert.ok(!JSON.stringify(probe.body).includes('Confidential'));
    const attempt = await create(staffA, asset({ serialNumber: 'CROSS-1' }));
    assert.equal(attempt.status, 409);
    assert.equal(attempt.body.error.details.matches[0].name, null);
    assert.ok(!JSON.stringify(attempt.body).includes('Confidential'));
    // Within the user's own department the name is shown.
    const own = await api(ctx.app, staffB)('POST', '/assets/check-duplicates', { serialNumber: 'CROSS-1' });
    assert.equal(own.body.matches[0].name, 'Confidential prototype');
  });

  test('a read-only grant shows another department’s assets without financial details', async () => {
    const g = await api(ctx.app, admin)('POST', `/users/${staffAId}/grants`, { departmentId: deptB, accessLevel: 'read', reason: 'Joint audit 2026' });
    assert.equal(g.status, 201);
    const t = await login(ctx.app, 'staff.a@uni.test');
    const list = await api(ctx.app, t)('GET', `/assets?departmentId=${deptB}`);
    assert.ok(list.body.total >= 1);
    const scanner = list.body.items.find((x: any) => x.name === 'Library scanner');
    assert.ok(scanner, 'the department B asset is visible through the grant');
    assert.ok(list.body.items.every((x: any) => x.financial === null), 'no financial details for any granted asset');
    const hist = await api(ctx.app, t)('GET', `/assets/${scanner.id}/history`);
    const created = hist.body.events.find((e: any) => e.action === 'asset.create');
    assert.equal(created.after.acquisitionCost, undefined, 'history hides cost too');
    assert.equal(created.after.name, 'Library scanner');
    assert.equal((await api(ctx.app, t)('PATCH', `/assets/${scanner.id}`, { version: 1, name: 'Renamed by grant holder' })).status, 403);
    await api(ctx.app, admin)('POST', `/users/${staffAId}/grants/${g.body.id}/revoke`);
    staffA = await login(ctx.app, 'staff.a@uni.test');
  });
});

describe('editing', () => {
  test('edits are audited with before/after values and bump the version', async () => {
    const a = (await create(staffA, asset({ name: 'Old name' }))).body;
    const r = await api(ctx.app, staffA)('PATCH', `/assets/${a.id}`, { version: a.version, name: 'New name', notes: 'Asset tag on base' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.name, 'New name');
    assert.equal(r.body.version, a.version + 1);
    assert.equal(r.body.institutionalId, a.institutionalId, 'identity never changes on edit');
    const ev = await ctx.db.query(`SELECT before_data, after_data FROM audit_events WHERE action = 'asset.update' AND entity_id = $1`, [a.id]);
    assert.deepEqual(ev.rows[0].before_data, { name: 'Old name', notes: null });
    assert.deepEqual(ev.rows[0].after_data, { name: 'New name', notes: 'Asset tag on base' });
  });

  test('a stale version is refused instead of overwriting someone else’s change', async () => {
    const a = (await create(staffA, asset())).body;
    await api(ctx.app, staffA)('PATCH', `/assets/${a.id}`, { version: a.version, name: 'First edit' });
    const r = await api(ctx.app, staffA)('PATCH', `/assets/${a.id}`, { version: a.version, name: 'Second edit' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'VERSION_CONFLICT');
  });

  test('cross-field rules apply to edits too', async () => {
    const a = (await create(staffA, asset())).body;
    const r = await api(ctx.app, staffA)('PATCH', `/assets/${a.id}`, { version: a.version, costStatus: 'recorded', acquisitionCost: '0' });
    assert.equal(r.status, 400);
    const r2 = await api(ctx.app, staffA)('PATCH', `/assets/${a.id}`, { version: a.version, acquisitionDate: '2099-01-01' });
    assert.equal(r2.status, 400);
  });

  test('before registration, location can be corrected; after registration it needs the relocation workflow', async () => {
    const a = (await create(staffA, asset())).body;
    const moved = await api(ctx.app, staffA)('PATCH', `/assets/${a.id}`, { version: a.version, locationId: locA2, condition: 'good' });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.location.id, locA2);
    const reg = await register(staffA, moved.body);
    const r = await api(ctx.app, staffA)('PATCH', `/assets/${a.id}`, { version: reg.version, locationId: locA });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'USE_WORKFLOW');
    const ok = await api(ctx.app, staffA)('PATCH', `/assets/${a.id}`, { version: reg.version, description: 'Still editable' });
    assert.equal(ok.status, 200);
  });

  test('changing the serial number re-checks duplicates', async () => {
    const x = (await create(staffA, asset({ serialNumber: 'EDIT-DUP' }))).body;
    const y = (await create(staffA, asset())).body;
    const r = await api(ctx.app, staffA)('PATCH', `/assets/${y.id}`, { version: y.version, serialNumber: 'EDIT-DUP' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.details.matches[0].id, x.id);
  });
});

describe('QR labels and registration completion', () => {
  test('cannot confirm before printing; first print needs no reason, reprints do', async () => {
    const a = (await create(staffA, asset())).body;
    const early = await api(ctx.app, staffA)('POST', `/assets/${a.id}/confirm-label`, { code: a.qrPayload, method: 'scan' });
    assert.equal(early.body.error.code, 'LABEL_NOT_PRINTED');
    const p1 = await api(ctx.app, staffA)('POST', `/assets/${a.id}/label-prints`, { copies: 1, layout: 'sheet' });
    assert.equal(p1.status, 201);
    assert.equal(p1.body.isReprint, false);
    assert.equal(p1.body.qrPayload, a.qrPayload, 'label carries the asset’s existing QR identity');
    const p2 = await api(ctx.app, staffA)('POST', `/assets/${a.id}/label-prints`, { copies: 1, layout: 'single' });
    assert.equal(p2.status, 400);
    const p3 = await api(ctx.app, staffA)('POST', `/assets/${a.id}/label-prints`, { copies: 2, layout: 'single', reason: 'Printer jammed' });
    assert.equal(p3.status, 201);
    assert.equal(p3.body.isReprint, true);
    const before = await ctx.db.query(`SELECT count(*)::int AS n FROM assets`);
    await api(ctx.app, staffA)('POST', `/assets/${a.id}/label-prints`, { copies: 1, layout: 'sheet', reason: 'Lost' });
    const afterCount = await ctx.db.query(`SELECT count(*)::int AS n FROM assets`);
    assert.equal(afterCount.rows[0].n, before.rows[0].n, 'printing never creates assets');
    const hist = await api(ctx.app, staffA)('GET', `/assets/${a.id}/history`);
    assert.equal(hist.body.labelPrints.length, 3);
  });

  test('a label for a different asset is caught and audited', async () => {
    const a = (await create(staffA, asset())).body;
    const other = (await create(staffA, asset())).body;
    await api(ctx.app, staffA)('POST', `/assets/${a.id}/label-prints`, { layout: 'sheet' });
    const r = await api(ctx.app, staffA)('POST', `/assets/${a.id}/confirm-label`, { code: other.qrPayload, method: 'scan' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'LABEL_MISMATCH');
    assert.match(r.body.error.message, new RegExp(other.institutionalId));
    const ev = await ctx.db.query(`SELECT outcome FROM audit_events WHERE action = 'asset.label_mismatch' AND entity_id = $1`, [a.id]);
    assert.equal(ev.rows[0].outcome, 'failure');
    const junk = await api(ctx.app, staffA)('POST', `/assets/${a.id}/confirm-label`, { code: 'https://evil.example/?x=<script>', method: 'scan' });
    assert.equal(junk.body.error.code, 'NOT_AN_ASSET_CODE');
  });

  test('matching code (scanned payload or typed ID) completes registration exactly once', async () => {
    const a = (await create(staffA, asset())).body;
    await api(ctx.app, staffA)('POST', `/assets/${a.id}/label-prints`, { layout: 'sheet' });
    const r = await api(ctx.app, staffA)('POST', `/assets/${a.id}/confirm-label`, { code: ` ${a.institutionalId.toLowerCase()} `, method: 'manual' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.registrationStatus, 'registered');
    assert.ok(r.body.registeredAt);
    assert.equal(r.body.registeredBy, 'Test DEPARTMENT_STAFF');
    const again = await api(ctx.app, staffA)('POST', `/assets/${a.id}/confirm-label`, { code: a.qrPayload, method: 'scan' });
    assert.equal(again.status, 409);
    const ev = await ctx.db.query(`SELECT context FROM audit_events WHERE action = 'asset.register' AND entity_id = $1`, [a.id]);
    assert.equal(ev.rows[0].context.method, 'manual', 'records whether the label was scanned or typed');
    // Reprinting a registered asset keeps the same identity.
    const rp = await api(ctx.app, staffA)('POST', `/assets/${a.id}/label-prints`, { layout: 'sheet', reason: 'Label damaged' });
    assert.equal(rp.body.qrPayload, a.qrPayload);
  });

  test('looking up a code: payload, bare ID, garbage, other department', async () => {
    const a = (await create(staffA, asset())).body;
    const byPayload = await api(ctx.app, staffA)('GET', `/assets/lookup?code=${encodeURIComponent(a.qrPayload)}`);
    assert.equal(byPayload.body.id, a.id);
    const byId = await api(ctx.app, staffA)('GET', `/assets/lookup?code=${a.institutionalId.toLowerCase()}`);
    assert.equal(byId.body.id, a.id);
    assert.equal((await api(ctx.app, staffA)('GET', '/assets/lookup?code=hello')).status, 400);
    assert.equal((await api(ctx.app, staffA)('GET', '/assets/lookup?code=UAT-2026-999999')).status, 404);
    assert.equal((await api(ctx.app, staffB)('GET', `/assets/lookup?code=${encodeURIComponent(a.qrPayload)}`)).status, 403, 'scanning grants no access');
    assert.equal((await api(ctx.app)('GET', `/assets/lookup?code=${encodeURIComponent(a.qrPayload)}`)).status, 401);
  });
});

describe('archiving ("delete")', () => {
  test('staff archive their own unregistered mistakes; the record is kept and hidden from the default list', async () => {
    const a = (await create(staffA, asset({ name: 'Entered by mistake' }))).body;
    assert.equal((await api(ctx.app, staffA)('POST', `/assets/${a.id}/archive`, { reason: '' })).status, 400);
    const r = await api(ctx.app, staffA)('POST', `/assets/${a.id}/archive`, { reason: 'Duplicate entry' });
    assert.equal(r.status, 200);
    assert.equal(r.body.archived.reason, 'Duplicate entry');
    const row = await ctx.db.query(`SELECT 1 FROM assets WHERE id = $1`, [a.id]);
    assert.equal(row.rows.length, 1, 'not physically deleted');
    const list = await api(ctx.app, staffA)('GET', '/assets?q=Entered%20by%20mistake');
    assert.equal(list.body.total, 0);
    const archived = await api(ctx.app, staffA)('GET', '/assets?q=Entered%20by%20mistake&archived=only');
    assert.equal(archived.body.total, 1);
    assert.equal((await api(ctx.app, staffA)('PATCH', `/assets/${a.id}`, { version: r.body.version, name: 'zzz' })).status, 409);
    assert.equal((await api(ctx.app, staffA)('POST', `/assets/${a.id}/label-prints`, { layout: 'sheet' })).status, 409);
  });

  test('registered assets can only be archived by an administrator, who can also restore', async () => {
    const a = (await create(staffA, asset())).body;
    const reg = await register(staffA, a);
    assert.equal((await api(ctx.app, staffA)('POST', `/assets/${a.id}/archive`, { reason: 'Disposed' })).status, 403);
    const r = await api(ctx.app, admin)('POST', `/assets/${a.id}/archive`, { reason: 'Disposed after audit' });
    assert.equal(r.status, 200);
    assert.equal(r.body.registrationStatus, reg.registrationStatus, 'registration history is kept');
    assert.equal((await api(ctx.app, staffA)('POST', `/assets/${a.id}/restore`, { reason: 'Oops' })).status, 403);
    const restored = await api(ctx.app, admin)('POST', `/assets/${a.id}/restore`, { reason: 'Archived in error' });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.archived, null);
    const actions = await ctx.db.query(`SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY id`, [a.id]);
    assert.deepEqual(actions.rows.map((x) => x.action), ['asset.create', 'asset.label_print', 'asset.register', 'asset.archive', 'asset.restore']);
  });

  test('there is no endpoint that physically deletes an asset', async () => {
    const a = (await create(staffA, asset())).body;
    const r = await api(ctx.app, admin)('DELETE', `/assets/${a.id}`);
    assert.equal(r.status, 404);
  });
});

describe('listing', () => {
  test('search and filters', async () => {
    const special = (await create(staffA, asset({ name: 'Spectrophotometer', serialNumber: 'SPEC-777', condition: 'fair' }))).body;
    const call = api(ctx.app, staffA);
    assert.equal((await call('GET', '/assets?q=spectro')).body.items[0].id, special.id);
    assert.equal((await call('GET', '/assets?q=SPEC-777')).body.total, 1);
    assert.equal((await call('GET', `/assets?q=${special.institutionalId}`)).body.total, 1);
    const fair = await call('GET', '/assets?condition=fair&pageSize=100');
    assert.ok(fair.body.items.every((x: any) => x.condition === 'fair'));
    const reg = await call('GET', '/assets?status=registered&pageSize=100');
    assert.ok(reg.body.items.length > 0 && reg.body.items.every((x: any) => x.registrationStatus === 'registered'));
    const byLoc = await call('GET', `/assets?locationId=${locA2}`);
    assert.ok(byLoc.body.items.every((x: any) => x.location.id === locA2));
    const paged = await call('GET', '/assets?pageSize=5&page=2&sort=id');
    assert.equal(paged.body.items.length, 5);
    assert.equal(paged.body.page, 2);
    assert.equal((await call('GET', '/assets?q=%25')).body.total, 0, 'wildcards are literal');
    assert.equal((await call('GET', '/assets?condition=broken')).status, 400);
  });
});

describe('settings for labels and IDs', () => {
  test('label template is validated so labels always fit and QR codes stay scannable', async () => {
    const call = api(ctx.app, admin);
    const cur = (await call('GET', '/settings')).body.items.find((i: any) => i.key === 'label_template').value;
    assert.equal((await call('PUT', '/settings/label_template', { value: { ...cur, qrSizeMm: 8 } })).status, 400);
    assert.equal((await call('PUT', '/settings/label_template', { value: { ...cur, columns: 4 } })).status, 400, 'too wide for A4');
    const noText = await call('PUT', '/settings/label_template', { value: { ...cur, qrSizeMm: 34, labelWidthMm: 40, gapXMm: 2 } });
    assert.equal(noText.status, 400, 'QR filling the label would leave no room for the printed ID');
    assert.match(JSON.stringify(noText.body), /printed asset ID/);
    assert.equal((await call('PUT', '/settings/label_template', { value: { ...cur, footerText: 'Property of the University' } })).status, 200);
    assert.equal((await api(ctx.app, staffA)('PUT', '/settings/label_template', { value: cur })).status, 403);
  });

  test('label layout is readable by anyone who prints labels, but not by others', async () => {
    const r = await api(ctx.app, staffA)('GET', '/label-template');
    assert.equal(r.status, 200);
    assert.equal(r.body.template.layout, 'sheet');
    assert.equal((await api(ctx.app, manager)('GET', '/label-template')).status, 403);
  });

  test('changing the ID prefix affects new assets only', async () => {
    const before = (await create(staffA, asset())).body;
    await api(ctx.app, admin)('PUT', '/settings/asset_id_prefix', { value: 'unv' });
    const after = (await create(staffA, asset())).body;
    assert.match(after.institutionalId, new RegExp(`^UNV-${YEAR}-`));
    assert.equal((await api(ctx.app, staffA)('GET', `/assets/${before.id}`)).body.institutionalId, before.institutionalId);
    await api(ctx.app, admin)('PUT', '/settings/asset_id_prefix', { value: 'UAT' });
  });
});
