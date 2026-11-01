// Phase 6: support for offline fieldwork — reserved asset ID blocks and review of offline edit conflicts.
// Offline actions themselves are sent to the normal endpoints with an X-Operation-Id, so every rule and
// permission check applies exactly as online, and a repeated send is recorded only once.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { parse, requirePermission, requireUser, type AppDeps } from '../app.ts';
import { audit } from '../audit.ts';
import { can, departmentScope } from '../authz.ts';
import { conflict, notFound } from '../errors.ts';
import { getSetting } from '../settings.ts';
import { formatInstitutionalId, todayIn } from '../../../shared/asset-codes.ts';

export const ID_BLOCK_DAYS = 30;
const MAX_UNUSED_PER_USER = 100;

export function syncRoutes(app: FastifyInstance, { db }: AppDeps) {
  // Reserve a block of institutional IDs for registering assets while offline.
  app.post('/assets/id-blocks', async (req, reply) => {
    const body = parse(z.strictObject({ deviceId: z.string().trim().min(1).max(100), count: z.number().int().min(1).max(50).default(20) }), req.body);
    const user = await requirePermission(db, req, 'assets.register');
    const result = await db.tx(async (q) => {
      const unused = (
        await q.query(`SELECT count(*)::int AS n FROM asset_id_reservations WHERE user_id = $1 AND used_by_asset_id IS NULL AND expires_at > now()`, [user.id])
      ).rows[0].n;
      if (unused + body.count > MAX_UNUSED_PER_USER) {
        throw conflict('TOO_MANY_RESERVED', `You already have ${unused} unused reserved IDs. Use or let some expire before reserving more.`);
      }
      const year = Number(todayIn(await getSetting(q, 'institution_time_zone')).slice(0, 4));
      const prefix = await getSetting(q, 'asset_id_prefix');
      // One atomic counter update takes the whole block, so online registrations and other devices never get these numbers.
      const { rows } = await q.query(
        `INSERT INTO asset_id_counters (year, last_value) VALUES ($1, $2)
         ON CONFLICT (year) DO UPDATE SET last_value = asset_id_counters.last_value + $2 RETURNING last_value`,
        [year, body.count],
      );
      const last = rows[0].last_value as number;
      const ids = Array.from({ length: body.count }, (_, i) => formatInstitutionalId(prefix, year, last - body.count + 1 + i));
      const expires = (
        await q.query(
          `INSERT INTO asset_id_reservations (institutional_id, user_id, device_id, expires_at)
           SELECT unnest($1::text[]), $2, $3, now() + make_interval(days => $4) RETURNING expires_at`,
          [ids, user.id, body.deviceId, ID_BLOCK_DAYS],
        )
      ).rows[0].expires_at;
      await audit(q, {
        actorId: user.id, action: 'asset_id.reserve', entityType: 'asset_id_block', entityId: null,
        context: { deviceId: body.deviceId, first: ids[0], last: ids[ids.length - 1], count: ids.length }, ip: req.ip,
      });
      return { ids, expiresAt: expires };
    });
    return reply.status(201).send(result);
  });

  // The user's reserved IDs that are not yet used (e.g. after reinstalling the app).
  app.get('/assets/id-blocks', async (req) => {
    const user = requireUser(req);
    const { rows } = await db.query(
      `SELECT institutional_id, device_id, expires_at FROM asset_id_reservations
        WHERE user_id = $1 AND used_by_asset_id IS NULL AND expires_at > now() ORDER BY institutional_id`,
      [user.id],
    );
    return { items: rows.map((r) => ({ institutionalId: r.institutional_id, deviceId: r.device_id, expiresAt: r.expires_at })) };
  });

  // ----- conflicts from offline edits -----

  const toConflict = (r: Record<string, any>, userCanEdit: boolean) => ({
    id: r.id,
    status: r.status,
    asset: { id: r.entity_id, institutionalId: r.institutional_id, name: r.asset_name },
    department: { id: r.department_id, name: r.department_name },
    submittedBy: r.submitted_by_name,
    receivedAt: r.received_at,
    baseVersion: r.base_version,
    serverVersion: r.server_version,
    proposed: r.proposed,
    serverValues: r.server_values,
    resolvedBy: r.resolved_by_name,
    resolvedAt: r.resolved_at,
    resolutionNote: r.resolution_note,
    can: { resolve: r.status === 'open' && userCanEdit },
  });
  const SELECT = `
    SELECT c.*, a.institutional_id, a.name AS asset_name, d.name AS department_name,
           su.full_name AS submitted_by_name, ru.full_name AS resolved_by_name
      FROM sync_conflicts c JOIN assets a ON a.id = c.entity_id JOIN departments d ON d.id = c.department_id
      JOIN users su ON su.id = c.submitted_by LEFT JOIN users ru ON ru.id = c.resolved_by`;

  app.get('/sync-conflicts', async (req) => {
    const user = await requirePermission(db, req, 'assets.read');
    const q = parse(z.object({ status: z.enum(['open', 'applied', 'discarded', 'all']).default('open') }), req.query);
    const scope = departmentScope(user, 'assets.read');
    const { rows } = await db.query(
      `${SELECT} WHERE ($1::uuid[] IS NULL OR c.department_id = ANY($1::uuid[])) AND ($2 = 'all' OR c.status = $2)
        ORDER BY c.received_at DESC LIMIT 200`,
      [scope === 'all' ? null : scope, q.status],
    );
    return { items: rows.map((r) => toConflict(r, can(user, 'assets.edit', r.department_id))) };
  });

  // Apply the offline edit on top of the current version, or discard it. Both are recorded.
  app.post('/sync-conflicts/:id/resolve', async (req, reply) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(z.strictObject({ action: z.enum(['apply', 'discard']), note: z.string().trim().max(1000).optional() }), req.body);
    const pre = (await db.query(`${SELECT} WHERE c.id = $1`, [id])).rows[0];
    if (!pre) throw notFound('Conflict');
    const user = await requirePermission(db, req, 'assets.edit', pre.department_id);
    if (pre.status !== 'open') throw conflict('ALREADY_RESOLVED', 'This conflict has already been resolved.');

    if (body.action === 'apply') {
      // Re-run the edit through the normal endpoint as the reviewer, against the asset's current version,
      // so every validation and permission rule applies (e.g. financial fields, duplicate serial numbers).
      const current = (await db.query('SELECT version FROM assets WHERE id = $1', [pre.entity_id])).rows[0];
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/assets/${pre.entity_id}`,
        headers: { authorization: req.headers.authorization ?? '', 'content-type': 'application/json' },
        payload: { ...pre.proposed, version: current.version },
      });
      if (res.statusCode !== 200) return reply.status(res.statusCode).send(res.json());
    }
    const status = body.action === 'apply' ? 'applied' : 'discarded';
    await db.tx(async (q) => {
      const done = await q.query(
        `UPDATE sync_conflicts SET status = $2, resolved_by = $3, resolved_at = now(), resolution_note = $4 WHERE id = $1 AND status = 'open' RETURNING id`,
        [id, status, user.id, body.note ?? null],
      );
      if (!done.rows[0]) throw conflict('ALREADY_RESOLVED', 'This conflict has already been resolved.');
      await audit(q, {
        actorId: user.id, action: `sync.conflict_${status}`, entityType: 'asset', entityId: pre.entity_id, departmentId: pre.department_id,
        context: { conflictId: id, note: body.note ?? null }, ip: req.ip,
      });
    });
    return toConflict((await db.query(`${SELECT} WHERE c.id = $1`, [id])).rows[0], true);
  });
}
