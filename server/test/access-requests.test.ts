// E2E-style API journeys: staff requests access → waits → admin approves or rejects.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, createDepartment, createUser, login, setup, type TestCtx } from './helpers.ts';

let ctx: TestCtx;
let deptA: string;
let deptB: string;
let admin: string;

const request = (over: Record<string, unknown> = {}) => ({
  fullName: 'Jane Requester',
  email: 'jane@uni.test',
  departmentId: deptA,
  requestedRole: 'DEPARTMENT_STAFF',
  justification: 'I receive new lab equipment.',
  password: 'Requested-Password-42',
  ...over,
});

before(async () => {
  ctx = await setup();
  deptA = await createDepartment(ctx.db, 'AAA');
  deptB = await createDepartment(ctx.db, 'BBB');
  await createUser(ctx.db, 'admin@uni.test', 'SYSTEM_ADMIN');
  admin = await login(ctx.app, 'admin@uni.test');
});
after(() => ctx.close());

test('public department list is available without signing in and shows only active departments', async () => {
  await ctx.db.query(`INSERT INTO departments (code, name, default_currency, is_active) VALUES ('OLD','Closed dept','USD',false)`);
  const r = await api(ctx.app)('GET', '/public/departments');
  assert.equal(r.status, 200);
  const codes = r.body.items.map((d: any) => d.code);
  assert.ok(codes.includes('AAA') && codes.includes('BBB') && codes.includes('CIVIL'), 'test and seeded departments are listed');
  assert.ok(!codes.includes('OLD'), 'inactive departments are not listed');
  assert.equal(r.body.items[0].defaultCurrency, undefined, 'public list exposes minimal fields only');
});

test('submitting a request creates a pending request but no account', async () => {
  const r = await api(ctx.app)('POST', '/access-requests', request());
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'pending');
  const users = await ctx.db.query(`SELECT 1 FROM users WHERE email = 'jane@uni.test'`);
  assert.equal(users.rows.length, 0);
});

test('a requester cannot choose System Administrator, and unknown fields are rejected', async () => {
  const r1 = await api(ctx.app)('POST', '/access-requests', request({ email: 'x@uni.test', requestedRole: 'SYSTEM_ADMIN' }));
  assert.equal(r1.status, 400);
  const r2 = await api(ctx.app)('POST', '/access-requests', { ...request({ email: 'y@uni.test' }), status: 'approved' });
  assert.equal(r2.status, 400);
});

test('a second pending request for the same email is refused', async () => {
  const r = await api(ctx.app)('POST', '/access-requests', request());
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'REQUEST_PENDING');
});

test('pending requester sees "awaiting approval" and gets no session', async () => {
  const r = await api(ctx.app)('POST', '/auth/login', { email: 'jane@uni.test', password: 'Requested-Password-42' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'ACCOUNT_PENDING');
  assert.equal(r.body.token, undefined);
  const wrong = await api(ctx.app)('POST', '/auth/login', { email: 'jane@uni.test', password: 'not-the-password' });
  assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS', 'pending status not revealed without the right password');
});

test('non-admins cannot list or approve requests, and the denial is audited', async () => {
  await createUser(ctx.db, 'mgr@uni.test', 'ASSET_MANAGER');
  const mgr = await login(ctx.app, 'mgr@uni.test');
  assert.equal((await api(ctx.app, mgr)('GET', '/access-requests')).status, 403);
  const list = await api(ctx.app, admin)('GET', '/access-requests?status=pending');
  const id = list.body.items[0].id;
  assert.equal((await api(ctx.app, mgr)('POST', `/access-requests/${id}/approve`, { role: 'SYSTEM_ADMIN', departmentId: null })).status, 403);
  const denied = await ctx.db.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'authz.denied' AND outcome = 'denied'`);
  assert.ok(denied.rows[0].n >= 2);
});

test('admin approves with a final role and department; user can then sign in with their chosen password', async () => {
  const list = await api(ctx.app, admin)('GET', '/access-requests?status=pending');
  assert.equal(list.body.total, 1);
  const id = list.body.items[0].id;
  const missingDept = await api(ctx.app, admin)('POST', `/access-requests/${id}/approve`, { role: 'DEPARTMENT_STAFF', departmentId: null });
  assert.equal(missingDept.status, 400);
  const ok = await api(ctx.app, admin)('POST', `/access-requests/${id}/approve`, { role: 'DEPARTMENT_STAFF', departmentId: deptB, note: 'Moved to BBB' });
  assert.equal(ok.status, 200);
  const twice = await api(ctx.app, admin)('POST', `/access-requests/${id}/approve`, { role: 'DEPARTMENT_STAFF', departmentId: deptB });
  assert.equal(twice.status, 409);

  const token = await login(ctx.app, 'jane@uni.test', 'Requested-Password-42');
  const me = await api(ctx.app, token)('GET', '/auth/me');
  assert.equal(me.body.user.department.id, deptB, 'admin-assigned department wins over requested one');
  const audit = await ctx.db.query(`SELECT action FROM audit_events WHERE entity_id = $1`, [id]);
  assert.deepEqual(audit.rows.map((r) => r.action).sort(), ['access_request.approve', 'access_request.submit']);
});

test('requesting access for an existing account is refused', async () => {
  const r = await api(ctx.app)('POST', '/access-requests', request());
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'ACCOUNT_EXISTS');
});

test('rejection needs a reason; rejected requester is told so and cannot sign in', async () => {
  await api(ctx.app)('POST', '/access-requests', request({ email: 'rex@uni.test' }));
  const list = await api(ctx.app, admin)('GET', '/access-requests?status=pending');
  const id = list.body.items[0].id;
  assert.equal((await api(ctx.app, admin)('POST', `/access-requests/${id}/reject`, { reason: '' })).status, 400);
  assert.equal((await api(ctx.app, admin)('POST', `/access-requests/${id}/reject`, { reason: 'Not university staff' })).status, 200);
  const r = await api(ctx.app)('POST', '/auth/login', { email: 'rex@uni.test', password: 'Requested-Password-42' });
  assert.equal(r.body.error.code, 'ACCESS_REJECTED');
});

test('allowed email domain setting is enforced on requests', async () => {
  assert.equal((await api(ctx.app, admin)('PUT', '/settings/allowed_email_domains', { value: ['university.example'] })).status, 200);
  const bad = await api(ctx.app)('POST', '/access-requests', request({ email: 'outsider@gmail.test' }));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'EMAIL_DOMAIN_NOT_ALLOWED');
  const good = await api(ctx.app)('POST', '/access-requests', request({ email: 'insider@university.example' }));
  assert.equal(good.status, 201);
  await api(ctx.app, admin)('PUT', '/settings/allowed_email_domains', { value: [] });
});

test('requests to an inactive or unknown department are refused', async () => {
  const old = await ctx.db.query(`SELECT id FROM departments WHERE code = 'OLD'`);
  const r = await api(ctx.app)('POST', '/access-requests', request({ email: 'z@uni.test', departmentId: old.rows[0].id }));
  assert.equal(r.status, 400);
});
