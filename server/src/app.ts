import { access, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { ZodError, type z } from 'zod';

import type { Config } from './config.ts';
import { pendingMigrations, type Db } from './db.ts';
import type { Assistant } from './assistant.ts';
import type { Mailer } from './mailer.ts';
import type { FileStore } from './storage.ts';
import { AppError, forbidden, unauthenticated } from './errors.ts';
import { can, type Grant, type Permission, type Principal, type Role } from './authz.ts';
import { audit } from './audit.ts';
import { sha256 } from './security.ts';
import { authRoutes } from './routes/auth.ts';
import { accessRequestRoutes } from './routes/access-requests.ts';
import { userRoutes } from './routes/users.ts';
import { departmentRoutes } from './routes/departments.ts';
import { adminRoutes } from './routes/admin.ts';
import { assetRoutes } from './routes/assets.ts';
import { catalogRoutes } from './routes/catalog.ts';
import { verificationRoutes } from './routes/verification.ts';
import { maintenanceRoutes } from './routes/maintenance.ts';
import { reportRoutes } from './routes/reports.ts';
import { syncRoutes } from './routes/sync.ts';
import { assistantRoutes } from './routes/assistant.ts';
import { reviewRoutes } from './routes/reviews.ts';

/** `assistant`: the help assistant, or null/absent when no AI key is configured. */
export type AppDeps = { db: Db; config: Config; mailer: Mailer; store: FileStore; assistant?: Assistant | null };

/** The only routes that work without signing in. */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'GET /health',
  'GET /health/ready',
  'GET /api/v1/public/departments',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/forgot-password',
  'POST /api/v1/auth/reset-password/check',
  'POST /api/v1/auth/reset-password',
  'POST /api/v1/access-requests',
]);

export type AuthUser = Principal & {
  email: string;
  fullName: string;
  sessionId: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db } = deps;
  const app = Fastify({
    logger:
      config.env === 'test'
        ? false
        : {
            level: config.logLevel,
            // Never log credentials or tokens.
            redact: ['req.headers.authorization', 'req.headers.cookie', 'body.password', 'body.token'],
          },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  // Every route is recorded so a test can check that each one refuses requests without a sign-in.
  const registeredRoutes: string[] = [];
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) registeredRoutes.push(`${m} ${r.url}`);
  });
  app.decorate('registeredRoutes', registeredRoutes);

  await app.register(helmet, { contentSecurityPolicy: false }); // API serves JSON only.
  await app.register(cors, {
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Operation-Id'],
    exposedHeaders: ['Content-Disposition'], // lets the web app name downloaded report files
  });
  // File uploads: one file per request, size-limited; files are type-checked and stored by the routes.
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5, parts: 6 } });
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitEnabled ? 300 : 1_000_000,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: { code: 'RATE_LIMITED', message: `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)} seconds.` },
    }),
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Some fields are missing or invalid.',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { statusCode?: number; message?: string; code?: string };
    if (e.statusCode === 429) return reply.status(429).send(err);
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message: e.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
  });

  // Resolve the session (if any) before every request. Routes decide whether it is required.
  app.addHook('preHandler', async (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;
    const token = header.slice(7).trim();
    if (!token || token.length > 200) return;
    req.user = await resolveSession(db, token);
  });

  // Defence in depth: every route requires a valid sign-in unless it is listed as public, even if a route
  // forgets its own check. (Routes still check role and department permissions themselves.)
  app.addHook('preHandler', async (req) => {
    const url = req.routeOptions.url;
    if (req.user || !url || req.method === 'OPTIONS') return;
    if (!PUBLIC_ROUTES.has(`${req.method === 'HEAD' ? 'GET' : req.method} ${url}`)) throw unauthenticated();
  });

  // Liveness: the process is up and can reach the database.
  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { status: 'ok' };
  });

  // Readiness, for load balancers and monitoring: database reachable, schema up to date, file storage writable.
  app.get('/health/ready', async (_req, reply) => {
    const checks: Record<string, 'ok' | string> = {};
    const started = Date.now();
    try {
      await db.query('SELECT 1');
      checks.database = 'ok';
      const pending = await pendingMigrations(db);
      checks.migrations = pending.length ? `pending: ${pending.join(', ')}` : 'ok';
    } catch {
      checks.database = 'unreachable';
    }
    try {
      await mkdir(config.uploadDir, { recursive: true });
      await access(config.uploadDir, fsConstants.W_OK);
      checks.fileStorage = 'ok';
    } catch {
      checks.fileStorage = 'not writable';
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not ready', checks, responseMs: Date.now() - started });
  });

  await app.register(
    async (api) => {
      authRoutes(api, deps);
      accessRequestRoutes(api, deps);
      userRoutes(api, deps);
      departmentRoutes(api, deps);
      adminRoutes(api, deps);
      catalogRoutes(api, deps);
      assetRoutes(api, deps);
      verificationRoutes(api, deps);
      maintenanceRoutes(api, deps);
      reportRoutes(api, deps);
      syncRoutes(api, deps);
      reviewRoutes(api, deps);
      assistantRoutes(api, deps);
    },
    { prefix: '/api/v1' },
  );

  return app;
}

async function resolveSession(db: Db, token: string): Promise<AuthUser | undefined> {
  const { rows } = await db.query(
    `SELECT s.id AS session_id, u.id, u.email, u.full_name, u.role, u.department_id,
            (s.last_seen_at < now() - interval '60 seconds') AS stale
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.last_seen_at + make_interval(secs => s.idle_timeout_s) > now()
        AND u.status = 'active'`,
    [sha256(token)],
  );
  const r = rows[0];
  if (!r) return undefined;
  if (r.stale) await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [r.session_id]);
  const grants = await db.query(
    `SELECT department_id, access_level FROM user_scope_grants
      WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [r.id],
  );
  return {
    id: r.id,
    email: r.email,
    fullName: r.full_name,
    role: r.role as Role,
    departmentId: r.department_id,
    grants: grants.rows.map((g): Grant => ({ departmentId: g.department_id, level: g.access_level })),
    sessionId: r.session_id,
  };
}

// ---------- helpers shared by route modules ----------

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthenticated();
  return req.user;
}

/** Throws 403 (and records the denial) unless the user holds `perm` for `departmentId`. */
export async function requirePermission(
  db: Db,
  req: FastifyRequest,
  perm: Permission,
  departmentId?: string | null,
): Promise<AuthUser> {
  const user = requireUser(req);
  if (!can(user, perm, departmentId)) {
    await audit(db, {
      actorId: user.id,
      action: 'authz.denied',
      entityType: 'permission',
      entityId: perm,
      departmentId: departmentId ?? null,
      outcome: 'denied',
      context: { method: req.method, url: req.url },
      ip: req.ip,
    });
    throw forbidden();
  }
  return user;
}

/** Stricter per-route rate limit (disabled limits become effectively unlimited, e.g. in tests). */
export function routeLimit(config: Config, max: number, minutes: number) {
  return { rateLimit: { max: config.rateLimitEnabled ? max : 1_000_000, timeWindow: minutes * 60_000 } };
}

export const parse = <S extends z.ZodType>(schema: S, data: unknown): z.infer<S> => schema.parse(data);

export function pageParams(q: { page?: number; pageSize?: number }) {
  const pageSize = Math.min(Math.max(q.pageSize ?? 50, 1), 100);
  const page = Math.max(q.page ?? 1, 1);
  return { limit: pageSize, offset: (page - 1) * pageSize, page, pageSize };
}
