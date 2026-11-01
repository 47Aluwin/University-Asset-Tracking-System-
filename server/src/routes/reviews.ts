// Post-registration review and correction (brief §9).
// The Asset Management Team reviews registered records; a record can be approved or returned to its department
// for correction. The asset, its ID and QR code are never replaced; corrections are made with the normal edit
// screen (before/after values recorded) and then sent back for re-review. Every step is kept in asset_reviews.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { parse, requirePermission, type AppDeps } from '../app.ts';
import { audit } from '../audit.ts';
import { can } from '../authz.ts';
import { conflict } from '../errors.ts';
import { existingAsset, FINANCIAL_FIELDS, loadAssetRow, toAsset } from './assets.ts';

const IdParam = z.object({ id: z.uuid() });
/** Fields a reviewer can point at when returning a record. */
const REVIEW_FIELDS = [
  'name', 'description', 'categoryId', 'manufacturer', 'model', 'serialNumber', 'manufacturerBarcode', 'locationId', 'acquisitionDate',
  'acquisitionMethod', 'acquisitionCost', 'currency', 'costStatus', 'supplier', 'purchaseOrderRef', 'warrantyExpiry', 'condition', 'notes',
] as const;

export function reviewRoutes(app: FastifyInstance, { db }: AppDeps) {
  // Approve, or return for correction with a reason (and optionally the fields that need attention).
  app.post('/assets/:id/review', async (req) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(
      z.strictObject({
        action: z.enum(['approve', 'return']),
        note: z.string().trim().max(2000).optional(),
        fields: z.array(z.enum(REVIEW_FIELDS)).max(REVIEW_FIELDS.length).default([]),
        version: z.number().int().min(1),
      }),
      req.body,
    );
    const pre = await existingAsset(db, id);
    const user = await requirePermission(db, req, 'assets.review', pre.owning_department_id);
    if (body.action === 'return' && (body.note ?? '').length < 5) {
      throw conflict('REASON_REQUIRED', 'Say what needs correcting (at least 5 characters).');
    }
    return db.tx(async (q) => {
      const row = await loadAssetRow(q, id, true);
      if (row.version !== body.version) throw conflict('VERSION_CONFLICT', 'This asset changed after you opened it. Reload and review the latest details.', { currentVersion: row.version });
      if (row.archived_at) throw conflict('ARCHIVED', 'Archived assets are not reviewed.');
      if (row.registration_status !== 'registered') throw conflict('NOT_REGISTERED', 'Only registered assets are reviewed.');
      if (!['not_reviewed', 'corrected_awaiting_rereview'].includes(row.review_status)) {
        throw conflict('NOT_AWAITING_REVIEW', row.review_status === 'approved' ? 'This record is already approved.' : 'This record is with its department for correction.');
      }
      const next = body.action === 'approve' ? 'approved' : 'returned_for_correction';
      await q.query(`UPDATE assets SET review_status = $2, version = version + 1, updated_at = now() WHERE id = $1`, [id, next]);
      await q.query(
        `INSERT INTO asset_reviews (asset_id, department_id, action, note, fields, actor_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, row.owning_department_id, body.action === 'approve' ? 'approved' : 'returned', body.note || null, body.action === 'return' ? body.fields : [], user.id],
      );
      await audit(q, {
        actorId: user.id, action: body.action === 'approve' ? 'asset.review_approve' : 'asset.review_return', entityType: 'asset', entityId: id,
        departmentId: row.owning_department_id, before: { reviewStatus: row.review_status }, after: { reviewStatus: next },
        context: { institutionalId: row.institutional_id, note: body.note ?? null, fields: body.fields }, ip: req.ip,
      });
      return toAsset(await loadAssetRow(q, id), user);
    });
  });

  // The department says the corrections are done. The changes made since the record was returned are attached,
  // so the reviewer sees exactly what was corrected.
  app.post('/assets/:id/corrections-done', async (req) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(z.strictObject({ note: z.string().trim().max(2000).optional(), version: z.number().int().min(1) }), req.body);
    const pre = await existingAsset(db, id);
    const user = await requirePermission(db, req, 'assets.edit', pre.owning_department_id);
    return db.tx(async (q) => {
      const row = await loadAssetRow(q, id, true);
      if (row.version !== body.version) throw conflict('VERSION_CONFLICT', 'This asset changed after you opened it. Reload and try again.', { currentVersion: row.version });
      if (row.review_status !== 'returned_for_correction') throw conflict('NOT_RETURNED', 'This record has not been returned for correction.');
      const returned = (await q.query(`SELECT created_at FROM asset_reviews WHERE asset_id = $1 AND action = 'returned' ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];
      const edits = (
        await q.query(
          `SELECT before_data, after_data FROM audit_events
            WHERE entity_type = 'asset' AND entity_id = $1 AND action = 'asset.update' AND occurred_at >= $2 ORDER BY occurred_at`,
          [id, returned.created_at],
        )
      ).rows;
      // First "before" and last "after" for each field changed since the return.
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      for (const e of edits) {
        for (const [k, v] of Object.entries(e.after_data ?? {})) {
          changes[k] = { before: k in changes ? changes[k].before : (e.before_data ?? {})[k] ?? null, after: v };
        }
      }
      if (!Object.keys(changes).length && (body.note ?? '').length < 5) {
        throw conflict('NOTE_REQUIRED', 'No details were changed. Explain why no correction is needed (at least 5 characters), or edit the record first.');
      }
      await q.query(`UPDATE assets SET review_status = 'corrected_awaiting_rereview', version = version + 1, updated_at = now() WHERE id = $1`, [id]);
      await q.query(
        `INSERT INTO asset_reviews (asset_id, department_id, action, note, changes, actor_id) VALUES ($1, $2, 'corrections_submitted', $3, $4::jsonb, $5)`,
        [id, row.owning_department_id, body.note || null, JSON.stringify(changes), user.id],
      );
      await audit(q, {
        actorId: user.id, action: 'asset.corrections_submitted', entityType: 'asset', entityId: id, departmentId: row.owning_department_id,
        before: { reviewStatus: 'returned_for_correction' }, after: { reviewStatus: 'corrected_awaiting_rereview' },
        context: { institutionalId: row.institutional_id, fields: Object.keys(changes), note: body.note ?? null }, ip: req.ip,
      });
      return toAsset(await loadAssetRow(q, id), user);
    });
  });

  app.get('/assets/:id/reviews', async (req) => {
    const { id } = parse(IdParam, req.params);
    const pre = await existingAsset(db, id);
    const user = await requirePermission(db, req, 'assets.read', pre.owning_department_id);
    // People without financial access (e.g. a read-only grant) do not see cost details in the history either.
    const financial = can(user, 'assets.read_financial', pre.owning_department_id);
    const hide = (o: Record<string, unknown> | null) =>
      o && !financial ? Object.fromEntries(Object.entries(o).filter(([k]) => !(FINANCIAL_FIELDS as readonly string[]).includes(k))) : o;
    const { rows } = await db.query(
      `SELECT r.id, r.action, r.note, r.fields, r.changes, r.created_at, u.full_name AS actor
         FROM asset_reviews r JOIN users u ON u.id = r.actor_id WHERE r.asset_id = $1 ORDER BY r.created_at DESC`,
      [id],
    );
    return { items: rows.map((r) => ({ id: r.id, action: r.action, note: r.note, fields: r.fields, changes: hide(r.changes), at: r.created_at, by: r.actor })) };
  });
}
