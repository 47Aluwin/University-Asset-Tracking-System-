import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { pageParams, parse, requirePermission, type AppDeps } from '../app.ts';
import { audit } from '../audit.ts';
import { badRequest } from '../errors.ts';
import { getAllSettings, SETTING_SCHEMAS, type SettingKey } from '../settings.ts';

export function adminRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get('/audit-events', async (req) => {
    await requirePermission(db, req, 'audit.read');
    const q = parse(
      z.object({
        entityType: z.string().max(50).optional(),
        entityId: z.string().max(100).optional(),
        actorId: z.uuid().optional(),
        action: z.string().max(100).optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        page: z.coerce.number().int().optional(),
        pageSize: z.coerce.number().int().optional(),
      }),
      req.query,
    );
    const p = pageParams(q);
    const { rows } = await db.query(
      `SELECT a.id, a.occurred_at, a.actor_user_id, u.full_name AS actor_name, a.action, a.entity_type, a.entity_id,
              a.department_id, a.outcome, a.before_data, a.after_data, a.context, count(*) OVER()::int AS total
         FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE ($1::text IS NULL OR a.entity_type = $1)
          AND ($2::text IS NULL OR a.entity_id = $2)
          AND ($3::uuid IS NULL OR a.actor_user_id = $3)
          AND ($4::text IS NULL OR a.action = $4)
          AND ($5::timestamptz IS NULL OR a.occurred_at >= $5)
          AND ($6::timestamptz IS NULL OR a.occurred_at < $6)
        ORDER BY a.occurred_at DESC, a.id DESC
        LIMIT $7 OFFSET $8`,
      [q.entityType ?? null, q.entityId ?? null, q.actorId ?? null, q.action ?? null, q.from ?? null, q.to ?? null, p.limit, p.offset],
    );
    return {
      page: p.page,
      pageSize: p.pageSize,
      total: rows[0]?.total ?? 0,
      items: rows.map((r) => ({
        id: String(r.id),
        occurredAt: r.occurred_at,
        actor: r.actor_user_id ? { id: r.actor_user_id, name: r.actor_name } : null,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        departmentId: r.department_id,
        outcome: r.outcome,
        before: r.before_data,
        after: r.after_data,
        context: r.context,
      })),
    };
  });

  app.get('/settings', async (req) => {
    await requirePermission(db, req, 'settings.manage');
    const rows = await getAllSettings(db);
    return { items: rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at })) };
  });

  app.put('/settings/:key', async (req) => {
    const admin = await requirePermission(db, req, 'settings.manage');
    const { key } = parse(z.object({ key: z.string() }), req.params);
    if (!(key in SETTING_SCHEMAS)) throw badRequest('UNKNOWN_SETTING', `Unknown setting "${key}".`);
    const { value } = parse(z.strictObject({ value: SETTING_SCHEMAS[key as SettingKey] }), req.body);
    return db.tx(async (q) => {
      const cur = (await q.query('SELECT value FROM system_settings WHERE key = $1 FOR UPDATE', [key])).rows[0];
      await q.query(
        `INSERT INTO system_settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [key, JSON.stringify(value), admin.id],
      );
      await audit(q, { actorId: admin.id, action: 'settings.update', entityType: 'setting', entityId: key, before: cur?.value ?? null, after: value, ip: req.ip });
      return { key, value };
    });
  });
}
