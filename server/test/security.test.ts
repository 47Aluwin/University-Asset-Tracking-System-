// Phase 7 security checks that look at the whole API rather than one feature.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { PUBLIC_ROUTES } from '../src/app.ts';
import { api, createDepartment, createUser, login, setup, type TestCtx } from './helpers.ts';

let ctx: TestCtx;
let routes: string[];

before(async () => {
  ctx = await setup();
  routes = [...new Set((ctx.app as unknown as { registeredRoutes: string[] }).registeredRoutes)].filter((r) => !r.startsWith('OPTIONS') && !r.startsWith('HEAD'));
});
after(() => ctx.close());

const fill = (url: string) => url.replace(/:[A-Za-z]+/g, (p) => (p === ':kind' ? 'asset-register' : randomUUID()));

test('every route refuses requests without a valid sign-in, except the listed public ones', async () => {
  assert.ok(routes.length > 60, `found ${routes.length} routes`);
  const unprotected: string[] = [];
  for (const r of routes) {
    const [method, url] = r.split(' ');
    if (PUBLIC_ROUTES.has(r) || url.includes('*')) continue;
    for (const headers of [{}, { authorization: `Bearer ${'x'.repeat(43)}` }]) {
      const res = await ctx.app.inject({ method: method as any, url: fill(url), headers, payload: method === 'GET' ? undefined : {} });
      if (res.statusCode !== 401) unprotected.push(`${r} → ${res.statusCode}`);
    }
  }
  assert.deepEqual(unprotected, [], 'routes reachable without signing in');
});

test('the public routes are exactly the intended ones and still work without a sign-in', async () => {
  for (const r of PUBLIC_ROUTES) assert.ok(routes.includes(r), `${r} is listed as public but does not exist`);
  assert.equal((await ctx.app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  assert.equal((await ctx.app.inject({ method: 'GET', url: '/api/v1/public/departments' })).statusCode, 200);
  const bad = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'nobody@uni.test', password: 'wrong-password-123' } });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json().error.code, 'INVALID_CREDENTIALS');
});

test('unknown websites are not given CORS access; responses carry security headers', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example' } });
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.headers['strict-transport-security']);
  assert.equal(res.headers['x-powered-by'], undefined);
});

test('search text is treated as data (no SQL injection) and oversized bodies are refused', async () => {
  const d = await createDepartment(ctx.db, 'SEC');
  await createUser(ctx.db, 'staff@uni.test', 'DEPARTMENT_STAFF', d);
  const t = await login(ctx.app, 'staff@uni.test');
  for (const q of ["' OR 1=1 --", "%'; DROP TABLE assets; --", '\\', '%_%']) {
    const r = await api(ctx.app, t)('GET', `/assets?q=${encodeURIComponent(q)}`);
    assert.equal(r.status, 200, q);
    assert.equal(r.body.total, 0, q);
  }
  assert.equal(Number((await ctx.db.query('SELECT count(*) AS n FROM assets')).rows[0].n), 0, 'table still there');
  const big = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(2 * 1024 * 1024) }) });
  assert.equal(big.statusCode, 413);
});

test('readiness check: ready when healthy, "not ready" when the schema is behind the code', async () => {
  const ok = await ctx.app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json().checks, { database: 'ok', migrations: 'ok', fileStorage: 'ok' });
  await ctx.db.query(`DELETE FROM schema_migrations WHERE version = '006_asset_review'`);
  const behind = await ctx.app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(behind.statusCode, 503);
  assert.equal(behind.json().checks.migrations, 'pending: 006_asset_review');
  await ctx.db.query(`INSERT INTO schema_migrations (version) VALUES ('006_asset_review')`);
});
