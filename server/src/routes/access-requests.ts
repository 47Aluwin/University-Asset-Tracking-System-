import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { pageParams, parse, requirePermission, routeLimit, type AppDeps } from '../app.ts';
import { validateNewPassword } from '../accounts.ts';
import { audit } from '../audit.ts';
import { AppError, conflict, notFound } from '../errors.ts';
import { EmailSchema, hashPassword, PasswordSchema } from '../security.ts';
import { getSetting } from '../settings.ts';

const RequestBody = z.strictObject({
  fullName: z.string().trim().min(2).max(200),
  email: EmailSchema,
  departmentId: z.uuid(),
  requestedRole: z.enum(['DEPARTMENT_STAFF', 'ASSET_MANAGER']),
  justification: z.string().trim().min(5).max(2000),
  password: PasswordSchema,
});

const ApproveBody = z.strictObject({
  role: z.enum(['SYSTEM_ADMIN', 'ASSET_MANAGER', 'DEPARTMENT_STAFF']),
  departmentId: z.uuid().nullable(),
  note: z.string().trim().max(1000).optional(),
});

export function accessRequestRoutes(app: FastifyInstance, { db, config }: AppDeps) {
  // Public: anyone may ask for access; nothing is granted until an administrator approves.
  app.post(
    '/access-requests',
    { config: routeLimit(config, 5, 60) },
    async (req, reply) => {
      const body = parse(RequestBody, req.body);
      validateNewPassword(body.password, body.email);

      const domains = await getSetting(db, 'allowed_email_domains');
      const domain = body.email.split('@')[1];
      if (domains.length > 0 && !domains.includes(domain)) {
        throw new AppError(400, 'EMAIL_DOMAIN_NOT_ALLOWED', `Use your institutional email address (${domains.join(', ')}).`);
      }
      const dept = await db.query('SELECT id FROM departments WHERE id = $1 AND is_active', [body.departmentId]);
      if (!dept.rows[0]) throw new AppError(400, 'INVALID_DEPARTMENT', 'Choose an active department.');
      const existing = await db.query('SELECT 1 FROM users WHERE email = $1', [body.email]);
      if (existing.rows[0]) {
        throw conflict('ACCOUNT_EXISTS', 'An account already exists for this email. Sign in, or use "Forgot password".');
      }

      const passwordHash = await hashPassword(body.password);
      const id = await db.tx(async (q) => {
        const pending = await q.query(`SELECT 1 FROM access_requests WHERE email = $1 AND status = 'pending'`, [body.email]);
        if (pending.rows[0]) throw conflict('REQUEST_PENDING', 'A request for this email is already awaiting approval.');
        const { rows } = await q.query(
          `INSERT INTO access_requests (full_name, email, department_id, requested_role, justification, password_hash)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [body.fullName, body.email, body.departmentId, body.requestedRole, body.justification, passwordHash],
        );
        await audit(q, {
          actorId: null,
          action: 'access_request.submit',
          entityType: 'access_request',
          entityId: rows[0].id,
          departmentId: body.departmentId,
          after: { fullName: body.fullName, email: body.email, requestedRole: body.requestedRole },
          ip: req.ip,
        });
        return rows[0].id as string;
      });
      return reply.status(201).send({ id, status: 'pending', message: 'Request submitted. An administrator will review it.' });
    },
  );

  app.get('/access-requests', async (req) => {
    await requirePermission(db, req, 'access_requests.review');
    const q = parse(
      z.object({
        status: z.enum(['pending', 'approved', 'rejected']).optional(),
        page: z.coerce.number().int().optional(),
        pageSize: z.coerce.number().int().optional(),
      }),
      req.query,
    );
    const p = pageParams(q);
    const { rows } = await db.query(
      `SELECT r.id, r.full_name, r.email, r.department_id, d.name AS department_name, r.requested_role,
              r.justification, r.status, r.created_at, r.reviewed_at, r.decision_note,
              rv.full_name AS reviewed_by_name, count(*) OVER()::int AS total
         FROM access_requests r
         JOIN departments d ON d.id = r.department_id
         LEFT JOIN users rv ON rv.id = r.reviewed_by
        WHERE ($1::text IS NULL OR r.status = $1)
        ORDER BY r.status = 'pending' DESC, r.created_at DESC
        LIMIT $2 OFFSET $3`,
      [q.status ?? null, p.limit, p.offset],
    );
    return {
      page: p.page,
      pageSize: p.pageSize,
      total: rows[0]?.total ?? 0,
      items: rows.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        email: r.email,
        department: { id: r.department_id, name: r.department_name },
        requestedRole: r.requested_role,
        justification: r.justification,
        status: r.status,
        createdAt: r.created_at,
        reviewedAt: r.reviewed_at,
        reviewedBy: r.reviewed_by_name,
        decisionNote: r.decision_note,
      })),
    };
  });

  app.post('/access-requests/:id/approve', async (req) => {
    const admin = await requirePermission(db, req, 'access_requests.review');
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(ApproveBody, req.body);
    if (body.role === 'DEPARTMENT_STAFF' && !body.departmentId) {
      throw new AppError(400, 'DEPARTMENT_REQUIRED', 'Department staff must be assigned to a department.');
    }
    return db.tx(async (q) => {
      const r = (await q.query(`SELECT * FROM access_requests WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!r) throw notFound('Access request');
      if (r.status !== 'pending') throw conflict('ALREADY_DECIDED', `This request was already ${r.status}.`);
      if (body.departmentId) {
        const d = await q.query('SELECT 1 FROM departments WHERE id = $1 AND is_active', [body.departmentId]);
        if (!d.rows[0]) throw new AppError(400, 'INVALID_DEPARTMENT', 'Choose an active department.');
      }
      if ((await q.query('SELECT 1 FROM users WHERE email = $1', [r.email])).rows[0]) {
        throw conflict('ACCOUNT_EXISTS', 'An account with this email already exists.');
      }
      const user = (
        await q.query(
          `INSERT INTO users (email, full_name, password_hash, role, department_id, password_changed_at, created_by)
           VALUES ($1,$2,$3,$4,$5, now(), $6) RETURNING id`,
          [r.email, r.full_name, r.password_hash, body.role, body.departmentId, admin.id],
        )
      ).rows[0];
      await q.query(
        `UPDATE access_requests SET status = 'approved', reviewed_by = $2, reviewed_at = now(),
                decision_note = $3, approved_user_id = $4 WHERE id = $1`,
        [id, admin.id, body.note ?? null, user.id],
      );
      await audit(q, {
        actorId: admin.id,
        action: 'access_request.approve',
        entityType: 'access_request',
        entityId: id,
        departmentId: body.departmentId,
        before: { status: 'pending', requestedRole: r.requested_role, departmentId: r.department_id },
        after: { status: 'approved', role: body.role, departmentId: body.departmentId, userId: user.id },
        context: body.note ? { note: body.note } : undefined,
        ip: req.ip,
      });
      await audit(q, {
        actorId: admin.id,
        action: 'user.create',
        entityType: 'user',
        entityId: user.id,
        departmentId: body.departmentId,
        after: { email: r.email, role: body.role, departmentId: body.departmentId, source: 'access_request' },
        ip: req.ip,
      });
      return { ok: true, userId: user.id };
    });
  });

  app.post('/access-requests/:id/reject', async (req) => {
    const admin = await requirePermission(db, req, 'access_requests.review');
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { reason } = parse(z.strictObject({ reason: z.string().trim().min(3).max(1000) }), req.body);
    return db.tx(async (q) => {
      const r = (await q.query(`SELECT status, department_id FROM access_requests WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!r) throw notFound('Access request');
      if (r.status !== 'pending') throw conflict('ALREADY_DECIDED', `This request was already ${r.status}.`);
      await q.query(
        `UPDATE access_requests SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), decision_note = $3 WHERE id = $1`,
        [id, admin.id, reason],
      );
      await audit(q, {
        actorId: admin.id,
        action: 'access_request.reject',
        entityType: 'access_request',
        entityId: id,
        departmentId: r.department_id,
        before: { status: 'pending' },
        after: { status: 'rejected' },
        context: { reason },
        ip: req.ip,
      });
      return { ok: true };
    });
  });
}
