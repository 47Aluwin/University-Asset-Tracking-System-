// Reference data used when registering assets: categories (admin-managed) and locations (per department).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { parse, requirePermission, requireUser, type AppDeps } from '../app.ts';
import { audit, diff } from '../audit.ts';
import { departmentScope } from '../authz.ts';
import { AppError, conflict, notFound } from '../errors.ts';
import { getSetting } from '../settings.ts';

const toCategory = (r: Record<string, any>) => ({ id: r.id, name: r.name, description: r.description, isActive: r.is_active });
const toLocation = (r: Record<string, any>) => ({
  id: r.id,
  departmentId: r.department_id,
  building: r.building,
  room: r.room,
  description: r.description,
  isActive: r.is_active,
});

export function catalogRoutes(app: FastifyInstance, { db }: AppDeps) {
  // ----- categories -----

  app.get('/categories', async (req) => {
    const user = requireUser(req);
    const all = user.role === 'SYSTEM_ADMIN';
    const { rows } = await db.query(
      `SELECT id, name, description, is_active FROM asset_categories WHERE $1 OR is_active ORDER BY lower(name)`,
      [all],
    );
    return { items: rows.map(toCategory) };
  });

  app.post('/categories', async (req, reply) => {
    const admin = await requirePermission(db, req, 'categories.manage');
    const body = parse(
      z.strictObject({ name: z.string().trim().min(2).max(100), description: z.string().trim().max(500).optional() }),
      req.body,
    );
    return db.tx(async (q) => {
      if ((await q.query('SELECT 1 FROM asset_categories WHERE lower(name) = lower($1)', [body.name])).rows[0]) {
        throw conflict('DUPLICATE_CATEGORY', `A category called "${body.name}" already exists.`);
      }
      const { rows } = await q.query(
        `INSERT INTO asset_categories (name, description) VALUES ($1, $2) RETURNING id, name, description, is_active`,
        [body.name, body.description ?? null],
      );
      await audit(q, { actorId: admin.id, action: 'category.create', entityType: 'category', entityId: rows[0].id, after: body, ip: req.ip });
      return reply.status(201).send(toCategory(rows[0]));
    });
  });

  app.patch('/categories/:id', async (req) => {
    const admin = await requirePermission(db, req, 'categories.manage');
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(
      z.strictObject({
        name: z.string().trim().min(2).max(100).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        isActive: z.boolean().optional(),
      }),
      req.body,
    );
    return db.tx(async (q) => {
      const cur = (await q.query('SELECT * FROM asset_categories WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw notFound('Category');
      if (body.name && (await q.query('SELECT 1 FROM asset_categories WHERE lower(name) = lower($1) AND id <> $2', [body.name, id])).rows[0]) {
        throw conflict('DUPLICATE_CATEGORY', `A category called "${body.name}" already exists.`);
      }
      const before = { name: cur.name, description: cur.description, isActive: cur.is_active };
      const d = diff(before, body);
      if (!d.changed) return toCategory(cur);
      const next = { ...before, ...body };
      const { rows } = await q.query(
        `UPDATE asset_categories SET name = $2, description = $3, is_active = $4, updated_at = now()
          WHERE id = $1 RETURNING id, name, description, is_active`,
        [id, next.name, next.description, next.isActive],
      );
      await audit(q, { actorId: admin.id, action: 'category.update', entityType: 'category', entityId: id, before: d.before, after: d.after, ip: req.ip });
      return toCategory(rows[0]);
    });
  });

  // ----- label layout (read-only here; administrators change it via /settings) -----

  app.get('/label-template', async (req) => {
    await requirePermission(db, req, 'labels.print');
    return { template: await getSetting(db, 'label_template') };
  });

  // ----- locations -----

  app.get('/locations', async (req) => {
    const user = await requirePermission(db, req, 'assets.read');
    const q = parse(z.object({ departmentId: z.uuid().optional(), includeInactive: z.enum(['true', 'false']).optional() }), req.query);
    const scope = departmentScope(user, 'assets.read');
    if (q.departmentId && scope !== 'all' && !scope.includes(q.departmentId)) {
      await requirePermission(db, req, 'assets.read', q.departmentId); // records the denial and throws
    }
    const { rows } = await db.query(
      `SELECT id, department_id, building, room, description, is_active FROM locations
        WHERE ($1::uuid IS NULL OR department_id = $1)
          AND ($2::uuid[] IS NULL OR department_id = ANY($2::uuid[]))
          AND ($3 OR is_active)
        ORDER BY lower(building), lower(room)`,
      [q.departmentId ?? null, scope === 'all' ? null : scope, q.includeInactive === 'true'],
    );
    return { items: rows.map(toLocation) };
  });

  app.post('/locations', async (req, reply) => {
    const body = parse(
      z.strictObject({
        departmentId: z.uuid(),
        building: z.string().trim().min(1).max(100),
        room: z.string().trim().min(1).max(100),
        description: z.string().trim().max(500).optional(),
      }),
      req.body,
    );
    const user = await requirePermission(db, req, 'locations.manage', body.departmentId);
    return db.tx(async (q) => {
      const dept = await q.query('SELECT 1 FROM departments WHERE id = $1 AND is_active', [body.departmentId]);
      if (!dept.rows[0]) throw new AppError(400, 'INVALID_DEPARTMENT', 'Choose an active department.');
      const dup = await q.query(
        `SELECT id FROM locations WHERE department_id = $1 AND lower(building) = lower($2) AND lower(room) = lower($3)`,
        [body.departmentId, body.building, body.room],
      );
      if (dup.rows[0]) throw conflict('DUPLICATE_LOCATION', `${body.building}, ${body.room} already exists in this department.`, { id: dup.rows[0].id });
      const { rows } = await q.query(
        `INSERT INTO locations (department_id, building, room, description, created_by) VALUES ($1,$2,$3,$4,$5)
         RETURNING id, department_id, building, room, description, is_active`,
        [body.departmentId, body.building, body.room, body.description ?? null, user.id],
      );
      await audit(q, { actorId: user.id, action: 'location.create', entityType: 'location', entityId: rows[0].id, departmentId: body.departmentId, after: body, ip: req.ip });
      return reply.status(201).send(toLocation(rows[0]));
    });
  });

  app.patch('/locations/:id', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(
      z.strictObject({
        building: z.string().trim().min(1).max(100).optional(),
        room: z.string().trim().min(1).max(100).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        isActive: z.boolean().optional(),
      }),
      req.body,
    );
    const cur = (await db.query('SELECT * FROM locations WHERE id = $1', [id])).rows[0];
    if (!cur) throw notFound('Location');
    const user = await requirePermission(db, req, 'locations.manage', cur.department_id);
    return db.tx(async (q) => {
      const before = { building: cur.building, room: cur.room, description: cur.description, isActive: cur.is_active };
      const d = diff(before, body);
      if (!d.changed) return toLocation(cur);
      const next = { ...before, ...body };
      const dup = await q.query(
        `SELECT 1 FROM locations WHERE department_id = $1 AND lower(building) = lower($2) AND lower(room) = lower($3) AND id <> $4`,
        [cur.department_id, next.building, next.room, id],
      );
      if (dup.rows[0]) throw conflict('DUPLICATE_LOCATION', `${next.building}, ${next.room} already exists in this department.`);
      const { rows } = await q.query(
        `UPDATE locations SET building = $2, room = $3, description = $4, is_active = $5, updated_at = now()
          WHERE id = $1 RETURNING id, department_id, building, room, description, is_active`,
        [id, next.building, next.room, next.description, next.isActive],
      );
      await audit(q, { actorId: user.id, action: 'location.update', entityType: 'location', entityId: id, departmentId: cur.department_id, before: d.before, after: d.after, ip: req.ip });
      return toLocation(rows[0]);
    });
  });
}
