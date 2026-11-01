import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  // Production: a PostgreSQL connection string. Dev/test: leave empty to use embedded PGlite.
  DATABASE_URL: z.string().optional(),
  // Folder for the embedded dev database. Empty = in-memory (lost on restart).
  PGLITE_DATA_DIR: z.string().default('.data/pglite'),
  // Where uploaded photos and documents are stored (development / single-server). Never inside a web root.
  UPLOAD_DIR: z.string().default('.data/uploads'),
  MAX_UPLOAD_MB: z.coerce.number().min(1).max(50).default(5),
  REPORT_MAX_ROWS: z.coerce.number().int().min(100).max(200000).default(20000),
  // Comma-separated list of browser origins allowed to call the API.
  CORS_ORIGINS: z.string().default('http://localhost:8081,http://localhost:19006'),
  // Base URL of the web app, used to build password reset links.
  PUBLIC_APP_URL: z.string().url().default('http://localhost:8081'),
  TRUST_PROXY: bool.default(false),
  RATE_LIMIT_ENABLED: bool.default(true),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Help assistant (optional). Choose the AI service; without its key the assistant is switched off.
  ASSISTANT_PROVIDER: z.enum(['gemini', 'claude']).default('gemini'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ASSISTANT_MODEL: z.string().default('claude-haiku-5-5'),
});

export type Config = {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl?: string;
  pgliteDataDir?: string;
  uploadDir: string;
  maxUploadBytes: number;
  /** Largest number of rows one report table may export; bigger exports are refused with advice to narrow filters. */
  reportMaxRows: number;
  corsOrigins: string[];
  publicAppUrl: string;
  trustProxy: boolean;
  rateLimitEnabled: boolean;
  logLevel: string;
  assistant: { provider: 'gemini' | 'claude'; geminiKey?: string; geminiModel: string; claudeKey?: string; claudeModel: string };
  auth: {
    maxFailedAttempts: number;
    baseLockoutMinutes: number;
    maxLockoutMinutes: number;
    resetTokenMinutes: number;
    setupTokenHours: number;
    web: { idleSeconds: number; absoluteSeconds: number };
    mobile: { idleSeconds: number; absoluteSeconds: number };
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${msg}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production' && !e.DATABASE_URL) {
    throw new Error('DATABASE_URL is required in production (embedded PGlite is for development only).');
  }
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL || undefined,
    pgliteDataDir: e.PGLITE_DATA_DIR || undefined,
    uploadDir: e.UPLOAD_DIR,
    maxUploadBytes: Math.round(e.MAX_UPLOAD_MB * 1024 * 1024),
    reportMaxRows: e.REPORT_MAX_ROWS,
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    publicAppUrl: e.PUBLIC_APP_URL.replace(/\/$/, ''),
    trustProxy: e.TRUST_PROXY,
    rateLimitEnabled: e.RATE_LIMIT_ENABLED,
    logLevel: e.LOG_LEVEL,
    assistant: {
      provider: e.ASSISTANT_PROVIDER,
      geminiKey: e.GEMINI_API_KEY?.trim() || undefined,
      geminiModel: e.GEMINI_MODEL,
      claudeKey: e.ANTHROPIC_API_KEY?.trim() || undefined,
      claudeModel: e.ASSISTANT_MODEL,
    },
    auth: defaultAuthPolicy(),
  };
}

export function defaultAuthPolicy(): Config['auth'] {
  return {
    maxFailedAttempts: 5,
    baseLockoutMinutes: 15,
    maxLockoutMinutes: 24 * 60,
    resetTokenMinutes: 30,
    setupTokenHours: 72,
    web: { idleSeconds: 12 * 3600, absoluteSeconds: 7 * 24 * 3600 },
    mobile: { idleSeconds: 30 * 24 * 3600, absoluteSeconds: 30 * 24 * 3600 },
  };
}
