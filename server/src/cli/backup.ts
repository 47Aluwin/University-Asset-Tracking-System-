// npm run backup [-- --out <folder>]
// Backs up the database and uploaded files into a new folder with a manifest. See docs/operations.md.
import path from 'node:path';

import { backup } from '../backup.ts';
import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';

const config = loadConfig();
const i = process.argv.indexOf('--out');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.resolve(i > 0 ? process.argv[i + 1] : path.join('backups', stamp));

if (!config.databaseUrl) {
  // The embedded development database can only be opened by one program at a time.
  const running = await fetch(`http://127.0.0.1:${config.port}/health`).then(() => true).catch(() => false);
  if (running) {
    console.error('Stop the API first: the embedded development database cannot be backed up while the API is using it.');
    process.exit(1);
  }
}
const db = await openDb(config);
try {
  const m = await backup({ db, uploadDir: config.uploadDir, outDir: out, databaseUrl: config.databaseUrl });
  const rows = Object.values(m.tables).reduce((a, b) => a + b, 0);
  console.log(`Backup written to ${out}`);
  console.log(`  database: ${m.database} (${Object.keys(m.tables).length} tables, ${rows} rows)`);
  console.log(`  files:    ${m.files.length} uploaded file(s)`);
  console.log(`  migrations: ${m.migrations.join(', ')}`);
} finally {
  await db.close();
}
