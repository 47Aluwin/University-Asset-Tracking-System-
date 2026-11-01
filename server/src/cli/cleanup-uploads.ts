// npm run cleanup-uploads [-- --delete]
// Lists uploaded files that no attachment refers to (left behind if saving a record failed after the file was
// written) and are more than a day old. Nothing is deleted unless --delete is given.
import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';

const config = loadConfig();
const db = await openDb(config);
const known = new Set((await db.query('SELECT storage_key FROM attachments')).rows.map((r) => r.storage_key as string));
await db.close();

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}
const dayAgo = Date.now() - 86400_000;
const remove = process.argv.includes('--delete');
let count = 0;
for await (const file of walk(config.uploadDir)) {
  const key = path.relative(config.uploadDir, file).split(path.sep).join('/');
  if (known.has(key) || (await stat(file)).mtimeMs > dayAgo) continue;
  count++;
  console.log(`${remove ? 'deleting' : 'unreferenced'}: ${key}`);
  if (remove) await unlink(file);
}
console.log(count ? `${count} unreferenced file(s)${remove ? ' deleted' : '. Run again with --delete to remove them'}.` : 'No unreferenced files.');
