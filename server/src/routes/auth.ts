import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { parse, requireUser, routeLimit, type AppDeps } from '../app.ts';
import { attemptLogin, consumeResetToken, createSession, issueResetToken, peekResetToken, resetLink, setPassword } from '../accounts.ts';
import { audit } from '../audit.ts';
import { describePermissions } from '../authz.ts';
import { AppError } from '../errors.ts';
import { EmailSchema, PasswordSchema, verifyPassword } from '../security.ts';

const LoginBody = z.strictObject({
  email: EmailSchema,
  password: z.string().min(1).max(256),
  client: z.enum(['web', 'mobile']).default('web'),
});

const LOGIN_MESSAGES = {
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  ACCOUNT_LOCKED: 'Too many failed attempts. This account is temporarily locked.',
  ACCOUNT_DEACTIVATED: 'This account has been deactivated. Contact a system administrator.',
  ACCOUNT_PENDING: 'Your access request is awaiting administrator approval.',
  ACCESS_REJECTED: 'Your access request was not approved. Contact a system administrator.',
} as const;

export function authRoutes(app: FastifyInstance, { db, config, mailer }: AppDeps) {
  const strict = (max: number, minutes: number) => routeLimit(config, max, minutes);

  app.post('/auth/login', { config: strict(10, 1) }, async (req, reply) => {
    const body = parse(LoginBody, req.body);
    const result = await attemptLogin(db, config, body.email, body.password, req.ip);
    if (!result.ok) {
      const status = result.code === 'INVALID_CREDENTIALS' ? 401 : result.code === 'ACCOUNT_LOCKED' ? 423 : 403;
      if (result.retryAfterSeconds) reply.header('Retry-After', String(result.retryAfterSeconds));
      throw new AppError(status, result.code, LOGIN_MESSAGES[result.code], result.retryAfterSeconds ? { retryAfterSeconds: result.retryAfterSeconds } : undefined);
    }
    const session = await db.tx(async (q) => {
      const s = await createSession(q, config, result.userId, body.client, { userAgent: req.headers['user-agent'], ip: req.ip });
      await audit(q, { actorId: result.userId, action: 'auth.login', entityType: 'user', entityId: result.userId, context: { client: body.client }, ip: req.ip });
      return s;
    });
    return { token: session.token, expiresAt: session.expiresAt, user: await loadMe(result.userId) };
  });

  app.post('/auth/logout', async (req) => {
    const user = requireUser(req);
    await db.tx(async (q) => {
      await q.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'logout' WHERE id = $1`, [user.sessionId]);
      await audit(q, { actorId: user.id, action: 'auth.logout', entityType: 'user', entityId: user.id, ip: req.ip });
    });
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const user = requireUser(req);
    return { user: await loadMe(user.id) };
  });

  app.post('/auth/change-password', { config: strict(10, 15) }, async (req) => {
    const user = requireUser(req);
    const body = parse(z.strictObject({ currentPassword: z.string().max(256), newPassword: PasswordSchema }), req.body);
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!(await verifyPassword(rows[0]?.password_hash, body.currentPassword))) {
      throw new AppError(400, 'WRONG_PASSWORD', 'Current password is incorrect.');
    }
    await db.tx(async (q) => {
      await setPassword(q, user.id, user.email, body.newPassword, user.sessionId);
      await audit(q, { actorId: user.id, action: 'auth.password_change', entityType: 'user', entityId: user.id, departmentId: user.departmentId, ip: req.ip });
    });
    return { ok: true };
  });

  // Always answers 202 so the response does not reveal whether an account exists.
  app.post('/auth/forgot-password', { config: strict(5, 15) }, async (req, reply) => {
    const { email } = parse(z.strictObject({ email: EmailSchema }), req.body);
    const { rows } = await db.query(`SELECT id, full_name FROM users WHERE email = $1 AND status = 'active'`, [email]);
    if (rows[0] && mailer.configured) {
      const { token } = await db.tx(async (q) => {
        const t = await issueResetToken(q, config, rows[0].id, 'reset', null);
        await audit(q, { actorId: null, action: 'auth.reset_requested', entityType: 'user', entityId: rows[0].id, ip: req.ip });
        return t;
      });
      await mailer.send({
        to: email,
        subject: 'Reset your Asset Tracking System password',
        text: `Hello ${rows[0].full_name},\n\nUse this link within ${config.auth.resetTokenMinutes} minutes to set a new password:\n${resetLink(config, token)}\n\nIf you did not ask for this, ignore this message.`,
      });
    }
    return reply.status(202).send({
      ok: true,
      message: mailer.configured
        ? 'If an active account uses that email, a reset link has been sent.'
        : 'Email is not configured on this system. Ask a system administrator for a password reset link.',
    });
  });

  // Lets the password page show which account a link is for, and say up front if the link is no longer valid.
  // POST (not GET) so the token is never written to access logs as part of a URL.
  app.post('/auth/reset-password/check', { config: strict(30, 15) }, async (req) => {
    const { token } = parse(z.strictObject({ token: z.string().min(20).max(200) }), req.body);
    const t = await peekResetToken(db, token);
    return { email: t.email, fullName: t.fullName, purpose: t.purpose, expiresAt: t.expiresAt };
  });

  app.post('/auth/reset-password', { config: strict(10, 15) }, async (req) => {
    const body = parse(z.strictObject({ token: z.string().min(20).max(200), newPassword: PasswordSchema }), req.body);
    await db.tx(async (q) => {
      const u = await consumeResetToken(q, body.token);
      await setPassword(q, u.id, u.email, body.newPassword);
      await audit(q, { actorId: u.id, action: u.purpose === 'setup' ? 'auth.password_setup' : 'auth.password_reset', entityType: 'user', entityId: u.id, departmentId: u.department_id, ip: req.ip });
    });
    return { ok: true };
  });

  async function loadMe(userId: string) {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.department_id, d.name AS department_name, d.code AS department_code
         FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = $1`,
      [userId],
    );
    const u = rows[0];
    const grants = await db.query(
      `SELECT g.department_id, g.access_level, d.name AS department_name, g.expires_at
         FROM user_scope_grants g JOIN departments d ON d.id = g.department_id
        WHERE g.user_id = $1 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())`,
      [userId],
    );
    const principal = {
      id: u.id,
      role: u.role,
      departmentId: u.department_id,
      grants: grants.rows.map((g) => ({ departmentId: g.department_id, level: g.access_level })),
    };
    return {
      id: u.id,
      email: u.email,
      fullName: u.full_name,
      role: u.role,
      department: u.department_id ? { id: u.department_id, name: u.department_name, code: u.department_code } : null,
      grants: grants.rows.map((g) => ({ departmentId: g.department_id, departmentName: g.department_name, level: g.access_level, expiresAt: g.expires_at })),
      permissions: describePermissions(principal),
    };
  }
}
