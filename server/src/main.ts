import { buildApp } from './app.ts';
import { createAssistant } from './assistant.ts';
import { loadConfig } from './config.ts';
import { migrate, openDb } from './db.ts';
import { ConsoleMailer, DisabledMailer } from './mailer.ts';
import { LocalFileStore } from './storage.ts';

const config = loadConfig();
const db = await openDb(config);
await migrate(db, (m) => console.log(m));
const mailer =
  config.env === 'production' ? new DisabledMailer((m) => console.warn(m)) : new ConsoleMailer();
const store = new LocalFileStore(config.uploadDir);
const assistant = createAssistant(config);
console.log(
  assistant
    ? `Help assistant on (${config.assistant.provider}, model ${assistant.model}).`
    : `Help assistant off (${config.assistant.provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'} not set).`,
);
const app = await buildApp({ db, config, mailer, store, assistant });

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
console.log(`API listening on http://${config.host}:${config.port} (database: ${db.engine})`);
