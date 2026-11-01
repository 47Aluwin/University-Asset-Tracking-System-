// Admin account management, department moves, leavers, privilege escalation, scope grants.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, createDepartment, createUser, login, setup, tokenFromLink, type TestCtx } from './helpers.ts';

let ctx: TestCtx;
let deptA: string;
let deptB: string;
let adminId: string;
let admin: string;

before(async () => {
  ctx = await setup();
  deptA = await createDepartment(ctx.db, 'AAA');
  deptB = await createDepartment(ctx.db, 'BBB', 'EUR');
  adminId = await createUser(ctx.db, 'admin@uni.test', 'SYSTEM_ADMIN');
  admin = await login(ctx.app, 'admin@uni.test');
});
after(() => ctx.close());

test('admin creates a staff account; the person sets their own password via a one-time link', async () => {
  const r = await api(ctx.app, admin)('POST', '/users', { email: 'New.Staff@uni.test', fullName: 'New Staff', role: 'DEPARTMENT_STAFF', departmentId: deptA });
  assert.equal(r.status, 201);
  assert.ok(r.body.setupLink.startsWith('http://app.test/reset-password?token='));
  // Cannot sign in before setting a password.
  const pre = await api(ctx.app)('POST', '/auth/login', { email: 'new.staff@uni.test', password: 'anything-at-all-1' });
  assert.equal(pre.status, 401);
  const set = await api(ctx.app)('POST', '/auth/reset-password', { token: tokenFromLink(r.body.setupLink), newPassword: 'Chosen-By-Staff-55' });
  assert.equal(set.status, 200);
  await login(ctx.app, 'new.staff@uni.test', 'Chosen-By-Staff-55');
  const dup = await api(ctx.app, admin)('POST', '/users', { email: 'new.staff@uni.test', fullName: 'Dup', role: 'DEPARTMENT_STAFF', departmentId: deptA });
  assert.equal(dup.status, 409);
});

test('department staff must have a department', async () => {
  const r = await api(ctx.app, admin)('POST', '/users', { email: 'nodept@uni.test', fullName: 'No Dept', role: 'DEPARTMENT_STAFF', departmentId: null });
  assert.equal(r.status, 400);
});

test('staff and asset managers cannot manage users', async () => {
  await createUser(ctx.db, 's@uni.test', 'DEPARTMENT_STAFF', deptA);
  await createUser(ctx.db, 'm@uni.test', 'ASSET_MANAGER');
  for (const email of ['s@uni.test', 'm@uni.test']) {
    const t = await login(ctx.app, email);
    const call = api(ctx.app, t);
    assert.equal((await call('GET', '/users')).status, 403);
    assert.equal((await call('POST', '/users', { email: 'x@uni.test', fullName: 'X', role: 'SYSTEM_ADMIN', departmentId: null })).status, 403);
    assert.equal((await call('GET', '/audit-events')).status, 403);
    assert.equal((await call('PUT', '/settings/allow_unknown_cost', { value: false })).status, 403);
    assert.equal((await call('POST', '/departments', { code: 'HACK', name: 'Hack', defaultCurrency: 'USD' })).status, 403);
  }
});

test('privilege escalation: staff cannot change their own role or department', async () => {
  const { rows } = await ctx.db.query(`SELECT id FROM users WHERE email = 's@uni.test'`);
  const t = await login(ctx.app, 's@uni.test');
  const r = await api(ctx.app, t)('PATCH', `/users/${rows[0].id}`, { role: 'SYSTEM_ADMIN' });
  assert.equal(r.status, 403);
  const role = await ctx.db.query(`SELECT role FROM users WHERE id = $1`, [rows[0].id]);
  assert.equal(role.rows[0].role, 'DEPARTMENT_STAFF');
});

test('moving staff to another department takes effect immediately and ends their sessions', async () => {
  const id = await createUser(ctx.db, 'mover@uni.test', 'DEPARTMENT_STAFF', deptA);
  const t = await login(ctx.app, 'mover@uni.test');
  const r = await api(ctx.app, admin)('PATCH', `/users/${id}`, { departmentId: deptB });
  assert.equal(r.status, 200);
  assert.equal(r.body.sessionsRevoked, true);
  assert.equal((await api(ctx.app, t)('GET', '/auth/me')).status, 401);
  const t2 = await login(ctx.app, 'mover@uni.test');
  const me = await api(ctx.app, t2)('GET', '/auth/me');
  assert.deepEqual(me.body.user.permissions['assets.register'], [deptB]);
  const audit = await ctx.db.query(`SELECT before_data, after_data FROM audit_events WHERE action = 'user.access_change' AND entity_id = $1`, [id]);
  assert.deepEqual(audit.rows[0].before_data, { departmentId: deptA });
  assert.deepEqual(audit.rows[0].after_data, { departmentId: deptB });
});

test('renaming a user does not end their sessions', async () => {
  const { rows } = await ctx.db.query(`SELECT id FROM users WHERE email = 'mover@uni.test'`);
  const t = await login(ctx.app, 'mover@uni.test');
  const r = await api(ctx.app, admin)('PATCH', `/users/${rows[0].id}`, { fullName: 'Renamed Person' });
  assert.equal(r.body.sessionsRevoked, false);
  assert.equal((await api(ctx.app, t)('GET', '/auth/me')).status, 200);
});

test('deactivation (staff leaving) blocks access immediately and keeps the record', async () => {
  const id = await createUser(ctx.db, 'leaver@uni.test', 'DEPARTMENT_STAFF', deptA);
  const t = await login(ctx.app, 'leaver@uni.test');
  assert.equal((await api(ctx.app, admin)('POST', `/users/${id}/deactivate`, { reason: 'Left the university' })).status, 200);
  assert.equal((await api(ctx.app, t)('GET', '/auth/me')).status, 401, 'existing session rejected');
  const live = await ctx.db.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
  assert.equal(live.rows[0].n, 0, 'sessions revoked in the database, not only blocked by status check');
  const r = await api(ctx.app)('POST', '/auth/login', { email: 'leaver@uni.test', password: 'Correct-Horse-Battery-9' });
  assert.equal(r.body.error.code, 'ACCOUNT_DEACTIVATED');
  // Password reset cannot be used to get back in.
  await api(ctx.app)('POST', '/auth/forgot-password', { email: 'leaver@uni.test' });
  assert.equal(ctx.mailer.sent.filter((m) => m.to === 'leaver@uni.test').length, 0);
  const row = await ctx.db.query(`SELECT status, deactivation_reason FROM users WHERE id = $1`, [id]);
  assert.equal(row.rows[0].status, 'deactivated');
  // Reactivation restores access.
  assert.equal((await api(ctx.app, admin)('POST', `/users/${id}/activate`)).status, 200);
  await login(ctx.app, 'leaver@uni.test');
});

test('an admin cannot deactivate or demote themselves, and the last admin is protected', async () => {
  assert.equal((await api(ctx.app, admin)('POST', `/users/${adminId}/deactivate`, { reason: 'oops' })).status, 400);
  assert.equal((await api(ctx.app, admin)('PATCH', `/users/${adminId}`, { role: 'ASSET_MANAGER' })).status, 400);
  // A second admin also cannot remove the only other admin once alone.
  const id2 = await createUser(ctx.db, 'admin2@uni.test', 'SYSTEM_ADMIN');
  const admin2 = await login(ctx.app, 'admin2@uni.test');
  assert.equal((await api(ctx.app, admin2)('POST', `/users/${adminId}/deactivate`, { reason: 'Handover complete' })).status, 200);
  const r = await api(ctx.app, admin2)('PATCH', `/users/${id2}`, { role: 'ASSET_MANAGER' });
  assert.equal(r.status, 400);
  await ctx.db.query(`UPDATE users SET status = 'active' WHERE id = $1`, [adminId]);
  admin = await login(ctx.app, 'admin@uni.test');
});

test('admin-issued reset link works when email is unavailable', async () => {
  const { rows } = await ctx.db.query(`SELECT id FROM users WHERE email = 's@uni.test'`);
  const r = await api(ctx.app, admin)('POST', `/users/${rows[0].id}/reset-link`);
  assert.equal(r.status, 200);
  const set = await api(ctx.app)('POST', '/auth/reset-password', { token: tokenFromLink(r.body.link), newPassword: 'Admin-Issued-Reset-3' });
  assert.equal(set.status, 200);
  await login(ctx.app, 's@uni.test', 'Admin-Issued-Reset-3');
});

test('cross-department grant: audited, effective, and revocable', async () => {
  const { rows } = await ctx.db.query(`SELECT id FROM users WHERE email = 's@uni.test'`);
  const sid = rows[0].id;
  const noReason = await api(ctx.app, admin)('POST', `/users/${sid}/grants`, { departmentId: deptB, accessLevel: 'read', reason: '' });
  assert.equal(noReason.status, 400);
  const g = await api(ctx.app, admin)('POST', `/users/${sid}/grants`, { departmentId: deptB, accessLevel: 'read', reason: 'Joint stock-take 2026' });
  assert.equal(g.status, 201);
  const t = await login(ctx.app, 's@uni.test', 'Admin-Issued-Reset-3');
  let me = await api(ctx.app, t)('GET', '/auth/me');
  assert.deepEqual(new Set(me.body.user.permissions['assets.read']), new Set([deptA, deptB]));
  assert.deepEqual(me.body.user.permissions['assets.register'], [deptA]);
  assert.equal((await api(ctx.app, admin)('POST', `/users/${sid}/grants/${g.body.id}/revoke`)).status, 200);
  me = await api(ctx.app, t)('GET', '/auth/me');
  assert.deepEqual(me.body.user.permissions['assets.read'], [deptA]);
  const a = await ctx.db.query(`SELECT action FROM audit_events WHERE action LIKE 'scope_grant.%' ORDER BY id`);
  assert.deepEqual(a.rows.map((r) => r.action), ['scope_grant.create', 'scope_grant.revoke']);
});

test('expired grants stop applying', async () => {
  const { rows } = await ctx.db.query(`SELECT id FROM users WHERE email = 's@uni.test'`);
  await ctx.db.query(
    `INSERT INTO user_scope_grants (user_id, department_id, access_level, reason, granted_by, expires_at)
     VALUES ($1,$2,'operate','Temporary cover',$3, now() - interval '1 minute')`,
    [rows[0].id, deptB, adminId],
  );
  const t = await login(ctx.app, 's@uni.test', 'Admin-Issued-Reset-3');
  const me = await api(ctx.app, t)('GET', '/auth/me');
  assert.deepEqual(me.body.user.permissions['assets.register'], [deptA]);
});

test('user list supports search, filters and pagination', async () => {
  const r = await api(ctx.app, admin)('GET', `/users?q=mover&pageSize=1`);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 1);
  assert.equal(r.body.items[0].email, 'mover@uni.test');
  const byDept = await api(ctx.app, admin)('GET', `/users?departmentId=${deptB}`);
  assert.ok(byDept.body.items.every((u: any) => u.department?.id === deptB));
  // SQL wildcard characters are treated literally.
  const wild = await api(ctx.app, admin)('GET', `/users?q=%25`);
  assert.equal(wild.body.total, 0);
});

test('departments: admin manages them, codes are unique, changes are audited', async () => {
  const c = await api(ctx.app, admin)('POST', '/departments', { code: 'chem', name: 'Chemistry', defaultCurrency: 'tzs' });
  assert.equal(c.status, 201);
  assert.equal(c.body.code, 'CHEM');
  assert.equal(c.body.defaultCurrency, 'TZS');
  assert.equal((await api(ctx.app, admin)('POST', '/departments', { code: 'CHEM', name: 'Again', defaultCurrency: 'USD' })).status, 409);
  assert.equal((await api(ctx.app, admin)('POST', '/departments', { code: 'X1', name: 'Bad currency', defaultCurrency: 'US' })).status, 400);
  const u = await api(ctx.app, admin)('PATCH', `/departments/${c.body.id}`, { isActive: false });
  assert.equal(u.body.isActive, false);
  const a = await ctx.db.query(`SELECT before_data, after_data FROM audit_events WHERE action = 'department.update'`);
  assert.deepEqual(a.rows[0].after_data, { isActive: false });
});
