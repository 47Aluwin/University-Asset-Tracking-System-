// Creates a System Administrator and prints a one-time password setup link.
// Usage: npm run create-admin -- --email admin@university.example --name "Full Name"
import { parseArgs } from 'node:util';
import { issueResetToken, resetLink } from '../accounts.ts';
import { audit } from '../audit.ts';
import { loadConfig } from '../config.ts';
import { migrate, openDb } from '../db.ts';
import { EmailSchema } from '../security.ts';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
const email = EmailSchema.safeParse(values.email ?? '');
if (!email.success || !values.name || values.name.trim().length < 2) {
  console.error('Usage: npm run create-admin -- --email <email> --name "<full name>"');
  process.exit(1);
}
const config = loadConfig();
const db = await openDb(config);
await migrate(db);
try {
  const { token, expiresAt } = await db.tx(async (q) => {
    if ((await q.query('SELECT 1 FROM users WHERE email = $1', [email.data])).rows[0]) {
      throw new Error('An account with this email already exists.');
    }
    const { rows } = await q.query(
      `INSERT INTO users (email, full_name, role) VALUES ($1, $2, 'SYSTEM_ADMIN') RETURNING id`,
      [email.data, values.name!.trim()],
    );
    await audit(q, { actorId: null, action: 'user.create', entityType: 'user', entityId: rows[0].id, after: { email: email.data, role: 'SYSTEM_ADMIN', source: 'cli' } });
    return issueResetToken(q, config, rows[0].id, 'setup', null);
  });
  console.log(`Administrator created. Open this link to set the password (expires ${expiresAt.toISOString()}):`);
  console.log(resetLink(config, token));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
