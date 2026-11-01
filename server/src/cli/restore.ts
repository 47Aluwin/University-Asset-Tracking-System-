// Development:  npm run restore -- <backup folder> --data-dir <new empty folder> --upload-dir <new empty folder>
// Production:   restore with pg_restore and copy the uploads (docs/operations.md), then check the result with
//               npm run restore -- <backup folder> --verify-only     (uses DATABASE_URL and UPLOAD_DIR)
import path from 'node:path';

import { restorePglite, verifyRestore } from '../backup.ts';
import { loadConfig } from '../config.ts';
import { openDb, openPglite } from '../db.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const dir = process.argv[2];
if (!dir || dir.startsWith('--')) {
  console.error('Usage: npm run restore -- <backup folder> (--data-dir <dir> --upload-dir <dir> | --verify-only)');
  process.exit(1);
}
const backupDir = path.resolve(dir);
const config = loadConfig();

let db;
let uploadDir: string;
if (process.argv.includes('--verify-only')) {
  db = await openDb(config);
  uploadDir = config.uploadDir;
} else {
  const dataDir = arg('--data-dir');
  uploadDir = arg('--upload-dir') ?? '';
  if (!dataDir || !uploadDir) {
    console.error('Give a new, empty --data-dir and --upload-dir. Restores never overwrite existing data.');
    process.exit(1);
  }
  db = await openPglite(path.resolve(dataDir));
  await restorePglite(backupDir, db, path.resolve(uploadDir));
  console.log(`Restored into ${dataDir} (files in ${uploadDir}).`);
}
try {
  const check = await verifyRestore(backupDir, db, path.resolve(uploadDir));
  if (check.ok) console.log('Check passed: every table row count, file checksum and migration matches the backup.');
  else {
    console.error('Check FAILED:');
    for (const p of check.problems) console.error(`  - ${p}`);
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
