import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { parse, requirePermission, type AppDeps } from '../app.ts';
import { audit, diff } from '../audit.ts';
import type { Queryable } from '../db.ts';
import { AppError, conflict, notFound } from '../errors.ts';

const Currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 currency code.');
const Code = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,12}$/, 'Code must be 2–12 letters or digits.');

const CreateBody = z.strictObject({
  code: Code,
  name: z.string().trim().min(2).max(200),
  defaultCurrency: Currency,
  // The faculty this school belongs to; null/absent = a central administrative unit.
  facultyId: z.uuid().nullable().optional(),
});

const UpdateBody = z.strictObject({
  name: z.string().trim().min(2).max(200).optional(),
  defaultCurrency: Currency.optional(),
  isActive: z.boolean().optional(),
  // Phase 4: optional approval step for this department's maintenance requests.
  maintenanceRequiresApproval: z.boolean().optional(),
  facultyId: z.uuid().nullable().optional(),
});

const FacultyCreate = z.strictObject({ code: Code, name: z.string().trim().min(2).max(200) });
const FacultyUpdate = z.strictObject({ name: z.string().trim().min(2).max(200).optional(), isActive: z.boolean().optional() });

const DEPT_COLS = `d.id, d.code, d.name, d.default_currency, d.is_active, d.maintenance_requires_approval, d.faculty_id, f.name AS faculty_name`;
const DEPT_FROM = `departments d LEFT JOIN faculties f ON f.id = d.faculty_id`;

const toDept = (r: Record<string, any>) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  defaultCurrency: r.default_currency,
  isActive: r.is_active,
  maintenanceRequiresApproval: r.maintenance_requires_approval,
  faculty: r.faculty_id ? { id: r.faculty_id as string, name: r.faculty_name as string } : null,
});

const toFaculty = (r: Record<string, any>) => ({ id: r.id, code: r.code, name: r.name, isActive: r.is_active, sortOrder: r.sort_order });

const fieldError = (path: string, message: string) => new AppError(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', [{ path, message }]);

async function checkFaculty(q: Queryable, id: string | null | undefined) {
  if (!id) return;
  const f = (await q.query('SELECT is_active FROM faculties WHERE id = $1', [id])).rows[0];
  if (!f) throw fieldError('facultyId', 'This faculty does not exist.');
  if (!f.is_active) throw fieldError('facultyId', 'This faculty is no longer active.');
}

const deptById = async (q: Queryable, id: string) => (await q.query(`SELECT ${DEPT_COLS} FROM ${DEPT_FROM} WHERE d.id = $1`, [id])).rows[0];

export function departmentRoutes(app: FastifyInstance, { db }: AppDeps) {
  // Public minimal list, needed by the access-request form before the person has an account.
  app.get('/public/departments', async () => {
    const { rows } = await db.query(
      `SELECT d.id, d.code, d.name, f.name AS faculty_name FROM ${DEPT_FROM} WHERE d.is_active ORDER BY f.sort_order NULLS LAST, d.name`,
    );
    return { items: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, facultyName: r.faculty_name ?? null })) };
  });

  app.get('/departments', async (req) => {
    const user = await requirePermission(db, req, 'departments.read');
    const includeInactive = user.role === 'SYSTEM_ADMIN';
    const { rows } = await db.query(
      `SELECT ${DEPT_COLS} FROM ${DEPT_FROM} WHERE $1 OR d.is_active ORDER BY f.sort_order NULLS LAST, d.name`,
      [includeInactive],
    );
    return { items: rows.map(toDept) };
  });

  app.post('/departments', async (req, reply) => {
    const admin = await requirePermission(db, req, 'departments.manage');
    const body = parse(CreateBody, req.body);
    return db.tx(async (q) => {
      if ((await q.query('SELECT 1 FROM departments WHERE code = $1', [body.code])).rows[0]) {
        throw conflict('DUPLICATE_CODE', `Department code ${body.code} is already used.`);
      }
      await checkFaculty(q, body.facultyId);
      const { rows } = await q.query(
        `INSERT INTO departments (code, name, default_currency, faculty_id) VALUES ($1,$2,$3,$4) RETURNING id`,
        [body.code, body.name, body.defaultCurrency, body.facultyId ?? null],
      );
      await audit(q, { actorId: admin.id, action: 'department.create', entityType: 'department', entityId: rows[0].id, departmentId: rows[0].id, after: body, ip: req.ip });
      return reply.status(201).send(toDept(await deptById(q, rows[0].id)));
    });
  });

  app.patch('/departments/:id', async (req) => {
    const admin = await requirePermission(db, req, 'departments.manage');
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(UpdateBody, req.body);
    return db.tx(async (q) => {
      const cur = (await q.query('SELECT * FROM departments WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw notFound('Department');
      const before = {
        name: cur.name,
        defaultCurrency: cur.default_currency,
        isActive: cur.is_active,
        maintenanceRequiresApproval: cur.maintenance_requires_approval,
        facultyId: (cur.faculty_id ?? null) as string | null,
      };
      const d = diff(before, body);
      if (!d.changed) return toDept(await deptById(q, id));
      const next = { ...before, ...body };
      if (body.facultyId !== undefined && body.facultyId !== before.facultyId) await checkFaculty(q, body.facultyId);
      await q.query(
        `UPDATE departments SET name = $2, default_currency = $3, is_active = $4, maintenance_requires_approval = $5, faculty_id = $6, updated_at = now()
          WHERE id = $1`,
        [id, next.name, next.defaultCurrency, next.isActive, next.maintenanceRequiresApproval, next.facultyId ?? null],
      );
      await audit(q, { actorId: admin.id, action: 'department.update', entityType: 'department', entityId: id, departmentId: id, before: d.before, after: d.after, ip: req.ip });
      return toDept(await deptById(q, id));
    });
  });

  // Faculties, in the university's usual order. Each school (department) names its faculty.
  app.get('/faculties', async (req) => {
    const user = await requirePermission(db, req, 'departments.read');
    const { rows } = await db.query(
      `SELECT id, code, name, is_active, sort_order FROM faculties WHERE $1 OR is_active ORDER BY sort_order, name`,
      [user.role === 'SYSTEM_ADMIN'],
    );
    return { items: rows.map(toFaculty) };
  });

  app.post('/faculties', async (req, reply) => {
    const admin = await requirePermission(db, req, 'departments.manage');
    const body = parse(FacultyCreate, req.body);
    return db.tx(async (q) => {
      if ((await q.query('SELECT 1 FROM faculties WHERE code = $1 OR lower(name) = lower($2)', [body.code, body.name])).rows[0]) {
        throw conflict('DUPLICATE_FACULTY', 'A faculty with this code or name already exists.');
      }
      const { rows } = await q.query(
        `INSERT INTO faculties (code, name, sort_order) VALUES ($1, $2, (SELECT coalesce(max(sort_order), 0) + 10 FROM faculties))
         RETURNING id, code, name, is_active, sort_order`,
        [body.code, body.name],
      );
      await audit(q, { actorId: admin.id, action: 'faculty.create', entityType: 'faculty', entityId: rows[0].id, after: body, ip: req.ip });
      return reply.status(201).send(toFaculty(rows[0]));
    });
  });

  app.patch('/faculties/:id', async (req) => {
    const admin = await requirePermission(db, req, 'departments.manage');
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(FacultyUpdate, req.body);
    return db.tx(async (q) => {
      const cur = (await q.query('SELECT * FROM faculties WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw notFound('Faculty');
      const d = diff({ name: cur.name, isActive: cur.is_active }, body);
      if (!d.changed) return toFaculty(cur);
      const { rows } = await q.query(
        `UPDATE faculties SET name = $2, is_active = $3, updated_at = now() WHERE id = $1 RETURNING id, code, name, is_active, sort_order`,
        [id, body.name ?? cur.name, body.isActive ?? cur.is_active],
      );
      await audit(q, { actorId: admin.id, action: 'faculty.update', entityType: 'faculty', entityId: id, before: d.before, after: d.after, ip: req.ip });
      return toFaculty(rows[0]);
    });
  });
}
