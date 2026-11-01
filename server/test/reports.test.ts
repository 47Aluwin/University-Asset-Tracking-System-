// Phase 5: dashboard figures, the four reports, PDF / Excel exports and their permissions.
// Expected numbers are worked out by hand from the fixtures below and also reconciled with the asset list and SQL.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { api, createDepartment, createUser, login, setup, type TestCtx } from './helpers.ts';

let ctx: TestCtx;
let deptA: string;
let deptB: string;
let cat: string;
let locA1: string;
let locA2: string;
let locB: string;
let admin: string;
let manager: string;
let staffA: string;
let staffB: string;
let staffBId: string;
const ids: Record<string, any> = {};

type AssetOver = { name?: string; dept?: 'A' | 'B'; cost?: string; currency?: string; costStatus?: string; date?: string; condition?: string; register?: boolean };

async function asset(o: AssetOver = {}) {
  const dept = o.dept ?? 'A';
  const token = dept === 'A' ? staffA : staffB;
  const call = api(ctx.app, token);
  const c = await call('POST', '/assets', {
    name: o.name ?? 'Microscope',
    categoryId: cat,
    serialNumber: `SN-${randomUUID().slice(0, 8)}`,
    departmentId: dept === 'A' ? deptA : deptB,
    locationId: dept === 'A' ? locA1 : locB,
    acquisitionDate: o.date ?? '2025-03-01',
    acquisitionMethod: o.costStatus === 'verified_zero' ? 'donation' : 'purchase',
    costStatus: o.costStatus ?? 'recorded',
    ...(o.costStatus === 'verified_zero' ? { acquisitionCost: '0' } : { acquisitionCost: o.cost ?? '100.00' }),
    currency: o.currency ?? 'USD',
    condition: o.condition ?? 'good',
  });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  if (o.register === false) return c.body;
  await call('POST', `/assets/${c.body.id}/label-prints`, { layout: 'sheet' });
  return (await call('POST', `/assets/${c.body.id}/confirm-label`, { code: c.body.qrPayload, method: 'scan' })).body;
}

const get = (token: string, url: string) => api(ctx.app, token)('GET', url);
const raw = (token: string, url: string) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });

/** Text drawn on a pdfkit page: inflate each content stream and decode the hex strings inside TJ arrays. */
function pdfText(buf: Buffer): string {
  const s = buf.toString('latin1');
  let out = '';
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    let content: string;
    try {
      content = inflateSync(buf.subarray(start, end)).toString('latin1');
    } catch {
      continue; // not a compressed content stream (e.g. a font)
    }
    for (const tj of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      out += [...tj[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1], 'hex').toString('latin1')).join('') + '\n';
    }
  }
  return out;
}

before(async () => {
  ctx = await setup();
  deptA = await createDepartment(ctx.db, 'AAA', 'USD');
  deptB = await createDepartment(ctx.db, 'BBB', 'PGK');
  await createUser(ctx.db, 'admin@uni.test', 'SYSTEM_ADMIN');
  await createUser(ctx.db, 'manager@uni.test', 'ASSET_MANAGER');
  await createUser(ctx.db, 'staff.a@uni.test', 'DEPARTMENT_STAFF', deptA);
  staffBId = await createUser(ctx.db, 'staff.b@uni.test', 'DEPARTMENT_STAFF', deptB);
  admin = await login(ctx.app, 'admin@uni.test');
  manager = await login(ctx.app, 'manager@uni.test');
  staffA = await login(ctx.app, 'staff.a@uni.test');
  staffB = await login(ctx.app, 'staff.b@uni.test');
  await api(ctx.app, admin)('PUT', '/settings/institution_time_zone', { value: 'UTC' });
  cat = (await api(ctx.app, admin)('POST', '/categories', { name: 'Lab equipment' })).body.id;
  locA1 = (await api(ctx.app, staffA)('POST', '/locations', { departmentId: deptA, building: 'Science', room: '101' })).body.id;
  locA2 = (await api(ctx.app, staffA)('POST', '/locations', { departmentId: deptA, building: 'Science', room: '202' })).body.id;
  locB = (await api(ctx.app, staffB)('POST', '/locations', { departmentId: deptB, building: 'Library', room: 'G1' })).body.id;

  // Department A (5 records)
  ids.A1 = await asset({ name: 'Old centrifuge', cost: '1000.00', date: '2024-01-10' });
  ids.A2 = await asset({ name: 'Spectrometer', cost: '250.50' });
  ids.A3 = await asset({ name: 'Imported scale', cost: '400.00', currency: 'PGK', condition: 'fair' });
  ids.A4 = await asset({ name: 'New laptop', cost: '99.99', register: false });
  ids.A5 = await asset({ name: '=HYPERLINK("http://evil.test","Donated kettle")', costStatus: 'verified_zero' });
  // Department B (2 records, PGK)
  ids.B1 = await asset({ name: 'Book scanner', dept: 'B', cost: '5000.00', currency: 'PGK' });
  ids.B2 = await asset({ name: 'Projector', dept: 'B', cost: '120.25', currency: 'PGK' });

  // Verification: monthly schedule; A1 overdue, A3 due, A2 + A5 verified (A2 seen in another room).
  assert.equal((await api(ctx.app, admin)('POST', '/verification-schedules', { departmentId: null, categoryId: null, intervalDays: 30, dueWindowDays: 7 })).status, 201);
  await ctx.db.query(`UPDATE assets SET registered_at = now() - interval '100 days', created_at = now() - interval '100 days' WHERE id = $1`, [ids.A1.id]);
  await ctx.db.query(`UPDATE assets SET registered_at = now() - interval '25 days', created_at = now() - interval '25 days' WHERE id = $1`, [ids.A3.id]);
  assert.equal((await api(ctx.app, staffA)('POST', `/assets/${ids.A2.id}/verifications`, { method: 'scan', observedLocationId: locA2 })).status, 201);
  assert.equal((await api(ctx.app, staffA)('POST', `/assets/${ids.A5.id}/verifications`, { method: 'scan' })).status, 201);
  assert.equal((await api(ctx.app, staffB)('POST', `/assets/${ids.B2.id}/report-missing`, { reason: 'Not in the room at the check' })).status, 200);

  // Maintenance: A2 damaged with an urgent open request and costs in two currencies; A1 repaired, awaiting confirmation;
  // B1 damaged with no request.
  const dmg = await api(ctx.app, staffA)('POST', `/assets/${ids.A2.id}/condition`, {
    condition: 'damaged', damageDescription: 'Cracked optical window', requestMaintenance: { problem: 'Replace optical window', priority: 'urgent' },
  });
  assert.equal(dmg.status, 201, JSON.stringify(dmg.body));
  ids.MR1 = dmg.body.maintenanceRequestId;
  for (const [amount, currency] of [['75.00', 'USD'], ['20.00', 'PGK']])
    assert.equal((await api(ctx.app, staffA)('POST', `/maintenance/${ids.MR1}/costs`, { kind: 'parts', description: 'Window', amount, currency })).status, 201);
  let r = (await api(ctx.app, staffA)('POST', '/maintenance', { assetId: ids.A1.id, problem: 'Annual service due' })).body;
  r = (await api(ctx.app, staffA)('POST', `/maintenance/${r.id}/status`, { to: 'in_progress', version: r.version })).body;
  r = (await api(ctx.app, staffA)('POST', `/maintenance/${r.id}/status`, {
    to: 'awaiting_external', version: r.version, provider: { type: 'external', name: 'LabServ Ltd', contact: '+675 000 0000' },
  })).body;
  r = (await api(ctx.app, staffA)('POST', `/maintenance/${r.id}/complete`, { version: r.version, workPerformed: 'Serviced and calibrated', outcome: 'repaired' })).body;
  assert.equal(r.status, 'completed', JSON.stringify(r));
  assert.equal((await api(ctx.app, staffB)('POST', `/assets/${ids.B1.id}/condition`, { condition: 'damaged', damageDescription: 'Glass plate broken' })).status, 201);

  // One pending access request
  assert.equal(
    (await api(ctx.app)('POST', '/access-requests', {
      fullName: 'Jane Requester', email: 'jane@uni.test', departmentId: deptA, requestedRole: 'DEPARTMENT_STAFF',
      justification: 'I receive new lab equipment.', password: 'Requested-Password-42',
    })).status,
    201,
  );
});
after(() => ctx.close());

describe('dashboard', () => {
  test('figures match the records (hand-worked totals, asset list and SQL)', async () => {
    const d = (await get(admin, '/dashboard')).body;
    assert.equal(d.totals.assets, 7);
    assert.equal(d.totals.registered, 6);
    assert.equal(d.totals.awaitingLabel, 1);
    assert.deepEqual(
      d.totals.value.map((v: any) => [v.currency, v.total, v.recorded, v.verifiedZero, v.unknownCost]),
      [['PGK', '5520.25', 3, 0, 0], ['USD', '1350.49', 3, 1, 0]],
      'one total per currency, never added together',
    );
    assert.equal(d.totals.valueRestricted, 0);
    const v = d.verification;
    assert.deepEqual([v.overdue, v.due, v.verified, v.notYetVerified], [1, 1, 2, 2]);
    assert.equal(v.overdue + v.due + v.verified + v.notYetVerified, v.registered, 'verification categories do not overlap');
    assert.equal(v.reportedMissing, 1);
    assert.equal(v.confirmedMissing, 0);
    assert.equal(v.verifiedInPeriod, 2);

    // Each dashboard card links to a list filter: the list must report the same number.
    for (const [status, n] of [['overdue', v.overdue], ['due', v.due], ['verified', v.verified], ['not_yet_verified', v.notYetVerified]])
      assert.equal((await get(admin, `/assets?verification=${status}&pageSize=1`)).body.total, n, status);
    assert.equal((await get(admin, '/assets?missing=reported_missing&pageSize=1')).body.total, v.reportedMissing);
    assert.equal((await get(admin, '/assets?condition=damaged&pageSize=1')).body.total, d.condition.byCondition.damaged);
    assert.equal((await get(admin, '/maintenance?open=true&pageSize=1')).body.total, d.condition.maintenance.open);
    // Independent SQL for the money totals
    const sql = await ctx.db.query(
      `SELECT currency, sum(acquisition_cost)::text AS t FROM assets WHERE archived_at IS NULL AND cost_status = 'recorded' GROUP BY currency ORDER BY currency`,
    );
    assert.deepEqual(sql.rows.map((x) => [x.currency, x.t]), d.totals.value.map((x: any) => [x.currency, x.total]));
  });

  test('condition and outstanding maintenance', async () => {
    const c = (await get(admin, '/dashboard')).body.condition;
    assert.deepEqual(c.byCondition, { excellent: 0, good: 4, fair: 1, damaged: 2, unusable: 0 });
    assert.equal(c.maintenance.open, 1);
    assert.equal(c.maintenance.byPriority.urgent, 1);
    assert.equal(c.maintenance.awaitingConfirmation, 1, 'completed but condition not yet confirmed');
    assert.equal(c.maintenance.damagedWithoutRequest, 1, 'B1 is damaged with no open request');
    assert.deepEqual(c.maintenance.openCosts, [{ currency: 'PGK', total: '20.00' }, { currency: 'USD', total: '75.00' }]);
  });

  test('department summaries and filters', async () => {
    const d = (await get(admin, '/dashboard')).body;
    const a = d.departments.find((x: any) => x.id === deptA);
    const b = d.departments.find((x: any) => x.id === deptB);
    assert.equal(a.assets, 5);
    assert.deepEqual([a.overdue, a.due, a.verified, a.notYetVerified, a.damaged, a.openMaintenance], [1, 1, 2, 0, 1, 1]);
    assert.deepEqual(a.value, [{ currency: 'PGK', total: '400.00' }, { currency: 'USD', total: '1350.49' }]);
    assert.deepEqual([b.assets, b.missing, b.damaged], [2, 1, 1]);
    const filtered = (await get(admin, `/dashboard?departmentId=${deptB}`)).body;
    assert.equal(filtered.totals.assets, 2);
    assert.deepEqual(filtered.departments.map((x: any) => x.id), [deptB]);
    assert.equal((await get(admin, '/dashboard?condition=damaged')).body.totals.assets, 2);
    assert.equal((await get(admin, '/dashboard?periodDays=7')).status, 400);
  });

  test('access requests are only shown to administrators', async () => {
    assert.deepEqual((await get(admin, '/dashboard')).body.accessRequests.pending, 1);
    assert.deepEqual((await get(manager, '/dashboard')).body.accessRequests, { restricted: true });
    assert.deepEqual((await get(staffA, '/dashboard')).body.accessRequests, { restricted: true });
  });

  test('department staff see only their department; asking for another is refused and audited', async () => {
    const d = (await get(staffA, '/dashboard')).body;
    assert.equal(d.totals.assets, 5);
    assert.deepEqual(d.departments.map((x: any) => x.id), [deptA]);
    assert.equal(d.condition.maintenance.open, 1);
    const denied = await get(staffA, `/dashboard?departmentId=${deptB}`);
    assert.equal(denied.status, 403);
    const a = await ctx.db.query(`SELECT 1 FROM audit_events WHERE action = 'authz.denied' AND entity_id = 'dashboard.read'`);
    assert.equal(a.rows.length, 1);
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/api/v1/dashboard' })).statusCode, 401);
  });
});

describe('reports', () => {
  test('1. complete asset register: fields, filters and per-currency totals', async () => {
    const r = (await get(admin, '/reports/asset-register')).body;
    assert.equal(r.title, 'Complete asset register');
    const t = r.tables[0];
    for (const col of ['Asset ID', 'QR reference', 'Manufacturer barcode', 'Serial number', 'Name', 'Description', 'Category', 'Faculty', 'School / department', 'Building', 'Room', 'Assigned to', 'Condition', 'Asset status', 'Acquired', 'Acquisition cost', 'Currency', 'Registration'])
      assert.ok(t.columns.some((c: any) => c.label === col), col);
    assert.equal(t.totalRows, 7);
    const row = t.rows.find((x: any[]) => x[0] === ids.A1.institutionalId);
    assert.deepEqual([row[1], row[15], row[16]], [`UATS:${ids.A1.institutionalId}`, '1000.00', 'USD']);
    assert.deepEqual(r.tables[1].rows, [['PGK', '5520.25', 3], ['USD', '1350.49', 4]]);
    assert.ok(r.filters.some(([k]: string[]) => k === 'School / department'));
    assert.ok(r.notes.some((n: string) => /never added together/.test(n)));

    assert.equal((await get(admin, '/reports/asset-register?from=2025-01-01')).body.tables[0].totalRows, 6, 'acquisition date filter');
    assert.equal((await get(admin, '/reports/asset-register?to=2024-12-31')).body.tables[0].totalRows, 1);
    assert.equal((await get(admin, '/reports/asset-register?status=registered')).body.tables[0].totalRows, 6);
    assert.equal((await get(admin, `/reports/asset-register?departmentId=${deptB}`)).body.tables[0].totalRows, 2);
  });

  test('2. department inventory and value: counts by department and category, money per currency', async () => {
    const r = (await get(admin, '/reports/department-summary')).body;
    const [, , byDept, values, totals, byCat] = r.tables;
    const a = byDept.rows.find((x: any[]) => x[0] === 'Test department AAA');
    assert.deepEqual(a.slice(0, 5), ['Test department AAA', 'Central administration', 5, 4, 1]);
    assert.deepEqual(
      values.rows.map((x: any[]) => [x[0], x[2], x[3]]),
      [['Test department AAA', 'PGK', '400.00'], ['Test department AAA', 'USD', '1350.49'], ['Test department BBB', 'PGK', '5120.25']],
    );
    assert.deepEqual(totals.rows, [['PGK', '5520.25', 3], ['USD', '1350.49', 4]]);
    assert.deepEqual(byCat.rows, [['Test department AAA', 'Lab equipment', 5], ['Test department BBB', 'Lab equipment', 2]]);
  });

  test('3. verification and overdue: status, last scan, due date, overdue days, discrepancies, missing', async () => {
    const all = (await get(admin, '/reports/verification')).body;
    assert.deepEqual(all.tables[0].rows.map((x: any[]) => x.slice(0, 2)), [['Verification overdue', 1], ['Verification due', 1], ['Not yet verified', 2], ['Verified', 2]]);
    const overdue = (await get(admin, '/reports/verification?status=overdue')).body.tables[1];
    assert.equal(overdue.totalRows, 1);
    const o = overdue.rows[0];
    assert.equal(o[0], ids.A1.institutionalId);
    assert.equal(o[9], 30, 'interval');
    assert.equal(o[11], 70, '100 days since registration - 30 day interval');
    const disc = (await get(admin, '/reports/verification?status=discrepancy')).body.tables[1];
    assert.deepEqual(disc.rows.map((x: any[]) => [x[0], x[6], x[7], x[8]]), [[ids.A2.institutionalId, 'Test DEPARTMENT_STAFF', 'Science / 202', 'Yes']]);
    const missing = (await get(staffB, '/reports/verification?status=missing')).body.tables[1];
    assert.deepEqual(missing.rows.map((x: any[]) => [x[0], x[12]]), [[ids.B2.institutionalId, 'Reported missing']]);
    assert.equal((await get(admin, '/reports/verification?status=open')).status, 400, 'status values are checked per report');
  });

  test('4. damaged assets, repairs and costs', async () => {
    const r = (await get(admin, '/reports/maintenance')).body;
    const [byStatus, requests, costTotals, lines, history, damaged] = r.tables;
    assert.deepEqual(byStatus.rows, [['Submitted', 1], ['Completed', 1]]);
    assert.equal(requests.totalRows, 2);
    const done = requests.rows.find((x: any[]) => x[1] === ids.A1.institutionalId);
    assert.equal(done[10], 'External: LabServ Ltd');
    assert.equal(done[13], 'Repaired');
    assert.equal(done[15], 'Not yet confirmed');
    const open = requests.rows.find((x: any[]) => x[1] === ids.A2.institutionalId);
    assert.equal(open[17], 'PGK 20.00; USD 75.00');
    assert.deepEqual(costTotals.rows, [['PGK', '20.00', 1], ['USD', '75.00', 1]]);
    assert.equal(lines.totalRows, 2);
    assert.ok(history.totalRows >= 4, 'status changes are listed');
    assert.deepEqual(damaged.rows.map((x: any[]) => [x[0], x[4], x[6]]).sort(), [
      [ids.A2.institutionalId, 'Cracked optical window', `${open[0]} (Submitted)`],
      [ids.B1.institutionalId, 'Glass plate broken', 'None'],
    ].sort());
    assert.equal((await get(admin, '/reports/maintenance?status=open')).body.tables[1].totalRows, 1);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    assert.equal((await get(admin, `/reports/maintenance?from=${tomorrow}`)).body.tables[1].totalRows, 0);
  });

  test('filters are validated', async () => {
    assert.equal((await get(admin, '/reports/asset-register?from=2025-02-30')).status, 400);
    assert.equal((await get(admin, '/reports/asset-register?from=2025-05-01&to=2025-01-01')).status, 400);
    assert.equal((await get(admin, '/reports/unknown')).status, 400);
    assert.equal((await get(admin, '/reports/asset-register?format=csv')).status, 400);
  });

  test('department scope: staff cannot report on another department, in previews or exports', async () => {
    const own = (await get(staffA, '/reports/asset-register')).body.tables[0];
    assert.equal(own.totalRows, 5);
    assert.equal((await get(staffA, `/reports/asset-register?departmentId=${deptB}`)).status, 403);
    assert.equal((await raw(staffA, `/reports/maintenance?departmentId=${deptB}&format=xlsx`)).statusCode, 403);
    assert.equal((await get(staffA, '/reports/maintenance')).body.tables[1].totalRows, 2);
    assert.ok(!(await get(staffA, '/reports/maintenance')).body.tables[5].rows.some((x: any[]) => x[0] === ids.B1.institutionalId));
  });

  test('a read-only grant shows counts but never the other department’s money', async () => {
    const g = await api(ctx.app, admin)('POST', `/users/${staffBId}/grants`, { departmentId: deptA, accessLevel: 'read', reason: 'Joint audit 2026' });
    assert.equal(g.status, 201);
    const tb = await login(ctx.app, 'staff.b@uni.test');
    try {
      const d = (await get(tb, '/dashboard')).body;
      assert.equal(d.totals.assets, 7);
      assert.equal(d.totals.valueRestricted, 5);
      assert.deepEqual(d.totals.value.map((v: any) => [v.currency, v.total]), [['PGK', '5120.25']]);
      assert.equal(d.departments.find((x: any) => x.id === deptA).value, null);

      const reg = (await get(tb, '/reports/asset-register')).body;
      const a1 = reg.tables[0].rows.find((x: any[]) => x[0] === ids.A1.institutionalId);
      assert.deepEqual([a1[15], a1[16], a1[17]], [null, 'Restricted', 'Restricted']);
      assert.deepEqual(reg.tables[1].rows, [['PGK', '5120.25', 2]]);
      assert.ok(reg.notes.some((n: string) => n.includes('Restricted')));

      const m = (await get(tb, '/reports/maintenance')).body;
      assert.equal(m.tables[1].rows.find((x: any[]) => x[1] === ids.A2.institutionalId)[17], 'Restricted');
      assert.equal(m.tables[3].totalRows, 0, 'no cost lines from department A');

      const xlsx = await raw(tb, '/reports/asset-register?format=xlsx');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsx.rawPayload as any);
      const values = JSON.stringify(wb.getWorksheet('Assets')!.getSheetValues());
      assert.ok(!values.includes('1000') && !values.includes('250.5'), 'restricted amounts are not in the file');
    } finally {
      await api(ctx.app, admin)('POST', `/users/${staffBId}/grants/${g.body.id}/revoke`);
    }
  });
});

describe('exports', () => {
  test('Excel export is a real workbook with labels, numbers, filters and generation time', async () => {
    const res = await raw(admin, '/reports/asset-register?format=xlsx');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.match(String(res.headers['content-disposition']), /^attachment; filename="asset-register-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.rawPayload.subarray(0, 2).toString(), 'PK', 'zip container');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as any);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['About this report', 'Assets', 'Totals by currency (recorded']);
    const about = wb.getWorksheet('About this report')!;
    assert.equal(about.getCell('A1').value, 'Complete asset register');
    assert.equal(about.getCell('A2').value, 'Generated');
    assert.match(String(about.getCell('B2').value), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC\)$/);
    const sheet = wb.getWorksheet('Assets')!;
    assert.equal(sheet.getCell('A1').value, 'Asset ID');
    assert.equal(sheet.getCell('P1').value, 'Acquisition cost');
    assert.equal(sheet.rowCount, 8, 'header + 7 assets');
    const a1 = sheet.getRows(2, 7)!.find((r) => r.getCell(1).value === ids.A1.institutionalId)!;
    assert.equal(a1.getCell(16).value, 1000, 'money is a number');
    assert.equal(a1.getCell(16).numFmt, '#,##0.00');
    assert.equal(a1.getCell(17).value, 'USD');
    assert.ok(a1.getCell(15).value instanceof Date, 'dates are real dates');
    // A name that looks like a formula stays plain text.
    const evil = sheet.getRows(2, 7)!.find((r) => String(r.getCell(5).value).startsWith('=HYPERLINK'))!;
    assert.equal(evil.getCell(5).type, ExcelJS.ValueType.String);
    const totals = wb.getWorksheet('Totals by currency (recorded')!;
    assert.deepEqual([totals.getCell('A2').value, totals.getCell('B2').value, totals.getCell('A3').value, totals.getCell('B3').value], ['PGK', 5520.25, 'USD', 1350.49]);

    const audit = await ctx.db.query(`SELECT context FROM audit_events WHERE action = 'report.export' ORDER BY id DESC LIMIT 1`);
    assert.equal(audit.rows[0].context.format, 'xlsx');
    assert.equal(audit.rows[0].context.rows.Assets, 7);
  });

  test('PDF export is a real PDF containing the report, filters and page numbers', async () => {
    const res = await raw(admin, '/reports/maintenance?format=pdf');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.match(String(res.headers['content-disposition']), /filename="maintenance-\d{4}-\d{2}-\d{2}\.pdf"/);
    const buf = res.rawPayload;
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    assert.match(buf.subarray(-8).toString(), /%%EOF\s*$/);
    const pages = Number(/\/Type \/Pages[\s\S]*?\/Count (\d+)/.exec(buf.toString('latin1'))![1]);
    const text = pdfText(buf);
    // Every page carries exactly one "Page i of N" footer, and nothing else adds blank pages.
    assert.equal((text.match(/Page \d+ of \d+/g) ?? []).length, pages);
    assert.ok(text.includes(`Page ${pages} of ${pages}`));
    // Built-in PDF fonts use Windows-1252 codes: the bullet is 0x95 (a "?" would be 0x3F).
    assert.ok(text.includes('\x95 Times are shown in UTC.'), 'bullets print as bullets, not "?"');
    const small = await raw(staffA, '/reports/verification?format=pdf&status=overdue');
    assert.match(small.rawPayload.toString('latin1'), /\/Type \/Pages[\s\S]*?\/Count 1\b/, 'a short report is a single page');
    for (const s of ['Damaged assets, repairs and maintenance costs', 'Generated', 'School / department: All departments you can access', ids.A2.institutionalId, 'Cracked optical window', 'LabServ Ltd', 'Page 1 of', 'USD'])
      assert.ok(text.replace(/\n/g, '').includes(s) || text.includes(s), `PDF should contain "${s}"`);
    for (const kind of ['asset-register', 'department-summary', 'verification']) {
      const r = await raw(staffA, `/reports/${kind}?format=pdf`);
      assert.equal(r.statusCode, 200, kind);
      assert.equal(r.rawPayload.subarray(0, 5).toString(), '%PDF-');
    }
  });

  test('an empty result still exports, with an explanation', async () => {
    const res = await raw(admin, '/reports/asset-register?format=pdf&from=2000-01-01&to=2000-12-31');
    assert.equal(res.statusCode, 200);
    assert.ok(pdfText(res.rawPayload).includes('No assets match the selected filters.'));
    const x = await raw(admin, '/reports/asset-register?format=xlsx&from=2000-01-01&to=2000-12-31');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as any);
    assert.equal(wb.getWorksheet('Assets')!.getCell('A2').value, 'No assets match the selected filters.');
  });
});

describe('large result sets', () => {
  let big: TestCtx;
  let token: string;
  before(async () => {
    big = await setup({ env: { REPORT_MAX_ROWS: '100' } });
    const d = await createDepartment(big.db, 'BIG');
    const u = await createUser(big.db, 'admin@uni.test', 'SYSTEM_ADMIN');
    token = await login(big.app, 'admin@uni.test');
    const c = (await big.db.query(`INSERT INTO asset_categories (name) VALUES ('Chairs') RETURNING id`)).rows[0].id;
    const l = (await big.db.query(`INSERT INTO locations (department_id, building, room) VALUES ($1, 'Main', '1') RETURNING id`, [d])).rows[0].id;
    await big.db.query(
      `INSERT INTO assets (institutional_id, qr_payload, name, category_id, serial_number, owning_department_id, location_id,
                           acquisition_date, acquisition_method, acquisition_cost, currency, cost_status, condition, registration_status, created_by)
       SELECT 'UAT-2026-' || lpad(n::text, 6, '0'), 'UATS:UAT-2026-' || lpad(n::text, 6, '0'), 'Chair ' || n, $1, 'S' || n, $2, $3,
              DATE '2025-01-01', 'purchase', 10, 'USD', 'recorded', 'good', 'awaiting_label', $4
         FROM generate_series(1, 101) n`,
      [c, d, l, u],
    );
  });
  after(() => big.close());

  test('previews show a page of rows with the true total; oversized exports are refused with advice', async () => {
    const r = await big.app.inject({ method: 'GET', url: '/api/v1/reports/asset-register', headers: { authorization: `Bearer ${token}` } });
    const t = r.json().tables[0];
    assert.equal(t.totalRows, 101);
    assert.equal(t.rows.length, 50);
    const x = await big.app.inject({ method: 'GET', url: '/api/v1/reports/asset-register?format=xlsx', headers: { authorization: `Bearer ${token}` } });
    assert.equal(x.statusCode, 422);
    assert.equal(x.json().error.code, 'REPORT_TOO_LARGE');
    assert.match(x.json().error.message, /101 assets.*limited to 100.*Narrow the filters/);
    const ok = await big.app.inject({ method: 'GET', url: '/api/v1/reports/department-summary?format=xlsx', headers: { authorization: `Bearer ${token}` } });
    assert.equal(ok.statusCode, 200, 'summary reports are small regardless');
  });
});
