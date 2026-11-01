// Phase 3: physical verification, relocation (movement history), missing status, review flags and
// recurring verification schedules. Verification and relocation are separate events: a move is not
// proof that someone saw the asset, and a sighting does not by itself move it (unless asked to).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { pageParams, parse, requirePermission, requireUser, type AppDeps } from '../app.ts';
import { audit } from '../audit.ts';
import { can, departmentScope } from '../authz.ts';
import type { Queryable } from '../db.ts';
import { AppError, conflict, notFound } from '../errors.ts';
import { existingAsset, loadAssetRow, readableAsset, toAsset } from './assets.ts';

const IdParam = z.object({ id: z.uuid() });

/** A repeat scan of the same asset by the same person at the same place within this window is recorded once. */
export const DUPLICATE_SCAN_WINDOW_MINUTES = 10;
/** Device clocks may run slightly fast; anything further in the future is refused. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
/** Events reported this long after they happened are flagged for review (e.g. a device offline for days). */
const LATE_EVENT_DAYS = 7;

const EventTime = z.iso.datetime({ offset: true, message: 'Use an ISO date-time, e.g. 2026-10-28T09:30:00Z.' }).optional();

function eventTimeOrNow(value: string | undefined): Date {
  const t = value ? new Date(value) : new Date();
  if (t.getTime() - Date.now() > MAX_CLOCK_SKEW_MS) {
    throw new AppError(400, 'EVENT_IN_FUTURE', 'The event time is in the future. Check the device clock and try again.');
  }
  return t;
}

const isLate = (t: Date) => Date.now() - t.getTime() > LATE_EVENT_DAYS * 86_400_000;

function operationIdFrom(req: FastifyRequest): string | null {
  const h = req.headers['x-operation-id'];
  return typeof h === 'string' ? parse(z.uuid('X-Operation-Id must be a UUID.'), h) : null;
}

async function activeLocation(q: Queryable, id: string) {
  const l = (await q.query('SELECT id, department_id, building, room, is_active FROM locations WHERE id = $1', [id])).rows[0];
  if (!l || !l.is_active) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', [{ path: 'locationId', message: 'Choose an active location.' }]);
  }
  return l as { id: string; department_id: string; building: string; room: string };
}

async function addFlag(
  q: Queryable,
  f: { assetId: string; departmentId: string; kind: string; sourceType: string; sourceId: string | null; details: unknown; userId: string },
) {
  await q.query(
    `INSERT INTO asset_flags (asset_id, department_id, kind, source_type, source_id, details, created_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [f.assetId, f.departmentId, f.kind, f.sourceType, f.sourceId, JSON.stringify(f.details), f.userId],
  );
}

function requireRegistered(row: Record<string, any>) {
  if (row.archived_at) throw conflict('ARCHIVED', 'This asset is archived.');
  if (row.registration_status !== 'registered') {
    throw conflict('NOT_REGISTERED', 'Finish registering this asset (print, attach and confirm its label) first.');
  }
}

/**
 * Records a move inside an open transaction and updates the current location — unless a later move
 * has already been recorded (an older, late-arriving event is kept in history but does not overwrite).
 */
async function recordMove(
  q: Queryable,
  row: Record<string, any>,
  to: { id: string; department_id: string },
  m: { userId: string; eventTime: Date; reason: string | null; source: 'relocation' | 'verification'; operationId: string | null },
) {
  const latest = (await q.query(`SELECT max(event_time) AS t FROM movement_events WHERE asset_id = $1`, [row.id])).rows[0]?.t;
  const isCurrent = !latest || m.eventTime > new Date(latest);
  const { rows } = await q.query(
    `INSERT INTO movement_events (asset_id, moved_by, event_time, from_department_id, from_location_id, to_department_id,
       to_location_id, reason, source, operation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [row.id, m.userId, m.eventTime, row.owning_department_id, row.location_id, to.department_id, to.id, m.reason, m.source, m.operationId],
  );
  const movementId = rows[0].id as string;
  if (isCurrent) {
    await q.query(
      `UPDATE assets SET location_id = $2, owning_department_id = $3, version = version + 1, updated_by = $4, updated_at = now() WHERE id = $1`,
      [row.id, to.id, to.department_id, m.userId],
    );
  } else {
    await addFlag(q, {
      assetId: row.id, departmentId: row.owning_department_id, kind: 'late_event', sourceType: 'movement', sourceId: movementId, userId: m.userId,
      details: { note: 'A newer move was already recorded, so this older move was kept in history without changing the current location.' },
    });
  }
  const crossDepartment = to.department_id !== row.owning_department_id;
  if (crossDepartment) {
    await addFlag(q, {
      assetId: row.id, departmentId: to.department_id, kind: 'cross_department_move', sourceType: 'movement', sourceId: movementId, userId: m.userId,
      details: { fromDepartmentId: row.owning_department_id, toDepartmentId: to.department_id, reason: m.reason },
    });
  }
  await audit(q, {
    actorId: m.userId,
    action: 'asset.move',
    entityType: 'asset',
    entityId: row.id,
    departmentId: to.department_id,
    before: { departmentId: row.owning_department_id, locationId: row.location_id },
    after: { departmentId: to.department_id, locationId: to.id },
    context: { institutionalId: row.institutional_id, reason: m.reason, source: m.source, eventTime: m.eventTime.toISOString(), appliedAsCurrent: isCurrent },
  });
  return { movementId, isCurrent, crossDepartment };
}

const VERIFICATION_SELECT = `
  SELECT v.id, v.event_time, v.received_at, v.outcome, v.method, v.notes, u.full_name AS verified_by,
         ol.building AS observed_building, ol.room AS observed_room, od.name AS observed_department,
         el.building AS expected_building, el.room AS expected_room
    FROM verification_events v
    JOIN users u ON u.id = v.verified_by
    JOIN locations ol ON ol.id = v.observed_location_id
    JOIN departments od ON od.id = ol.department_id
    JOIN locations el ON el.id = v.expected_location_id`;

const toVerification = (r: Record<string, any>) => ({
  id: r.id,
  eventTime: r.event_time,
  receivedAt: r.received_at,
  outcome: r.outcome,
  method: r.method,
  notes: r.notes,
  verifiedBy: r.verified_by,
  observedLocation: { building: r.observed_building, room: r.observed_room, department: r.observed_department },
  expectedLocation: { building: r.expected_building, room: r.expected_room },
});

export function verificationRoutes(app: FastifyInstance, { db }: AppDeps) {
  // ---------------- verification ----------------

  app.post('/assets/:id/verifications', async (req, reply) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(
      z.strictObject({
        method: z.enum(['scan', 'manual']),
        observedLocationId: z.uuid().optional(),
        eventTime: EventTime,
        notes: z.string().trim().max(1000).optional(),
        alsoMoveHere: z.boolean().optional(),
      }),
      req.body,
    );
    const operationId = operationIdFrom(req);
    const pre = await existingAsset(db, id);
    const user = await requirePermission(db, req, 'verification.record', pre.owning_department_id);
    requireRegistered(pre);
    const eventTime = eventTimeOrNow(body.eventTime);
    const observed = await activeLocation(db, body.observedLocationId ?? pre.location_id);
    if (!can(user, 'assets.read', observed.department_id)) await requirePermission(db, req, 'assets.read', observed.department_id);
    const discrepancy = observed.id !== pre.location_id;
    const move = !!body.alsoMoveHere && discrepancy;
    if (move) {
      await requirePermission(db, req, 'movement.record', pre.owning_department_id);
      if (observed.department_id !== pre.owning_department_id) await requirePermission(db, req, 'movement.record', observed.department_id);
    }

    const result = await db.tx(async (q) => {
      // Retried submission (same operation id): return what was recorded the first time.
      if (operationId) {
        const prev = (await q.query('SELECT id, verified_by FROM verification_events WHERE operation_id = $1', [operationId])).rows[0];
        if (prev) {
          if (prev.verified_by !== user.id) throw conflict('OPERATION_ID_REUSED', 'This operation id was already used for a different request.');
          return { status: 200, verificationId: prev.id as string, duplicate: true };
        }
      }
      const row = await loadAssetRow(q, id, true);
      requireRegistered(row);
      // Accidental double scan: same person, same asset, same place, within a few minutes → recorded once.
      // Only when nothing has changed since: if the asset was moved (its recorded location differs from the
      // one the earlier scan saw) or it is marked missing, the new scan carries new information and counts.
      const recent =
        row.missing_status !== 'none'
          ? undefined
          : (
              await q.query(
                `SELECT id FROM verification_events
                  WHERE asset_id = $1 AND verified_by = $2 AND observed_location_id = $3
                    AND expected_location_id = $6
                    AND abs(extract(epoch FROM (event_time - $4::timestamptz))) < $5 * 60
                  ORDER BY event_time DESC LIMIT 1`,
                [id, user.id, observed.id, eventTime, DUPLICATE_SCAN_WINDOW_MINUTES, row.location_id],
              )
            ).rows[0];
      if (recent) return { status: 200, verificationId: recent.id as string, duplicate: true };

      const outcome = discrepancy ? 'location_discrepancy' : 'verified';
      const { rows } = await q.query(
        `INSERT INTO verification_events (asset_id, verified_by, event_time, department_id, expected_location_id,
           observed_location_id, outcome, method, notes, operation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [id, user.id, eventTime, row.owning_department_id, row.location_id, observed.id, outcome, body.method, body.notes ?? null, operationId],
      );
      const verificationId = rows[0].id as string;
      // Latest successful sighting: only move forward in time (an old offline scan must not hide a newer one).
      await q.query(
        `UPDATE assets SET last_verified_at = $2, last_verified_by = $3, last_verified_location_id = $4, last_verification_id = $5
          WHERE id = $1 AND (last_verified_at IS NULL OR last_verified_at < $2)`,
        [id, eventTime, user.id, observed.id, verificationId],
      );
      if (row.missing_status !== 'none') {
        await q.query(
          `UPDATE assets SET missing_status = 'none', missing_reported_at = NULL, missing_reported_by = NULL, missing_reason = NULL,
                  missing_confirmed_at = NULL, missing_confirmed_by = NULL WHERE id = $1`,
          [id],
        );
        await addFlag(q, {
          assetId: id, departmentId: row.owning_department_id, kind: 'found_after_missing', sourceType: 'verification', sourceId: verificationId,
          userId: user.id, details: { previousStatus: row.missing_status, reason: row.missing_reason },
        });
      }
      if (discrepancy) {
        await addFlag(q, {
          assetId: id, departmentId: row.owning_department_id, kind: 'location_discrepancy', sourceType: 'verification', sourceId: verificationId,
          userId: user.id,
          details: {
            expected: `${row.building}, ${row.room}`,
            observed: `${observed.building}, ${observed.room}`,
            observedDepartmentId: observed.department_id,
            movedHere: move,
          },
        });
      }
      if (isLate(eventTime)) {
        await addFlag(q, {
          assetId: id, departmentId: row.owning_department_id, kind: 'late_event', sourceType: 'verification', sourceId: verificationId,
          userId: user.id, details: { eventTime: eventTime.toISOString(), note: `Recorded more than ${LATE_EVENT_DAYS} days after it happened.` },
        });
      }
      await audit(q, {
        actorId: user.id,
        action: 'asset.verify',
        entityType: 'asset',
        entityId: id,
        departmentId: row.owning_department_id,
        context: {
          institutionalId: row.institutional_id,
          outcome,
          method: body.method,
          observedLocationId: observed.id,
          eventTime: eventTime.toISOString(),
          ...(row.missing_status !== 'none' ? { foundAfter: row.missing_status } : {}),
        },
        ip: req.ip,
      });
      if (move) {
        await recordMove(q, row, observed, { userId: user.id, eventTime, reason: 'Found here during verification', source: 'verification', operationId: null });
      }
      return { status: 201, verificationId, duplicate: false };
    });

    const v = (await db.query(`${VERIFICATION_SELECT} WHERE v.id = $1`, [result.verificationId])).rows[0];
    return reply.status(result.status).send({
      duplicate: result.duplicate,
      verification: toVerification(v),
      asset: toAsset(await loadAssetRow(db, id), user),
    });
  });

  app.get('/assets/:id/verifications', async (req) => {
    const { id } = parse(IdParam, req.params);
    await readableAsset(db, req, id);
    const { rows } = await db.query(`${VERIFICATION_SELECT} WHERE v.asset_id = $1 ORDER BY v.event_time DESC LIMIT 200`, [id]);
    return { items: rows.map(toVerification) };
  });

  // ---------------- relocation ----------------

  app.post('/assets/:id/movements', async (req, reply) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(
      z.strictObject({
        toLocationId: z.uuid('Choose where the asset is going.'),
        reason: z.string().trim().max(500).optional(),
        eventTime: EventTime,
      }),
      req.body,
    );
    const operationId = operationIdFrom(req);
    const pre = await existingAsset(db, id);
    const user = await requirePermission(db, req, 'movement.record', pre.owning_department_id);
    if (!pre.archived_at && pre.registration_status !== 'registered') {
      throw conflict('USE_EDIT', 'This asset is not registered yet: correct its location with "Edit details" instead.');
    }
    requireRegistered(pre);
    const eventTime = eventTimeOrNow(body.eventTime);
    const to = await activeLocation(db, body.toLocationId);
    const crossDepartment = to.department_id !== pre.owning_department_id;
    if (crossDepartment) {
      // Transferring ownership needs permission in the receiving department too, and a reason.
      await requirePermission(db, req, 'movement.record', to.department_id);
      if ((body.reason ?? '').length < 3) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', [
          { path: 'reason', message: 'Give a reason for moving the asset to another department.' },
        ]);
      }
    }

    const result = await db.tx(async (q) => {
      if (operationId) {
        const prev = (await q.query('SELECT id, moved_by FROM movement_events WHERE operation_id = $1', [operationId])).rows[0];
        if (prev) {
          if (prev.moved_by !== user.id) throw conflict('OPERATION_ID_REUSED', 'This operation id was already used for a different request.');
          return { status: 200, movementId: prev.id as string, duplicate: true };
        }
      }
      const row = await loadAssetRow(q, id, true);
      requireRegistered(row);
      if (row.owning_department_id !== pre.owning_department_id) {
        throw conflict('VERSION_CONFLICT', 'This asset was moved to another department a moment ago. Reload and try again.');
      }
      if (row.location_id === to.id) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', [
          { path: 'toLocationId', message: 'The asset is already recorded at this location.' },
        ]);
      }
      const m = await recordMove(q, row, to, { userId: user.id, eventTime, reason: body.reason ?? null, source: 'relocation', operationId });
      return { status: 201, movementId: m.movementId, duplicate: false };
    });
    const mv = (await db.query(`${MOVEMENT_SELECT} WHERE m.id = $1`, [result.movementId])).rows[0];
    return reply.status(result.status).send({
      duplicate: result.duplicate,
      movement: toMovement(mv),
      asset: toAsset(await loadAssetRow(db, id), user),
    });
  });

  app.get('/assets/:id/movements', async (req) => {
    const { id } = parse(IdParam, req.params);
    await readableAsset(db, req, id);
    const { rows } = await db.query(`${MOVEMENT_SELECT} WHERE m.asset_id = $1 ORDER BY m.event_time DESC LIMIT 200`, [id]);
    return { items: rows.map(toMovement) };
  });

  // ---------------- missing status ----------------

  app.post('/assets/:id/report-missing', async (req) => {
    const { id } = parse(IdParam, req.params);
    const { reason } = parse(z.strictObject({ reason: z.string().trim().min(5, 'Say where it was last seen or why it is missing (at least 5 characters).').max(1000) }), req.body);
    const pre = await existingAsset(db, id);
    const user = await requirePermission(db, req, 'missing.report', pre.owning_department_id);
    requireRegistered(pre);
    return db.tx(async (q) => {
      const row = await loadAssetRow(q, id, true);
      if (row.missing_status !== 'none') throw conflict('ALREADY_MISSING', 'This asset is already reported missing.');
      await q.query(
        `UPDATE assets SET missing_status = 'reported_missing', missing_reported_at = now(), missing_reported_by = $2, missing_reason = $3,
                version = version + 1, updated_by = $2, updated_at = now() WHERE id = $1`,
        [id, user.id, reason],
      );
      await addFlag(q, { assetId: id, departmentId: row.owning_department_id, kind: 'reported_missing', sourceType: 'missing_report', sourceId: null, userId: user.id, details: { reason } });
      await audit(q, { actorId: user.id, action: 'asset.report_missing', entityType: 'asset', entityId: id, departmentId: row.owning_department_id, before: { missingStatus: 'none' }, after: { missingStatus: 'reported_missing' }, context: { institutionalId: row.institutional_id, reason }, ip: req.ip });
      return toAsset(await loadAssetRow(q, id), user);
    });
  });

  // Confirming or clearing "missing" is an oversight decision, not routine fieldwork.
  for (const action of ['confirm-missing', 'clear-missing'] as const) {
    app.post(`/assets/:id/${action}`, async (req) => {
      const { id } = parse(IdParam, req.params);
      const { note } = parse(z.strictObject({ note: z.string().trim().min(3, 'Add a short note explaining the decision.').max(1000) }), req.body);
      const pre = await existingAsset(db, id);
      const user = await requirePermission(db, req, 'missing.confirm', pre.owning_department_id);
      return db.tx(async (q) => {
        const row = await loadAssetRow(q, id, true);
        if (action === 'confirm-missing' && row.missing_status !== 'reported_missing') {
          throw conflict('NOT_REPORTED', 'Only an asset reported missing can be confirmed missing.');
        }
        if (action === 'clear-missing' && row.missing_status === 'none') throw conflict('NOT_MISSING', 'This asset is not marked missing.');
        const next = action === 'confirm-missing' ? 'confirmed_missing' : 'none';
        if (next === 'confirmed_missing') {
          await q.query(
            `UPDATE assets SET missing_status = 'confirmed_missing', missing_confirmed_at = now(), missing_confirmed_by = $2,
                    version = version + 1, updated_by = $2, updated_at = now() WHERE id = $1`,
            [id, user.id],
          );
        } else {
          await q.query(
            `UPDATE assets SET missing_status = 'none', missing_reported_at = NULL, missing_reported_by = NULL, missing_reason = NULL,
                    missing_confirmed_at = NULL, missing_confirmed_by = NULL, version = version + 1, updated_by = $2, updated_at = now()
              WHERE id = $1`,
            [id, user.id],
          );
        }
        // The open "reported missing" flag is answered by this decision.
        await q.query(
          `UPDATE asset_flags SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolution_note = $3
            WHERE asset_id = $1 AND kind = 'reported_missing' AND status = 'open'`,
          [id, user.id, `${next === 'none' ? 'Cleared' : 'Confirmed missing'}: ${note}`],
        );
        await audit(q, {
          actorId: user.id,
          action: action === 'confirm-missing' ? 'asset.confirm_missing' : 'asset.clear_missing',
          entityType: 'asset',
          entityId: id,
          departmentId: row.owning_department_id,
          before: { missingStatus: row.missing_status },
          after: { missingStatus: next },
          context: { institutionalId: row.institutional_id, note },
          ip: req.ip,
        });
        return toAsset(await loadAssetRow(q, id), user);
      });
    });
  }

  // ---------------- review flags ----------------

  app.get('/flags', async (req) => {
    const user = await requirePermission(db, req, 'flags.read');
    const q = parse(
      z.object({
        status: z.enum(['open', 'resolved', 'all']).default('open'),
        kind: z.enum(['location_discrepancy', 'cross_department_move', 'reported_missing', 'found_after_missing', 'late_event']).optional(),
        assetId: z.uuid().optional(),
        page: z.coerce.number().int().optional(),
        pageSize: z.coerce.number().int().optional(),
      }),
      req.query,
    );
    const p = pageParams(q);
    const scope = departmentScope(user, 'flags.read');
    const { rows } = await db.query(
      `SELECT f.id, f.kind, f.status, f.details, f.created_at, f.resolved_at, f.resolution_note, f.source_type,
              a.id AS asset_id, a.institutional_id, a.name AS asset_name, d.name AS department_name,
              cu.full_name AS created_by_name, ru.full_name AS resolved_by_name, count(*) OVER()::int AS total
         FROM asset_flags f
         JOIN assets a ON a.id = f.asset_id
         JOIN departments d ON d.id = f.department_id
         LEFT JOIN users cu ON cu.id = f.created_by
         LEFT JOIN users ru ON ru.id = f.resolved_by
        WHERE ($1::uuid[] IS NULL OR f.department_id = ANY($1::uuid[]))
          AND ($2 = 'all' OR f.status = $2)
          AND ($3::text IS NULL OR f.kind = $3)
          AND ($4::uuid IS NULL OR f.asset_id = $4)
        ORDER BY f.created_at DESC
        LIMIT $5 OFFSET $6`,
      [scope === 'all' ? null : scope, q.status, q.kind ?? null, q.assetId ?? null, p.limit, p.offset],
    );
    return {
      page: p.page,
      pageSize: p.pageSize,
      total: rows[0]?.total ?? 0,
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        details: r.details,
        createdAt: r.created_at,
        createdBy: r.created_by_name,
        resolvedAt: r.resolved_at,
        resolvedBy: r.resolved_by_name,
        resolutionNote: r.resolution_note,
        asset: { id: r.asset_id, institutionalId: r.institutional_id, name: r.asset_name, department: r.department_name },
        canResolve: r.status === 'open' && can(user, 'flags.review'),
      })),
    };
  });

  app.post('/flags/:id/resolve', async (req) => {
    const { id } = parse(IdParam, req.params);
    const { note } = parse(z.strictObject({ note: z.string().trim().min(3, 'Say what was checked or done (at least 3 characters).').max(1000) }), req.body);
    const flag = (await db.query('SELECT id, asset_id, department_id, kind, status FROM asset_flags WHERE id = $1', [id])).rows[0];
    if (!flag) throw notFound('Flag');
    const user = await requirePermission(db, req, 'flags.review', flag.department_id);
    return db.tx(async (q) => {
      const r = await q.query(
        `UPDATE asset_flags SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolution_note = $3
          WHERE id = $1 AND status = 'open' RETURNING id`,
        [id, user.id, note],
      );
      if (!r.rows[0]) throw conflict('ALREADY_RESOLVED', 'This flag has already been resolved.');
      await audit(q, { actorId: user.id, action: 'flag.resolve', entityType: 'asset', entityId: flag.asset_id, departmentId: flag.department_id, context: { flagId: id, kind: flag.kind, note }, ip: req.ip });
      return { ok: true };
    });
  });

  // ---------------- verification schedules ----------------

  app.get('/verification-schedules', async (req) => {
    requireUser(req);
    const { rows } = await db.query(
      `SELECT s.id, s.department_id, d.name AS department_name, s.category_id, c.name AS category_name, s.interval_days,
              s.due_window_days, s.notes, s.is_active, s.updated_at
         FROM verification_schedules s
         LEFT JOIN departments d ON d.id = s.department_id
         LEFT JOIN asset_categories c ON c.id = s.category_id
        ORDER BY s.is_active DESC, d.name NULLS FIRST, c.name NULLS FIRST`,
    );
    return { items: rows.map(toSchedule) };
  });

  const ScheduleFields = {
    intervalDays: z.number().int().min(1, 'At least 1 day.').max(3660, 'At most 10 years.'),
    dueWindowDays: z.number().int().min(0).max(365),
    notes: z.string().trim().max(500).nullable().optional(),
  };

  app.post('/verification-schedules', async (req, reply) => {
    const admin = await requirePermission(db, req, 'schedules.manage');
    const body = parse(
      z.strictObject({ departmentId: z.uuid().nullable(), categoryId: z.uuid().nullable(), ...ScheduleFields }),
      req.body,
    );
    if (body.dueWindowDays >= body.intervalDays) throw windowError();
    return db.tx(async (q) => {
      const dup = await q.query(
        `SELECT 1 FROM verification_schedules WHERE is_active
            AND department_id IS NOT DISTINCT FROM $1::uuid AND category_id IS NOT DISTINCT FROM $2::uuid`,
        [body.departmentId, body.categoryId],
      );
      if (dup.rows[0]) throw conflict('DUPLICATE_SCHEDULE', 'An active schedule already exists for this department and category. Edit that one instead.');
      const { rows } = await q.query(
        `INSERT INTO verification_schedules (department_id, category_id, interval_days, due_window_days, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [body.departmentId, body.categoryId, body.intervalDays, body.dueWindowDays, body.notes ?? null, admin.id],
      );
      await audit(q, { actorId: admin.id, action: 'schedule.create', entityType: 'verification_schedule', entityId: rows[0].id, departmentId: body.departmentId, after: body, ip: req.ip });
      return reply.status(201).send({ id: rows[0].id });
    });
  });

  app.patch('/verification-schedules/:id', async (req) => {
    const admin = await requirePermission(db, req, 'schedules.manage');
    const { id } = parse(IdParam, req.params);
    const body = parse(
      z.strictObject({
        intervalDays: ScheduleFields.intervalDays.optional(),
        dueWindowDays: ScheduleFields.dueWindowDays.optional(),
        notes: ScheduleFields.notes,
        isActive: z.boolean().optional(),
      }),
      req.body,
    );
    return db.tx(async (q) => {
      const cur = (await q.query('SELECT * FROM verification_schedules WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw notFound('Schedule');
      const next = {
        intervalDays: body.intervalDays ?? cur.interval_days,
        dueWindowDays: body.dueWindowDays ?? cur.due_window_days,
        notes: body.notes === undefined ? cur.notes : body.notes,
        isActive: body.isActive ?? cur.is_active,
      };
      if (next.dueWindowDays >= next.intervalDays) throw windowError();
      if (next.isActive && !cur.is_active) {
        const dup = await q.query(
          `SELECT 1 FROM verification_schedules WHERE is_active AND id <> $3
              AND department_id IS NOT DISTINCT FROM $1::uuid AND category_id IS NOT DISTINCT FROM $2::uuid`,
          [cur.department_id, cur.category_id, id],
        );
        if (dup.rows[0]) throw conflict('DUPLICATE_SCHEDULE', 'Another active schedule already covers this department and category.');
      }
      await q.query(
        `UPDATE verification_schedules SET interval_days = $2, due_window_days = $3, notes = $4, is_active = $5, updated_at = now() WHERE id = $1`,
        [id, next.intervalDays, next.dueWindowDays, next.notes, next.isActive],
      );
      await audit(q, {
        actorId: admin.id,
        action: 'schedule.update',
        entityType: 'verification_schedule',
        entityId: id,
        departmentId: cur.department_id,
        before: { intervalDays: cur.interval_days, dueWindowDays: cur.due_window_days, notes: cur.notes, isActive: cur.is_active },
        after: next,
        ip: req.ip,
      });
      return { ok: true };
    });
  });
}

const windowError = () =>
  new AppError(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', [
    { path: 'dueWindowDays', message: 'The "due soon" warning must start before the full interval has passed.' },
  ]);

const toSchedule = (r: Record<string, any>) => ({
  id: r.id,
  department: r.department_id ? { id: r.department_id, name: r.department_name } : null,
  category: r.category_id ? { id: r.category_id, name: r.category_name } : null,
  intervalDays: r.interval_days,
  dueWindowDays: r.due_window_days,
  notes: r.notes,
  isActive: r.is_active,
  updatedAt: r.updated_at,
});

const MOVEMENT_SELECT = `
  SELECT m.id, m.event_time, m.received_at, m.reason, m.source, u.full_name AS moved_by,
         fl.building AS from_building, fl.room AS from_room, fd.name AS from_department,
         tl.building AS to_building, tl.room AS to_room, td.name AS to_department
    FROM movement_events m
    JOIN users u ON u.id = m.moved_by
    JOIN locations fl ON fl.id = m.from_location_id
    JOIN departments fd ON fd.id = m.from_department_id
    JOIN locations tl ON tl.id = m.to_location_id
    JOIN departments td ON td.id = m.to_department_id`;

const toMovement = (r: Record<string, any>) => ({
  id: r.id,
  eventTime: r.event_time,
  receivedAt: r.received_at,
  reason: r.reason,
  source: r.source,
  movedBy: r.moved_by,
  from: { building: r.from_building, room: r.from_room, department: r.from_department },
  to: { building: r.to_building, room: r.to_room, department: r.to_department },
});

