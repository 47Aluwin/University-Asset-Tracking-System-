// Faculties and schools (PNG University of Technology structure): seeded reference data, school ↔ faculty links,
// faculty shown on assets and kept on edit, new asset fields, filtering, dashboard and report totals by faculty.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { api, createUser, login, setup, type TestCtx } from './helpers.ts';

let ctx: TestCtx;
let admin: string;
let staffCivil: string;
let staffMech: string;
let finance: string; // read-only cross-department viewer without financial access
let cat: string;
const dept: Record<string, string> = {};
const loc: Record<string, string> = {};
const fac: Record<string, string> = {};

async function register(token: string, code: string, extra: Record<string, unknown> = {}) {
  const r = await api(ctx.app, token)('POST', '/assets', {
    name: `Asset ${randomUUID().slice(0, 6)}`, categoryId: cat, serialNumber: `SN-${randomUUID().slice(0, 8)}`,
    departmentId: dept[code], locationId: loc[code], acquisitionDate: '2025-03-01', acquisitionMethod: 'purchase',
    costStatus: 'recorded', acquisitionCost: '1000.00', currency: 'PGK', condition: 'good', ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

before(async () => {
  ctx = await setup();
  for (const r of (await ctx.db.query('SELECT id, code FROM departments')).rows) dept[r.code] = r.id;
  for (const r of (await ctx.db.query('SELECT id, code FROM faculties')).rows) fac[r.code] = r.id;
  await createUser(ctx.db, 'admin@uni.test', 'SYSTEM_ADMIN');
  await createUser(ctx.db, 'civil@uni.test', 'DEPARTMENT_STAFF', dept.CIVIL);
  await createUser(ctx.db, 'mech@uni.test', 'DEPARTMENT_STAFF', dept.MECH);
  await createUser(ctx.db, 'library@uni.test', 'DEPARTMENT_STAFF', dept.LIBRARY);
  admin = await login(ctx.app, 'admin@uni.test');
  staffCivil = await login(ctx.app, 'civil@uni.test');
  staffMech = await login(ctx.app, 'mech@uni.test');
  finance = await login(ctx.app, 'library@uni.test');
  cat = (await api(ctx.app, admin)('POST', '/categories', { name: 'Lab equipment' })).body.id;
  for (const [code, token] of [['CIVIL', staffCivil], ['MECH', staffMech], ['LIBRARY', finance]] as const) {
    loc[code] = (await api(ctx.app, token)('POST', '/locations', { departmentId: dept[code], building: `${code} block`, room: '101' })).body.id;
  }
});
after(() => ctx.close());

describe('faculty and school reference data', () => {
  test('all six faculties and their schools are stored, each school linked to its faculty', async () => {
    const faculties = (await api(ctx.app, staffCivil)('GET', '/faculties')).body.items;
    assert.deepEqual(faculties.map((f: any) => f.name), [
      'Faculty of Engineering',
      'Faculty of Sciences',
      'Faculty of Natural Resources',
      'Faculty of Humanities',
      'Faculty of Built Environment',
      'Faculty of Postgraduate Studies, Research, and Innovation',
    ]);
    const depts = (await api(ctx.app, admin)('GET', '/departments')).body.items;
    const schoolsOf = (name: string) => depts.filter((d: any) => d.faculty?.name === name).map((d: any) => d.name).sort();
    assert.deepEqual(schoolsOf('Faculty of Engineering'), [
      'School of Civil Engineering', 'School of Electrical and Communication Engineering', 'School of Mechanical Engineering', 'School of Mining Engineering',
    ]);
    assert.deepEqual(schoolsOf('Faculty of Sciences'), ['School of Applied Physics', 'School of Applied Sciences', 'School of Mathematics and Computer Science']);
    assert.deepEqual(schoolsOf('Faculty of Natural Resources'), ['School of Agriculture', 'School of Forestry']);
    assert.deepEqual(schoolsOf('Faculty of Humanities'), ['School of Business Studies', 'School of Communication and Development Studies']);
    assert.deepEqual(schoolsOf('Faculty of Built Environment'), ['School of Architecture and Construction Management', 'School of Surveying and Land Studies']);
    assert.equal(schoolsOf('Faculty of Postgraduate Studies, Research, and Innovation').length, 1, 'has its own unit for asset registration');
    const central = depts.filter((d: any) => !d.faculty).map((d: any) => d.name);
    assert.ok(central.includes('University Library') && central.includes('Student Support & Facility Centre'), 'Library and SSFC are central units (no faculty)');
  });

  test('administrators add faculties and attach schools / research units; others cannot', async () => {
    const call = api(ctx.app, admin);
    assert.equal((await api(ctx.app, staffCivil)('POST', '/faculties', { code: 'FX', name: 'Faculty X' })).status, 403);
    const unit = await call('POST', '/departments', { code: 'RESCTR', name: 'Research Centre', defaultCurrency: 'PGK', facultyId: fac.FPGRI });
    assert.equal(unit.status, 201, JSON.stringify(unit.body));
    assert.equal(unit.body.faculty.name, 'Faculty of Postgraduate Studies, Research, and Innovation');
    const moved = await call('PATCH', `/departments/${unit.body.id}`, { facultyId: null });
    assert.equal(moved.body.faculty, null, 'can become a central unit');
    assert.equal((await call('PATCH', `/departments/${unit.body.id}`, { facultyId: randomUUID() })).status, 400);
    assert.equal((await call('POST', '/faculties', { code: 'FENG', name: 'Another' })).status, 409);
    const audit = await ctx.db.query(`SELECT 1 FROM audit_events WHERE action = 'department.update' AND entity_id = $1`, [unit.body.id]);
    assert.equal(audit.rows.length, 1, 'faculty changes are audited');
  });
});

describe('assets carry their faculty and school', () => {
  test('registration saves school, faculty (from the school), assigned staff member and asset status', async () => {
    const a = await register(staffCivil, 'CIVIL', { assignedTo: 'Dr. Jane Kila', usageStatus: 'in_storage' });
    assert.deepEqual(a.department.id, dept.CIVIL);
    assert.deepEqual(a.faculty, { id: fac.FENG, name: 'Faculty of Engineering' });
    assert.equal(a.assignedTo, 'Dr. Jane Kila');
    assert.equal(a.usageStatus, 'in_storage');
    const plain = await register(staffCivil, 'CIVIL');
    assert.equal(plain.usageStatus, 'in_use', 'defaults to in use');
    assert.equal(plain.assignedTo, null);
    const lib = await register(finance, 'LIBRARY');
    assert.equal(lib.faculty, null, 'central administrative unit: no faculty');
  });

  test('editing keeps the faculty and school; assigned staff member and status can change', async () => {
    const a = await register(staffMech, 'MECH');
    const e = await api(ctx.app, staffMech)('PATCH', `/assets/${a.id}`, { version: a.version, assignedTo: 'Mr. Peter Wari', usageStatus: 'not_in_use', name: 'Lathe' });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.equal(e.body.faculty.name, 'Faculty of Engineering');
    assert.equal(e.body.department.id, dept.MECH);
    assert.equal(e.body.assignedTo, 'Mr. Peter Wari');
    assert.equal(e.body.usageStatus, 'not_in_use');
    assert.equal((await api(ctx.app, staffMech)('PATCH', `/assets/${a.id}`, { version: e.body.version, usageStatus: 'broken' })).status, 400);
  });

  test('search by assigned staff member, filter by faculty, central units and status', async () => {
    const call = api(ctx.app, admin);
    const names = async (qs: string) => (await call('GET', `/assets?pageSize=100&${qs}`)).body.items;
    const eng = await names(`facultyId=${fac.FENG}`);
    assert.ok(eng.length >= 3 && eng.every((x: any) => x.faculty?.id === fac.FENG));
    assert.equal((await names(`facultyId=${fac.FSCI}`)).length, 0);
    const central = await names('facultyId=central');
    assert.ok(central.length >= 1 && central.every((x: any) => x.faculty === null));
    assert.ok((await names('q=Jane%20Kila')).every((x: any) => x.assignedTo === 'Dr. Jane Kila'));
    assert.equal((await names('q=Jane%20Kila')).length, 1);
    assert.ok((await names('usageStatus=in_storage')).every((x: any) => x.usageStatus === 'in_storage'));
    assert.equal((await call('GET', '/assets?facultyId=nope')).status, 400);
    // Staff only ever see their own school, even when filtering by a faculty.
    const mine = (await api(ctx.app, staffMech)('GET', `/assets?facultyId=${fac.FENG}&pageSize=100`)).body.items;
    assert.ok(mine.length >= 1 && mine.every((x: any) => x.department.id === dept.MECH));
  });
});

describe('dashboard and reports by faculty', () => {
  test('dashboard totals per faculty add up to the overall totals, with condition and value per currency', async () => {
    const d = (await api(ctx.app, admin)('GET', '/dashboard')).body;
    const eng = d.faculties.find((f: any) => f.id === fac.FENG);
    const counted = (await ctx.db.query(
      `SELECT count(*)::int AS n, sum(acquisition_cost)::numeric(16,2)::text AS v FROM assets a JOIN departments dd ON dd.id = a.owning_department_id
        WHERE dd.faculty_id = $1 AND a.archived_at IS NULL`, [fac.FENG])).rows[0];
    assert.equal(eng.assets, counted.n);
    assert.deepEqual(eng.value, [{ currency: 'PGK', total: counted.v }]);
    assert.equal(eng.byCondition.good + eng.byCondition.excellent + eng.byCondition.fair + eng.byCondition.damaged + eng.byCondition.unusable, eng.assets);
    assert.equal(d.faculties.reduce((n: number, f: any) => n + f.assets, 0), d.totals.assets, 'every asset counted in exactly one faculty group');
    assert.equal(d.faculties.at(-1).name, 'Central administration', 'central units listed last');
    assert.equal(d.departments.find((x: any) => x.id === dept.CIVIL).faculty.name, 'Faculty of Engineering');

    const only = (await api(ctx.app, admin)('GET', `/dashboard?facultyId=${fac.FENG}`)).body;
    assert.equal(only.totals.assets, counted.n);
    assert.ok(only.departments.every((x: any) => x.faculty?.id === fac.FENG));
  });

  test('summary report has faculty tables; asset register shows faculty, school, assigned staff and status', async () => {
    const r = (await api(ctx.app, admin)('GET', '/reports/department-summary')).body;
    assert.equal(r.title, 'Faculty and department inventory and asset value');
    const [byFaculty, facultyValue, byDept] = r.tables;
    const eng = byFaculty.rows.find((x: any[]) => x[0] === 'Faculty of Engineering');
    assert.ok(eng[2] >= 3);
    assert.ok(facultyValue.rows.some((x: any[]) => x[0] === 'Faculty of Engineering' && x[1] === 'PGK'));
    assert.ok(byDept.rows.some((x: any[]) => x[0] === 'School of Civil Engineering' && x[1] === 'Faculty of Engineering'));
    assert.ok(byFaculty.rows.some((x: any[]) => x[0] === 'Central administration'));

    const reg = (await api(ctx.app, admin)('GET', `/reports/asset-register?facultyId=${fac.FENG}`)).body;
    const cols = reg.tables[0].columns.map((c: any) => c.label);
    const row = reg.tables[0].rows.find((x: any[]) => x[cols.indexOf('Assigned to')] === 'Dr. Jane Kila');
    assert.equal(row[cols.indexOf('Faculty')], 'Faculty of Engineering');
    assert.equal(row[cols.indexOf('School / department')], 'School of Civil Engineering');
    assert.equal(row[cols.indexOf('Asset status')], 'In storage');
    assert.ok(reg.tables[0].rows.every((x: any[]) => x[cols.indexOf('Faculty')] === 'Faculty of Engineering'));
    assert.deepEqual(reg.filters[0], ['Faculty', 'Faculty of Engineering']);
    const pdf = await ctx.app.inject({ method: 'GET', url: `/api/v1/reports/department-summary?format=pdf&facultyId=${fac.FENG}`, headers: { authorization: `Bearer ${admin}` } });
    assert.equal(pdf.statusCode, 200);
  });
});
