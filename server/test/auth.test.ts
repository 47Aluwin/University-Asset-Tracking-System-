// Integration tests: sign-in, lockout, sessions, password change and reset.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, createDepartment, createUser, login, PASSWORD, setup, tokenFromLink, type TestCtx } from './helpers.ts';

let ctx: TestCtx;
let deptA: string;

before(async () => {
  ctx = await setup();
  deptA = await createDepartment(ctx.db, 'AAA');
  await createUser(ctx.db, 'admin@uni.test', 'SYSTEM_ADMIN');
});
after(() => ctx.close());

test('valid credentials return a session token and the user profile', async () => {
  await createUser(ctx.db, 'staff1@uni.test', 'DEPARTMENT_STAFF', deptA);
  const r = await api(ctx.app)('POST', '/auth/login', { email: 'STAFF1@uni.test', password: PASSWORD });
  assert.equal(r.status, 200);
  assert.ok(r.body.token.length >= 40);
  assert.equal(r.body.user.role, 'DEPARTMENT_STAFF');
  assert.deepEqual(r.body.user.permissions['assets.register'], [deptA]);
  // Token is stored only as a hash.
  const s = await ctx.db.query('SELECT token_hash FROM sessions');
  assert.ok(s.rows.every((x) => x.token_hash !== r.body.token));
});

test('wrong password and unknown email give the same generic error', async () => {
  const a = await api(ctx.app)('POST', '/auth/login', { email: 'staff1@uni.test', password: 'wrong-password-123' });
  const b = await api(ctx.app)('POST', '/auth/login', { email: 'nobody@uni.test', password: 'wrong-password-123' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.body.error.code, 'INVALID_CREDENTIALS');
  assert.deepEqual(a.body.error.message, b.body.error.message);
});

test('protected routes reject missing, malformed and unknown tokens', async () => {
  assert.equal((await api(ctx.app)('GET', '/auth/me')).status, 401);
  assert.equal((await api(ctx.app, 'not-a-real-token')('GET', '/auth/me')).status, 401);
  assert.equal((await api(ctx.app, 'x'.repeat(500))('GET', '/auth/me')).status, 401);
});

test('five failed attempts lock the account, even against the correct password', async () => {
  await createUser(ctx.db, 'lock@uni.test', 'DEPARTMENT_STAFF', deptA);
  const call = api(ctx.app);
  for (let i = 0; i < 4; i++) {
    assert.equal((await call('POST', '/auth/login', { email: 'lock@uni.test', password: 'bad-password-xyz' })).status, 401);
  }
  const fifth = await call('POST', '/auth/login', { email: 'lock@uni.test', password: 'bad-password-xyz' });
  assert.equal(fifth.status, 423);
  assert.equal(fifth.body.error.code, 'ACCOUNT_LOCKED');
  assert.ok(Number(fifth.headers['retry-after']) > 800);
  const good = await call('POST', '/auth/login', { email: 'lock@uni.test', password: PASSWORD });
  assert.equal(good.status, 423);
  const audit = await ctx.db.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'auth.lockout'`);
  assert.equal(audit.rows[0].n, 1);
});

test('lockout duration doubles on repeated lockouts', async () => {
  const id = await createUser(ctx.db, 'lock2@uni.test', 'DEPARTMENT_STAFF', deptA);
  await ctx.db.query(`UPDATE users SET lockout_count = 1, failed_login_count = 4 WHERE id = $1`, [id]);
  const r = await api(ctx.app)('POST', '/auth/login', { email: 'lock2@uni.test', password: 'bad-password-xyz' });
  assert.equal(r.status, 423);
  assert.ok(r.body.error.details.retryAfterSeconds > 29 * 60, 'second lockout should be ~30 minutes');
});

test('admin can unlock a locked account', async () => {
  const admin = await login(ctx.app, 'admin@uni.test');
  const { rows } = await ctx.db.query(`SELECT id FROM users WHERE email = 'lock@uni.test'`);
  assert.equal((await api(ctx.app, admin)('POST', `/users/${rows[0].id}/unlock`)).status, 200);
  assert.equal((await api(ctx.app)('POST', '/auth/login', { email: 'lock@uni.test', password: PASSWORD })).status, 200);
});

test('logout revokes the session', async () => {
  const token = await login(ctx.app, 'staff1@uni.test');
  const call = api(ctx.app, token);
  assert.equal((await call('POST', '/auth/logout')).status, 200);
  assert.equal((await call('GET', '/auth/me')).status, 401);
});

test('expired and idle sessions are rejected', async () => {
  const t1 = await login(ctx.app, 'staff1@uni.test');
  await ctx.db.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE revoked_at IS NULL`);
  assert.equal((await api(ctx.app, t1)('GET', '/auth/me')).status, 401);
  const t2 = await login(ctx.app, 'staff1@uni.test');
  await ctx.db.query(`UPDATE sessions SET last_seen_at = now() - interval '13 hours' WHERE revoked_at IS NULL AND expires_at > now()`);
  assert.equal((await api(ctx.app, t2)('GET', '/auth/me')).status, 401);
});

test('changing password requires the current one and revokes other sessions', async () => {
  await createUser(ctx.db, 'change@uni.test', 'DEPARTMENT_STAFF', deptA);
  const phone = await login(ctx.app, 'change@uni.test');
  const laptop = await login(ctx.app, 'change@uni.test');
  const wrong = await api(ctx.app, laptop)('POST', '/auth/change-password', { currentPassword: 'nope', newPassword: 'Another-Strong-Pass-1' });
  assert.equal(wrong.status, 400);
  const weak = await api(ctx.app, laptop)('POST', '/auth/change-password', { currentPassword: PASSWORD, newPassword: 'short' });
  assert.equal(weak.status, 400);
  const ok = await api(ctx.app, laptop)('POST', '/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Another-Strong-Pass-1' });
  assert.equal(ok.status, 200);
  assert.equal((await api(ctx.app, laptop)('GET', '/auth/me')).status, 200, 'current session kept');
  assert.equal((await api(ctx.app, phone)('GET', '/auth/me')).status, 401, 'other sessions revoked');
  await login(ctx.app, 'change@uni.test', 'Another-Strong-Pass-1');
});

test('password containing the email name is refused', async () => {
  const t = await login(ctx.app, 'staff1@uni.test');
  const r = await api(ctx.app, t)('POST', '/auth/change-password', { currentPassword: PASSWORD, newPassword: 'my-staff1-password!' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'WEAK_PASSWORD');
});

test('forgot password: same response for unknown email; reset link is single-use and revokes sessions', async () => {
  await createUser(ctx.db, 'forgot@uni.test', 'DEPARTMENT_STAFF', deptA);
  const old = await login(ctx.app, 'forgot@uni.test');
  const call = api(ctx.app);
  const unknown = await call('POST', '/auth/forgot-password', { email: 'ghost@uni.test' });
  const known = await call('POST', '/auth/forgot-password', { email: 'forgot@uni.test' });
  assert.equal(unknown.status, 202);
  assert.equal(known.status, 202);
  assert.deepEqual(unknown.body, known.body);
  assert.equal(ctx.mailer.sent.length, 1);
  const link = ctx.mailer.sent[0].text.match(/http\S+/)![0];
  const token = tokenFromLink(link);

  const reset = await call('POST', '/auth/reset-password', { token, newPassword: 'Brand-New-Password-7' });
  assert.equal(reset.status, 200);
  const again = await call('POST', '/auth/reset-password', { token, newPassword: 'Second-Attempt-Pass-8' });
  assert.equal(again.status, 400);
  assert.equal(again.body.error.code, 'INVALID_RESET_TOKEN');
  assert.equal((await api(ctx.app, old)('GET', '/auth/me')).status, 401);
  await login(ctx.app, 'forgot@uni.test', 'Brand-New-Password-7');
});

test('expired reset tokens are refused, and a new request invalidates the previous link', async () => {
  ctx.mailer.sent.length = 0;
  await api(ctx.app)('POST', '/auth/forgot-password', { email: 'staff1@uni.test' });
  await api(ctx.app)('POST', '/auth/forgot-password', { email: 'staff1@uni.test' });
  const [first, second] = ctx.mailer.sent.map((m) => tokenFromLink(m.text.match(/http\S+/)![0]));
  const r1 = await api(ctx.app)('POST', '/auth/reset-password', { token: first, newPassword: 'Brand-New-Password-7' });
  assert.equal(r1.status, 400, 'older link invalidated');
  await ctx.db.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL`);
  const r2 = await api(ctx.app)('POST', '/auth/reset-password', { token: second, newPassword: 'Brand-New-Password-7' });
  assert.equal(r2.status, 400, 'expired link refused');
});

test('no passwords, hashes or tokens are written to the audit log', async () => {
  const { rows } = await ctx.db.query(`SELECT before_data::text || after_data::text || context::text AS t FROM audit_events`);
  for (const r of rows) {
    assert.ok(!/password|token|argon2/i.test(r.t ?? ''), `audit contains secret-like data: ${r.t}`);
  }
});

test('checking a reset link shows its account without using it up', async () => {
  ctx.mailer.sent.length = 0;
  await createUser(ctx.db, 'peek@uni.test', 'DEPARTMENT_STAFF', deptA);
  await api(ctx.app)('POST', '/auth/forgot-password', { email: 'peek@uni.test' });
  const token = tokenFromLink(ctx.mailer.sent[0].text.match(/http\S+/)![0]);
  const call = api(ctx.app);
  const c1 = await call('POST', '/auth/reset-password/check', { token });
  assert.equal(c1.status, 200);
  assert.equal(c1.body.email, 'peek@uni.test');
  assert.equal(c1.body.purpose, 'reset');
  assert.equal((await call('POST', '/auth/reset-password/check', { token })).status, 200, 'checking twice still works');
  assert.equal((await call('POST', '/auth/reset-password', { token, newPassword: 'Checked-Then-Used-11' })).status, 200);
  const after = await call('POST', '/auth/reset-password/check', { token });
  assert.equal(after.status, 400);
  assert.equal(after.body.error.code, 'INVALID_RESET_TOKEN');
  assert.equal((await call('POST', '/auth/reset-password/check', { token: 'x'.repeat(43) })).status, 400);
});
