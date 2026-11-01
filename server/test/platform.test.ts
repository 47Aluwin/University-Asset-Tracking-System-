// Database integrity, migrations, audit-log protection, settings validation, rate limiting.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../src/db.ts';
import { api, createDepartment, createUser, login, setup, type TestCtx } from './helpers.ts';

let ctx: TestCtx;

before(async () => {
  ctx = await setup();
});
after(() => ctx.close());

test('migrations are recorded and re-running them is a no-op', async () => {
  const again = await migrate(ctx.db);
  assert.deepEqual(again, []);
  const { rows } = await ctx.db.query('SELECT version FROM schema_migrations');
  assert.ok(rows.some((r) => r.version === '001_foundation'));
});

test('database constraints back up the application rules', async () => {
  await assert.rejects(
    ctx.db.query(`INSERT INTO users (email, full_name, role) VALUES ('nodept@uni.test','No Dept','DEPARTMENT_STAFF')`),
    /staff_requires_department/,
  );
  await assert.rejects(ctx.db.query(`INSERT INTO users (email, full_name, role) VALUES ('Upper@uni.test','Upper','SYSTEM_ADMIN')`));
  await assert.rejects(ctx.db.query(`INSERT INTO users (email, full_name, role) VALUES ('h@uni.test','Head','DEPARTMENT_HEAD')`));
  await assert.rejects(ctx.db.query(`INSERT INTO departments (code, name, default_currency) VALUES ('X','X dept','usd')`));
});

test('audit log rows cannot be updated, deleted or truncated', async () => {
  await ctx.db.query(`INSERT INTO audit_events (action, entity_type) VALUES ('test.event', 'test')`);
  await assert.rejects(ctx.db.query(`UPDATE audit_events SET action = 'changed'`), /append-only/);
  await assert.rejects(ctx.db.query(`DELETE FROM audit_events`), /append-only/);
  await assert.rejects(ctx.db.exec(`TRUNCATE audit_events`), /append-only/);
});

test('audit log is readable by admins with filters', async () => {
  await createUser(ctx.db, 'admin@uni.test', 'SYSTEM_ADMIN');
  const t = await login(ctx.app, 'admin@uni.test');
  const r = await api(ctx.app, t)('GET', '/audit-events?action=auth.login');
  assert.equal(r.status, 200);
  assert.ok(r.body.items.length >= 1);
  assert.ok(r.body.items.every((i: any) => i.action === 'auth.login'));
});

test('settings are validated and changes audited', async () => {
  const t = await login(ctx.app, 'admin@uni.test');
  const call = api(ctx.app, t);
  assert.equal((await call('PUT', '/settings/institution_time_zone', { value: 'Mars/Olympus' })).status, 400);
  assert.equal((await call('PUT', '/settings/institution_time_zone', { value: 'Africa/Dar_es_Salaam' })).status, 200);
  assert.equal((await call('PUT', '/settings/not_a_setting', { value: 1 })).status, 400);
  assert.equal((await call('PUT', '/settings/allow_unknown_cost', { value: 'yes' })).status, 400);
  const s = await call('GET', '/settings');
  assert.equal(s.body.items.find((i: any) => i.key === 'institution_time_zone').value, 'Africa/Dar_es_Salaam');
  const a = await ctx.db.query(`SELECT before_data, after_data FROM audit_events WHERE action = 'settings.update'`);
  assert.equal(a.rows[0].before_data, 'UTC');
  assert.equal(a.rows[0].after_data, 'Africa/Dar_es_Salaam');
});

test('invalid JSON and oversized input get safe error responses', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: '{"email": ',
  });
  assert.equal(res.statusCode, 400);
  assert.ok(!/stack|at \w+ \(/.test(res.body), 'no stack trace leaked');
  const big = await api(ctx.app)('POST', '/access-requests', { fullName: 'x'.repeat(5000) });
  assert.equal(big.status, 400);
});

test('security headers are set', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.headers['strict-transport-security']);
});

test('sign-in is rate limited per client address', async () => {
  const limited = await setup({ rateLimit: true });
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await api(limited.app)('POST', '/auth/login', { email: 'nobody@uni.test', password: 'whatever-password' });
      statuses.push(r.status);
    }
    assert.equal(statuses.filter((s) => s === 401).length, 10);
    assert.equal(statuses.at(-1), 429);
  } finally {
    await limited.close();
  }
});

test('production configuration refuses to start without a real database', async () => {
  const { loadConfig } = await import('../src/config.ts');
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /DATABASE_URL is required/);
});

test('department helper sanity', async () => {
  const id = await createDepartment(ctx.db, 'ZZZ', 'GBP');
  assert.match(id, /^[0-9a-f-]{36}$/);
});
