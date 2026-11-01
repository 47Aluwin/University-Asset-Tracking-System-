import { loadConfig } from '../config.ts';
import { migrate, openDb } from '../db.ts';

const config = loadConfig();
const db = await openDb(config);
const applied = await migrate(db, (m) => console.log(m));
console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
await db.close();
