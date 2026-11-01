import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { pageParams, parse, requirePermission, type AppDeps } from '../app.ts';
import { issueResetToken, resetLink, revokeSessions } from '../accounts.ts';
import { audit, diff } from '../audit.ts';
import { ROLES } from '../authz.ts';
import type { Queryable } from '../db.ts';
import { AppError, conflict, notFound } from '../errors.ts';
import { EmailSchema } from '../security.ts';

const IdParam = z.object({ id: z.uuid() });

const CreateBody = z.strictObject({
  email: EmailSchema,
  fullName: z.string().trim().min(2).max(200),
  role: z.enum(ROLES),
  departmentId: z.uuid().nullable(),
});

const UpdateBody = z.strictObject({
  fullName: z.string().trim().min(2).max(200).optional(),
  role: z.enum(ROLES).optional(),
  departmentId: z.uuid().nullable().optional(),
});

const GrantBody = z.strictObject({
  departmentId: z.uuid(),
  accessLevel: z.enum(['read', 'operate']),
  reason: z.string().trim().min(5).max(1000),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});

function toUser(r: Record<string, any>) {
  return {
    id: r.id,
    email: r.email,
    fullName: r.full_name,
    role: r.role,
    department: r.department_id ? { id: r.department_id, name: r.department_name, code: r.department_code } : null,
    status: r.status,
    passwordSet: r.password_set,
    lockedUntil: r.locked_until && new Date(r.locked_until) > new Date() ? r.locked_until : null,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
    deactivatedAt: r.deactivated_at,
    deactivationReason: r.deactivation_reason,
  };
}

const USER_SELECT = `
  SELECT u.id, u.email, u.full_name, u.role, u.department_id, d.name AS department_name, d.code AS department_code,
         u.status, (u.password_hash IS NOT NULL) AS password_set, u.locked_until, u.last_login_at, u.created_at,
         u.deactivated_at, u.deactivation_reason
    FROM users u LEFT JOIN departments d ON d.id = u.department_id`;

async function assertDepartment(q: Queryable, id: string | null | undefined) {
  if (!id) return;
  const d = await q.query('SELECT 1 FROM departments WHERE id = $1 AND is_active', [id]);
  if (!d.rows[0]) throw new AppError(400, 'INVALID_DEPARTMENT', 'Choose an active department.');
}

/** Prevents removing the last active administrator. Locks admin rows to avoid races between two admins. */
async function assertNotLastAdmin(q: Queryable, userId: string) {
  const { rows } = await q.query(
    `SELECT id FROM users WHERE role = 'SYSTEM_ADMIN' AND status = 'active' FOR UPDATE`,
  );
  if (rows.length <= 1 && rows.some((r) => r.id === userId)) {
    throw conflict('LAST_ADMIN', 'This is the only active system administrator. Appoint another administrator first.');
  }
}

export function userRoutes(app: FastifyInstance, { db, config, mailer }: AppDeps) {
  app.get('/users', async (req) => {
    await requirePermission(db, req, 'users.manage');
    const q = parse(
      z.object({
        q: z.string().trim().max(100).optional(),
        role: z.enum(ROLES).optional(),
        status: z.enum(['active', 'deactivated']).optional(),
        departmentId: z.uuid().optional(),
        page: z.coerce.number().int().optional(),
        pageSize: z.coerce.number().int().optional(),
      }),
      req.query,
    );
    const p = pageParams(q);
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => '\\' + c)}%` : null;
    const { rows } = await db.query(
      `${USER_SELECT.replace('SELECT', 'SELECT count(*) OVER()::int AS total,')}
        WHERE ($1::text IS NULL OR u.email ILIKE $1 OR u.full_name ILIKE $1)
          AND ($2::text IS NULL OR u.role = $2)
          AND ($3::text IS NULL OR u.status = $3)
          AND ($4::uuid IS NULL OR u.department_id = $4)
        ORDER BY u.full_name
        LIMIT $5 OFFSET $6`,
      [like, q.role ?? null, q.status ?? null, q.departmentId ?? null, p.limit, p.offset],
    );
    return { page: p.page, pageSize: p.pageSize, total: rows[0]?.total ?? 0, items: rows.map(toUser) };
  });

  app.get('/users/:id', async (req) => {
    await requirePermission(db, req, 'users.manage');
    const { id } = parse(IdParam, req.params);
    const { rows } = await db.query(`${USER_SELECT} WHERE u.id = $1`, [id]);
    if (!rows[0]) throw notFound('User');
    const grants = await db.query(
      `SELECT g.id, g.department_id, d.name AS department_name, g.access_level, g.reason, g.granted_at, g.expires_at,
              g.revoked_at, gb.full_name AS granted_by_name
         FROM user_scope_grants g JOIN departments d ON d.id = g.department_id JOIN users gb ON gb.id = g.granted_by
        WHERE g.user_id = $1 ORDER BY g.granted_at DESC`,
      [id],
    );
    return {
      user: toUser(rows[0]),
      grants: grants.rows.map((g) => ({
        id: g.id,
        department: { id: g.department_id, name: g.department_name },
        accessLevel: g.access_level,
        reason: g.reason,
        grantedAt: g.granted_at,
        grantedBy: g.granted_by_name,
        expiresAt: g.expires_at,
        revokedAt: g.revoked_at,
        active: !g.revoked_at && (!g.expires_at || new Date(g.expires_at) > new Date()),
      })),
    };
  });

  // Admin creates an account. The admin never sets the password: a one-time setup link is issued.
  app.post('/users', async (req, reply) => {
    const admin = await requirePermission(db, req, 'users.manage');
    const body = parse(CreateBody, req.body);
    if (body.role === 'DEPARTMENT_STAFF' && !body.departmentId) {
      throw new AppError(400, 'DEPARTMENT_REQUIRED', 'Department staff must be assigned to a department.');
    }
    const result = await db.tx(async (q) => {
      await assertDepartment(q, body.departmentId);
      if ((await q.query('SELECT 1 FROM users WHERE email = $1', [body.email])).rows[0]) {
        throw conflict('ACCOUNT_EXISTS', 'An account with this email already exists.');
      }
      const { rows } = await q.query(
        `INSERT INTO users (email, full_name, role, department_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [body.email, body.fullName, body.role, body.departmentId, admin.id],
      );
      const userId = rows[0].id as string;
      // Close any pending self-service request for the same email so it cannot be approved twice.
      await q.query(
        `UPDATE access_requests SET status = 'rejected', reviewed_by = $2, reviewed_at = now(),
                decision_note = 'Superseded: account created directly by an administrator'
          WHERE email = $1 AND status = 'pending'`,
        [body.email, admin.id],
      );
      const t = await issueResetToken(q, config, userId, 'setup', admin.id);
      await audit(q, {
        actorId: admin.id,
        action: 'user.create',
        entityType: 'user',
        entityId: userId,
        departmentId: body.departmentId,
        after: { email: body.email, fullName: body.fullName, role: body.role, departmentId: body.departmentId, source: 'admin' },
        ip: req.ip,
      });
      return { userId, ...t };
    });
    const link = resetLink(config, result.token);
    if (mailer.configured) {
      await mailer.send({
        to: body.email,
        subject: 'Your Asset Tracking System account',
        text: `Hello ${body.fullName},\n\nAn account has been created for you. Set your password within ${config.auth.setupTokenHours} hours:\n${link}`,
      });
    }
    return reply.status(201).send({
      id: result.userId,
      // Shown once so the admin can pass it on when email is not configured.
      setupLink: link,
      setupLinkExpiresAt: result.expiresAt,
      emailSent: mailer.configured,
    });
  });

  app.patch('/users/:id', async (req) => {
    const admin = await requirePermission(db, req, 'users.manage');
    const { id } = parse(IdParam, req.params);
    const body = parse(UpdateBody, req.body);
    return db.tx(async (q) => {
      const cur = (await q.query('SELECT full_name, role, department_id FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw notFound('User');
      const next = {
        fullName: body.fullName ?? cur.full_name,
        role: body.role ?? cur.role,
        departmentId: body.departmentId === undefined ? cur.department_id : body.departmentId,
      };
      const d = diff({ fullName: cur.full_name, role: cur.role, departmentId: cur.department_id }, next);
      if (!d.changed) return { ok: true, changed: false };
      if (id === admin.id && next.role !== cur.role) {
        throw new AppError(400, 'SELF_ROLE_CHANGE', 'You cannot change your own role.');
      }
      if (cur.role === 'SYSTEM_ADMIN' && next.role !== 'SYSTEM_ADMIN') await assertNotLastAdmin(q, id);
      if (next.role === 'DEPARTMENT_STAFF' && !next.departmentId) {
        throw new AppError(400, 'DEPARTMENT_REQUIRED', 'Department staff must be assigned to a department.');
      }
      if (next.departmentId !== cur.department_id) await assertDepartment(q, next.departmentId);
      await q.query(
        `UPDATE users SET full_name = $2, role = $3, department_id = $4, updated_at = now() WHERE id = $1`,
        [id, next.fullName, next.role, next.departmentId],
      );
      const accessChanged = 'role' in d.after || 'departmentId' in d.after;
      if (accessChanged) await revokeSessions(q, id, 'access_changed');
      await audit(q, {
        actorId: admin.id,
        action: accessChanged ? 'user.access_change' : 'user.update',
        entityType: 'user',
        entityId: id,
        departmentId: next.departmentId,
        before: d.before,
        after: d.after,
        ip: req.ip,
      });
      return { ok: true, changed: true, sessionsRevoked: accessChanged };
    });
  });

  app.post('/users/:id/deactivate', async (req) => {
    const admin = await requirePermission(db, req, 'users.manage');
    const { id } = parse(IdParam, req.params);
    const { reason } = parse(z.strictObject({ reason: z.string().trim().min(3).max(1000) }), req.body);
    if (id === admin.id) throw new AppError(400, 'SELF_DEACTIVATION', 'You cannot deactivate your own account.');
    return db.tx(async (q) => {
      const cur = (await q.query('SELECT status, role, department_id FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw notFound('User');
      if (cur.status === 'deactivated') return { ok: true, changed: false };
      if (cur.role === 'SYSTEM_ADMIN') await assertNotLastAdmin(q, id);
      await q.query(
        `UPDATE users SET status = 'deactivated', deactivated_at = now(), deactivation_reason = $2, updated_at = now() WHERE id = $1`,
        [id, reason],
      );
      const revoked = await revokeSessions(q, id, 'deactivated');
      await q.query(`UPDATE password_reset_tokens SET invalidated_at = now() WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`, [id]);
      await audit(q, {
        actorId: admin.id,
        action: 'user.deactivate',
        entityType: 'user',
        entityId: id,
        departmentId: cur.department_id,
        before: { status: 'active' },
        after: { status: 'deactivated' },
        context: { reason, sessionsRevoked: revoked },
        ip: req.ip,
      });
      return { ok: true, changed: true };
    });
  });

  app.post('/users/:id/activate', async (req) => {
    const admin = await requirePermission(db, req, 'users.manage');
    const { id } = parse(IdParam, req.params);
    return db.tx(async (q) => {
      const cur = (await q.query('SELECT status, department_id FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw notFound('User');
      if (cur.status === 'active') return { ok: true, changed: false };
      await q.query(
        `UPDATE users SET status = 'active', deactivated_at = NULL, deactivation_reason = NULL,
                failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
        [id],
      );
      await audit(q, {
        actorId: admin.id,
        action: 'user.activate',
        entityType: 'user',
        entityId: id,
        departmentId: cur.department_id,
        before: { status: 'deactivated' },
        after: { status: 'active' },
        ip: req.ip,
      });
      return { ok: true, changed: true };
    });
  });

  app.post('/users/:id/unlock', async (req) => {
    const admin = await requirePermission(db, req, 'users.manage');
    const { id } = parse(IdParam, req.params);
    return db.tx(async (q) => {
      const r = await q.query(
        `UPDATE users SET failed_login_count = 0, lockout_count = 0, locked_until = NULL WHERE id = $1 RETURNING department_id`,
        [id],
      );
      if (!r.rows[0]) throw notFound('User');
      await audit(q, { actorId: admin.id, action: 'user.unlock', entityType: 'user', entityId: id, departmentId: r.rows[0].department_id, ip: req.ip });
      return { ok: true };
    });
  });

  // Fallback when email is not configured: admin obtains a one-time link to hand to the user.
  app.post('/users/:id/reset-link', async (req) => {
    const admin = await requirePermission(db, req, 'users.manage');
    const { id } = parse(IdParam, req.params);
    const t = await db.tx(async (q) => {
      const u = (await q.query(`SELECT status, department_id FROM users WHERE id = $1`, [id])).rows[0];
      if (!u) throw notFound('User');
      if (u.status !== 'active') throw new AppError(400, 'USER_INACTIVE', 'Activate the account before issuing a reset link.');
      const tok = await issueResetToken(q, config, id, 'setup', admin.id);
      await audit(q, { actorId: admin.id, action: 'user.reset_link_issued', entityType: 'user', entityId: id, departmentId: u.department_id, ip: req.ip });
      return tok;
    });
    return { link: resetLink(config, t.token), expiresAt: t.expiresAt };
  });

  // ----- cross-department scope grants -----

  app.post('/users/:id/grants', async (req, reply) => {
    const admin = await requirePermission(db, req, 'scope_grants.manage');
    const { id } = parse(IdParam, req.params);
    const body = parse(GrantBody, req.body);
    if (body.expiresAt && new Date(body.expiresAt) <= new Date()) {
      throw new AppError(400, 'INVALID_EXPIRY', 'Expiry must be in the future.');
    }
    return db.tx(async (q) => {
      const u = (await q.query(`SELECT role, department_id FROM users WHERE id = $1`, [id])).rows[0];
      if (!u) throw notFound('User');
      if (u.role !== 'DEPARTMENT_STAFF') {
        throw new AppError(400, 'GRANT_NOT_NEEDED', 'Only department staff need department grants; other roles already cover all departments.');
      }
      if (u.department_id === body.departmentId) throw new AppError(400, 'GRANT_NOT_NEEDED', 'This is already the user’s own department.');
      await assertDepartment(q, body.departmentId);
      const { rows } = await q.query(
        `INSERT INTO user_scope_grants (user_id, department_id, access_level, reason, granted_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [id, body.departmentId, body.accessLevel, body.reason, admin.id, body.expiresAt ?? null],
      );
      await audit(q, {
        actorId: admin.id,
        action: 'scope_grant.create',
        entityType: 'user',
        entityId: id,
        departmentId: body.departmentId,
        after: { grantId: rows[0].id, departmentId: body.departmentId, accessLevel: body.accessLevel, expiresAt: body.expiresAt ?? null },
        context: { reason: body.reason },
        ip: req.ip,
      });
      return reply.status(201).send({ id: rows[0].id });
    });
  });

  app.post('/users/:id/grants/:grantId/revoke', async (req) => {
    const admin = await requirePermission(db, req, 'scope_grants.manage');
    const { id, grantId } = parse(z.object({ id: z.uuid(), grantId: z.uuid() }), req.params);
    return db.tx(async (q) => {
      const r = await q.query(
        `UPDATE user_scope_grants SET revoked_at = now(), revoked_by = $3
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING department_id, access_level`,
        [grantId, id, admin.id],
      );
      if (!r.rows[0]) throw notFound('Active grant');
      await audit(q, {
        actorId: admin.id,
        action: 'scope_grant.revoke',
        entityType: 'user',
        entityId: id,
        departmentId: r.rows[0].department_id,
        before: { grantId, accessLevel: r.rows[0].access_level },
        ip: req.ip,
      });
      return { ok: true };
    });
  });
}
