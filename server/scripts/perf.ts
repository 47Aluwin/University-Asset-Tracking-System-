// Performance check (NFR-4): times the main read paths with a large, throw-away in-memory database.
// Usage: node scripts/perf.ts [assetCount=100000]   — development only; nothing is written to disk.
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { migrate, openPglite } from '../src/db.ts';
import { MemoryMailer } from '../src/mailer.ts';
import { hashPassword } from '../src/security.ts';
import { LocalFileStore } from '../src/storage.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const N = Number(process.argv[2] ?? 100_000);
const db = await openPglite();
await migrate(db);
const t0 = Date.now();
await db.exec(`
  INSERT INTO departments (code, name, default_currency) SELECT 'D' || g, 'Department ' || g, CASE WHEN g % 2 = 0 THEN 'PGK' ELSE 'USD' END FROM generate_series(1, 20) g;
  INSERT INTO asset_categories (name) SELECT 'Category ' || g FROM generate_series(1, 15) g;
  INSERT INTO locations (department_id, building, room) SELECT d.id, 'Building ' || g, 'Room ' || g FROM departments d, generate_series(1, 10) g;
  INSERT INTO users (email, full_name, password_hash, role) VALUES ('admin@perf.test', 'Perf Admin', '${await hashPassword('Perf-Password-1234')}', 'SYSTEM_ADMIN');
  INSERT INTO verification_schedules (department_id, category_id, interval_days, due_window_days, created_by) SELECT NULL, NULL, 365, 30, id FROM users LIMIT 1;
`);
await db.exec(`
  WITH d AS (SELECT id, row_number() OVER (ORDER BY code) AS n FROM departments),
       c AS (SELECT id, row_number() OVER (ORDER BY name) AS n FROM asset_categories),
       u AS (SELECT id FROM users LIMIT 1)
  INSERT INTO assets (institutional_id, qr_payload, name, category_id, serial_number, owning_department_id, location_id,
                      acquisition_date, acquisition_method, acquisition_cost, currency, cost_status, condition,
                      registration_status, registered_at, registered_by, created_by, last_verified_at)
  SELECT 'UAT-2025-' || lpad(g::text, 6, '0'), 'UATS:UAT-2025-' || lpad(g::text, 6, '0'), 'Asset ' || g || ' laptop',
         (SELECT id FROM c WHERE n = 1 + g % 15), 'SN' || g, dd.id,
         (SELECT l.id FROM locations l WHERE l.department_id = dd.id ORDER BY l.room LIMIT 1),
         DATE '2020-01-01' + (g % 1800), 'purchase', 100 + (g % 5000), CASE WHEN dd.n % 2 = 0 THEN 'PGK' ELSE 'USD' END, 'recorded',
         (ARRAY['excellent','good','good','fair','damaged'])[1 + g % 5], 'registered', now() - make_interval(days => g % 700), (SELECT id FROM u), (SELECT id FROM u),
         CASE WHEN g % 3 = 0 THEN NULL ELSE now() - make_interval(days => g % 500) END
    FROM generate_series(1, ${N}) g JOIN d dd ON dd.n = 1 + g % 20;
  ANALYZE;
`);
console.log(`Loaded ${N.toLocaleString('en')} assets in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const uploads = mkdtempSync(path.join(tmpdir(), 'uats-perf-'));
const app = await buildApp({
  db,
  config: { ...loadConfig({ NODE_ENV: 'test', RATE_LIMIT_ENABLED: 'false', PUBLIC_APP_URL: 'http://perf.test' }), uploadDir: uploads },
  mailer: new MemoryMailer(),
  store: new LocalFileStore(uploads),
});
const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'admin@perf.test', password: 'Perf-Password-1234' } });
const auth = { authorization: `Bearer ${login.json().token}` };
const dept = (await db.query(`SELECT id FROM departments WHERE code = 'D3'`)).rows[0].id;

const checks: [string, string][] = [
  ['Asset list, first page', '/api/v1/assets?pageSize=50'],
  ['Asset search by text', '/api/v1/assets?q=laptop%2099&pageSize=50'],
  ['Find by asset code', '/api/v1/assets/lookup?code=UATS:UAT-2025-054321'],
  ['Overdue list', '/api/v1/assets?verification=overdue&sort=most_overdue&pageSize=50'],
  ['Dashboard (all departments)', '/api/v1/dashboard'],
  ['Dashboard (one department)', `/api/v1/dashboard?departmentId=${dept}`],
  ['Report preview: asset register', '/api/v1/reports/asset-register'],
  ['Report preview: verification', '/api/v1/reports/verification?status=overdue'],
  ['Excel export, one department', `/api/v1/reports/asset-register?format=xlsx&departmentId=${dept}`],
];
console.log('\n| Request | median of 5 | slowest |\n|---|---|---|');
for (const [label, url] of checks) {
  const times: number[] = [];
  let status = 0;
  for (let i = 0; i < 5; i++) {
    const s = performance.now();
    const r = await app.inject({ method: 'GET', url, headers: auth });
    times.push(performance.now() - s);
    status = r.statusCode;
  }
  times.sort((a, b) => a - b);
  console.log(`| ${label}${status === 200 ? '' : ` (HTTP ${status})`} | ${Math.round(times[2])} ms | ${Math.round(times[4])} ms |`);
}
await app.close();
await db.close();
rmSync(uploads, { recursive: true, force: true });
