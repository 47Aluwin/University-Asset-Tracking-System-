// Development only: creates example departments so the app can be explored locally.
// Never run against production; refuses when NODE_ENV=production or DATABASE_URL is set.
import { loadConfig } from '../config.ts';
import { migrate, openDb } from '../db.ts';

const config = loadConfig();
if (config.env === 'production' || config.databaseUrl) {
  console.error('seed-dev only runs against the embedded development database.');
  process.exit(1);
}
const db = await openDb(config);
await migrate(db);
const depts = [
  ['DEVCS', 'Dev: Computer Science', 'USD'],
  ['DEVENG', 'Dev: Engineering', 'USD'],
  ['DEVLIB', 'Dev: Library', 'EUR'],
];
for (const [code, name, cur] of depts) {
  await db.query(
    `INSERT INTO departments (code, name, default_currency) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING`,
    [code, name, cur],
  );
}
// Reference data only. No asset records are seeded: assets are always entered through the app.
for (const name of ['Dev: Computers', 'Dev: Lab equipment', 'Dev: Furniture', 'Dev: Audio-visual']) {
  await db.query(
    `INSERT INTO asset_categories (name) SELECT $1::text WHERE NOT EXISTS (SELECT 1 FROM asset_categories WHERE lower(name) = lower($1::text))`,
    [name],
  );
}
const rooms: [string, string, string][] = [
  ['DEVCS', 'Dev: Science Block', 'Lab 101'],
  ['DEVCS', 'Dev: Science Block', 'Office 204'],
  ['DEVENG', 'Dev: Workshop', 'Bay 1'],
  ['DEVLIB', 'Dev: Main Library', 'Ground floor'],
];
for (const [code, building, room] of rooms) {
  await db.query(
    `INSERT INTO locations (department_id, building, room)
     SELECT d.id, $2, $3 FROM departments d WHERE d.code = $1
     ON CONFLICT DO NOTHING`,
    [code, building, room],
  );
}
console.log('Development departments, categories and locations ready (prefixed "Dev:" so they are never mistaken for real data).');
await db.close();
