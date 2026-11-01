// Phase 4: condition history, damage reports, department-managed maintenance, costs and attachments.
// Each department manages its own requests; the Asset Management Team and administrators can oversee them.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { pageParams, parse, requirePermission, type AppDeps, type AuthUser } from '../app.ts';
import { audit } from '../audit.ts';
import { can, departmentScope } from '../authz.ts';
import type { Db, Queryable } from '../db.ts';
import { AppError, conflict, notFound } from '../errors.ts';
import { once } from '../idempotency.ts';
import { cleanFileName, sha256Hex, sniffFileType } from '../storage.ts';
import { getSetting } from '../settings.ts';
import { existingAsset, loadAssetRow, readableAsset, toAsset } from './assets.ts';
import { CONDITIONS, parseMoney, todayIn } from '../../../shared/asset-codes.ts';

const IdParam = z.object({ id: z.uuid() });
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const EventTime = z.iso.datetime({ offset: true, message: 'Use an ISO date-time.' }).optional();

export const MAINTENANCE_STATUSES = [
  'submitted', 'under_review', 'approved', 'in_progress', 'awaiting_parts', 'awaiting_external', 'completed', 'rejected', 'cancelled',
] as const;
type Status = (typeof MAINTENANCE_STATUSES)[number];
const CLOSED: readonly Status[] = ['completed', 'rejected', 'cancelled'];
const WORKING: readonly Status[] = ['in_progress', 'awaiting_parts', 'awaiting_external'];

/** Allowed status changes. Completion has its own endpoint because it needs an outcome. */
const TRANSITIONS: Record<Status, Status[]> = {
  submitted: ['under_review', 'approved', 'in_progress', 'rejected', 'cancelled'],
  under_review: ['approved', 'in_progress', 'rejected', 'cancelled'],
  approved: ['in_progress', 'cancelled'],
  in_progress: ['awaiting_parts', 'awaiting_external', 'cancelled'],
  awaiting_parts: ['in_progress', 'awaiting_external', 'cancelled'],
  awaiting_external: ['in_progress', 'awaiting_parts', 'cancelled'],
  completed: [],
  rejected: [],
  cancelled: [],
};

/** Next statuses for this request, applying the department's approval rule. */
export function allowedNext(r: Record<string, any>): Status[] {
  return TRANSITIONS[r.status as Status].filter((to) => {
    if (to === 'approved') return r.requires_approval;
    // With approval on, work can only start once the request is approved.
    if (to === 'in_progress' && r.requires_approval && !r.approved_at && (r.status === 'submitted' || r.status === 'under_review')) return false;
    return true;
  });
}

function eventTimeOrNow(value: string | undefined) {
  const t = value ? new Date(value) : new Date();
  if (t.getTime() - Date.now() > MAX_CLOCK_SKEW_MS) throw new AppError(400, 'EVENT_IN_FUTURE', 'The event time is in the future. Check the device clock.');
  return t;
}

function operationIdFrom(req: FastifyRequest) {
  const h = req.headers['x-operation-id'];
  return typeof h === 'string' ? parse(z.uuid('X-Operation-Id must be a UUID.'), h) : null;
}

function requireRegistered(row: Record<string, any>) {
  if (row.archived_at) throw conflict('ARCHIVED', 'This asset is archived.');
  if (row.registration_status !== 'registered') throw conflict('NOT_REGISTERED', 'Finish registering this asset first.');
}

const fieldError = (path: string, message: string) => new AppError(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', [{ path, message }]);

async function nextReference(q: Queryable) {
  const year = Number(todayIn(await getSetting(q, 'institution_time_zone')).slice(0, 4));
  const { rows } = await q.query(
    `INSERT INTO maintenance_counters (year, last_value) VALUES ($1, 1)
     ON CONFLICT (year) DO UPDATE SET last_value = maintenance_counters.last_value + 1 RETURNING last_value`,
    [year],
  );
  return `MR-${year}-${String(rows[0].last_value).padStart(5, '0')}`;
}

/** Records a condition change and updates the asset's current condition if this is the newest change. */
async function recordCondition(
  q: Queryable,
  row: Record<string, any>,
  c: { userId: string; eventTime: Date; condition: string; source: string; damage?: string | null; notes?: string | null; requestId?: string | null; operationId?: string | null },
) {
  const { rows } = await q.query(
    `INSERT INTO condition_events (asset_id, department_id, recorded_by, event_time, previous_condition, new_condition, source,
       damage_description, notes, maintenance_request_id, operation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [row.id, row.owning_department_id, c.userId, c.eventTime, row.condition, c.condition, c.source, c.damage ?? null, c.notes ?? null, c.requestId ?? null, c.operationId ?? null],
  );
  const latest = (await q.query(`SELECT max(event_time) AS t FROM condition_events WHERE asset_id = $1 AND id <> $2`, [row.id, rows[0].id])).rows[0]?.t;
  const current = !latest || c.eventTime > new Date(latest);
  if (current) {
    await q.query(`UPDATE assets SET condition = $2, version = version + 1, updated_by = $3, updated_at = now() WHERE id = $1`, [row.id, c.condition, c.userId]);
  }
  await audit(q, {
    actorId: c.userId,
    action: 'asset.condition',
    entityType: 'asset',
    entityId: row.id,
    departmentId: row.owning_department_id,
    before: { condition: row.condition },
    after: { condition: c.condition },
    context: { institutionalId: row.institutional_id, source: c.source, damage: c.damage ?? null, appliedAsCurrent: current, maintenanceRequestId: c.requestId ?? null },
  });
  return { id: rows[0].id as string, current };
}

async function createRequest(
  q: Queryable,
  row: Record<string, any>,
  m: { userId: string; problem: string; priority: string; eventTime: Date; operationId: string | null; conditionAtReport?: string },
  ip: string,
) {
  const dept = (await q.query('SELECT maintenance_requires_approval FROM departments WHERE id = $1', [row.owning_department_id])).rows[0];
  const reference = await nextReference(q);
  const { rows } = await q.query(
    `INSERT INTO maintenance_requests (reference, asset_id, department_id, reported_by, reported_at, problem, condition_at_report,
       priority, requires_approval, operation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [reference, row.id, row.owning_department_id, m.userId, m.eventTime, m.problem, m.conditionAtReport ?? row.condition, m.priority, dept.maintenance_requires_approval, m.operationId],
  );
  const id = rows[0].id as string;
  await q.query(`INSERT INTO maintenance_status_history (request_id, from_status, to_status, changed_by) VALUES ($1, NULL, 'submitted', $2)`, [id, m.userId]);
  await audit(q, {
    actorId: m.userId, action: 'maintenance.create', entityType: 'maintenance_request', entityId: id, departmentId: row.owning_department_id,
    after: { reference, assetId: row.id, problem: m.problem, priority: m.priority, requiresApproval: dept.maintenance_requires_approval }, ip,
  });
  return id;
}

// ---------------- reading ----------------

const REQUEST_SELECT = `
  SELECT m.*, a.institutional_id, a.name AS asset_name, a.condition AS asset_condition, d.name AS department_name,
         rb.full_name AS reported_by_name, ab.full_name AS approved_by_name, cb.full_name AS completed_by_name,
         ccb.full_name AS condition_confirmed_by_name
    FROM maintenance_requests m
    JOIN assets a ON a.id = m.asset_id
    JOIN departments d ON d.id = m.department_id
    JOIN users rb ON rb.id = m.reported_by
    LEFT JOIN users ab ON ab.id = m.approved_by
    LEFT JOIN users cb ON cb.id = m.completed_by
    LEFT JOIN users ccb ON ccb.id = m.condition_confirmed_by`;

function toRequest(r: Record<string, any>, user: AuthUser) {
  const manage = can(user, 'maintenance.manage', r.department_id);
  const open = !CLOSED.includes(r.status);
  return {
    id: r.id,
    reference: r.reference,
    asset: { id: r.asset_id, institutionalId: r.institutional_id, name: r.asset_name, condition: r.asset_condition },
    department: { id: r.department_id, name: r.department_name },
    reportedBy: r.reported_by_name,
    reportedAt: r.reported_at,
    receivedAt: r.received_at,
    problem: r.problem,
    conditionAtReport: r.condition_at_report,
    priority: r.priority,
    status: r.status as Status,
    requiresApproval: r.requires_approval,
    approvedBy: r.approved_by_name,
    approvedAt: r.approved_at,
    provider: r.provider_type ? { type: r.provider_type, name: r.provider_name, contact: r.provider_contact } : null,
    workPerformed: r.work_performed,
    outcome: r.outcome,
    completedAt: r.completed_at,
    completedBy: r.completed_by_name,
    closingReason: r.closing_reason,
    resultingCondition: r.resulting_condition,
    conditionConfirmedBy: r.condition_confirmed_by_name,
    conditionConfirmedAt: r.condition_confirmed_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    can: {
      changeStatus: manage && open,
      nextStatuses: manage ? allowedNext(r) : [],
      approve: open && r.requires_approval && !r.approved_at && can(user, 'maintenance.approve', r.department_id) && r.reported_by !== user.id,
      complete: manage && WORKING.includes(r.status),
      confirmCondition: manage && r.status === 'completed' && !r.condition_confirmed_at,
      addCost: manage && can(user, 'assets.read_financial', r.department_id) && !['rejected', 'cancelled'].includes(r.status),
      attach: manage,
    },
  };
}

async function loadRequest(q: Queryable, id: string) {
  return (await q.query(`${REQUEST_SELECT} WHERE m.id = $1`, [id])).rows[0];
}

async function readableRequest(db: Db, req: FastifyRequest, id: string) {
  const row = await loadRequest(db, id);
  if (!row) throw notFound('Maintenance request');
  const user = await requirePermission(db, req, 'maintenance.read', row.department_id);
  return { user, row };
}

async function attachmentsFor(q: Queryable, ownerType: string, ownerIds: string[]) {
  if (!ownerIds.length) return [];
  const { rows } = await q.query(
    `SELECT t.id, t.owner_id, t.file_name, t.content_type, t.size_bytes, t.uploaded_at, u.full_name AS uploaded_by
       FROM attachments t JOIN users u ON u.id = t.uploaded_by
      WHERE t.owner_type = $1 AND t.owner_id = ANY($2::uuid[]) ORDER BY t.uploaded_at`,
    [ownerType, ownerIds],
  );
  return rows.map((r) => ({
    id: r.id,
    ownerId: r.owner_id,
    fileName: r.file_name,
    contentType: r.content_type,
    sizeBytes: r.size_bytes,
    uploadedAt: r.uploaded_at,
    uploadedBy: r.uploaded_by,
  }));
}

/** Totals per currency (amounts in different currencies are never added together). */
function totalsByCurrency(costs: Record<string, any>[]) {
  const sums = new Map<string, bigint>();
  for (const c of costs) {
    const [w, f = '00'] = c.amount.split('.');
    sums.set(c.currency, (sums.get(c.currency) ?? 0n) + BigInt(w) * 100n + BigInt(f.padEnd(2, '0').slice(0, 2)));
  }
  return [...sums.entries()].sort().map(([currency, cents]) => ({
    currency,
    amount: `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`,
  }));
}

// ---------------- routes ----------------

export function maintenanceRoutes(app: FastifyInstance, { db, store, config }: AppDeps) {
  // ----- condition and damage -----

  app.post('/assets/:id/condition', async (req, reply) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(
      z.strictObject({
        condition: z.enum(CONDITIONS),
        notes: z.string().trim().max(2000).optional(),
        damageDescription: z.string().trim().max(2000).optional(),
        eventTime: EventTime,
        requestMaintenance: z.strictObject({ problem: z.string().trim().min(5).max(2000), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal') }).optional(),
      }),
      req.body,
    );
    const operationId = operationIdFrom(req);
    const pre = await existingAsset(db, id);
    const user = await requirePermission(db, req, 'condition.record', pre.owning_department_id);
    if (body.requestMaintenance) await requirePermission(db, req, 'maintenance.manage', pre.owning_department_id);
    requireRegistered(pre);
    const isDamage = !!body.damageDescription;
    if (isDamage && body.damageDescription!.length < 5) throw fieldError('damageDescription', 'Describe the damage or fault (at least 5 characters).');
    if (!isDamage && body.condition === pre.condition) throw fieldError('condition', 'The condition is already recorded as this. Choose a different condition, or describe new damage.');
    const eventTime = eventTimeOrNow(body.eventTime);

    const result = await db.tx(async (q) => {
      if (operationId) {
        const prev = (await q.query('SELECT id, recorded_by, maintenance_request_id FROM condition_events WHERE operation_id = $1', [operationId])).rows[0];
        if (prev) {
          if (prev.recorded_by !== user.id) throw conflict('OPERATION_ID_REUSED', 'This operation id was already used for a different request.');
          return { status: 200, conditionEventId: prev.id as string, requestId: prev.maintenance_request_id as string | null };
        }
      }
      const row = await loadAssetRow(q, id, true);
      requireRegistered(row);
      let requestId: string | null = null;
      if (body.requestMaintenance) {
        // The request records the condition being reported now, not the one it had before.
        requestId = await createRequest(q, row, { userId: user.id, problem: body.requestMaintenance.problem, priority: body.requestMaintenance.priority, eventTime, operationId: null, conditionAtReport: body.condition }, req.ip);
      }
      const ev = await recordCondition(q, row, {
        userId: user.id, eventTime, condition: body.condition, source: isDamage ? 'damage_report' : 'condition_update',
        damage: body.damageDescription, notes: body.notes, requestId, operationId,
      });
      return { status: 201, conditionEventId: ev.id, requestId };
    });
    return reply.status(result.status).send({
      conditionEventId: result.conditionEventId,
      maintenanceRequestId: result.requestId,
      asset: toAsset(await loadAssetRow(db, id), user),
    });
  });

  app.get('/assets/:id/condition-history', async (req) => {
    const { id } = parse(IdParam, req.params);
    await readableAsset(db, req, id);
    const { rows } = await db.query(
      `SELECT c.id, c.event_time, c.received_at, c.previous_condition, c.new_condition, c.source, c.damage_description, c.notes,
              c.maintenance_request_id, m.reference AS maintenance_reference, u.full_name AS recorded_by
         FROM condition_events c JOIN users u ON u.id = c.recorded_by
         LEFT JOIN maintenance_requests m ON m.id = c.maintenance_request_id
        WHERE c.asset_id = $1 ORDER BY c.event_time DESC LIMIT 200`,
      [id],
    );
    const files = await attachmentsFor(db, 'condition_event', rows.map((r) => r.id));
    return {
      items: rows.map((r) => ({
        id: r.id,
        eventTime: r.event_time,
        receivedAt: r.received_at,
        previousCondition: r.previous_condition,
        newCondition: r.new_condition,
        source: r.source,
        damageDescription: r.damage_description,
        notes: r.notes,
        recordedBy: r.recorded_by,
        maintenance: r.maintenance_request_id ? { id: r.maintenance_request_id, reference: r.maintenance_reference } : null,
        attachments: files.filter((f) => f.ownerId === r.id),
      })),
    };
  });

  // ----- maintenance requests -----

  app.post('/maintenance', async (req, reply) => {
    const body = parse(
      z.strictObject({
        assetId: z.uuid(),
        problem: z.string().trim().min(5, 'Describe the problem (at least 5 characters).').max(2000),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
        eventTime: EventTime,
      }),
      req.body,
    );
    const operationId = operationIdFrom(req);
    const pre = await existingAsset(db, body.assetId);
    const user = await requirePermission(db, req, 'maintenance.manage', pre.owning_department_id);
    requireRegistered(pre);
    const eventTime = eventTimeOrNow(body.eventTime);
    const result = await db.tx(async (q) => {
      if (operationId) {
        const prev = (await q.query('SELECT id, reported_by FROM maintenance_requests WHERE operation_id = $1', [operationId])).rows[0];
        if (prev) {
          if (prev.reported_by !== user.id) throw conflict('OPERATION_ID_REUSED', 'This operation id was already used for a different request.');
          return { status: 200, id: prev.id as string };
        }
      }
      const row = await loadAssetRow(q, body.assetId, true);
      requireRegistered(row);
      const id = await createRequest(q, row, { userId: user.id, problem: body.problem, priority: body.priority, eventTime, operationId }, req.ip);
      return { status: 201, id };
    });
    return reply.status(result.status).send(toRequest(await loadRequest(db, result.id), user));
  });

  app.get('/maintenance', async (req) => {
    const user = await requirePermission(db, req, 'maintenance.read');
    const q = parse(
      z.object({
        open: z.enum(['true', 'false']).optional(),
        status: z.enum(MAINTENANCE_STATUSES).optional(),
        departmentId: z.uuid().optional(),
        assetId: z.uuid().optional(),
        page: z.coerce.number().int().optional(),
        pageSize: z.coerce.number().int().optional(),
      }),
      req.query,
    );
    const p = pageParams(q);
    const scope = departmentScope(user, 'maintenance.read');
    const { rows } = await db.query(
      `${REQUEST_SELECT.replace('SELECT m.*,', 'SELECT count(*) OVER()::int AS total, m.*,')}
        WHERE ($1::uuid[] IS NULL OR m.department_id = ANY($1::uuid[]))
          AND ($2::text IS NULL OR ($2 = 'true') = (m.status NOT IN ('completed','rejected','cancelled')))
          AND ($3::text IS NULL OR m.status = $3)
          AND ($4::uuid IS NULL OR m.department_id = $4)
          AND ($5::uuid IS NULL OR m.asset_id = $5)
        ORDER BY (m.status IN ('completed','rejected','cancelled')),
                 CASE m.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                 m.reported_at DESC
        LIMIT $6 OFFSET $7`,
      [scope === 'all' ? null : scope, q.open ?? null, q.status ?? null, q.departmentId ?? null, q.assetId ?? null, p.limit, p.offset],
    );
    return { page: p.page, pageSize: p.pageSize, total: rows[0]?.total ?? 0, items: rows.map((r) => toRequest(r, user)) };
  });

  app.get('/maintenance/:id', async (req) => {
    const { id } = parse(IdParam, req.params);
    const { user, row } = await readableRequest(db, req, id);
    const history = await db.query(
      `SELECT h.from_status, h.to_status, h.changed_at, h.note, u.full_name AS changed_by
         FROM maintenance_status_history h JOIN users u ON u.id = h.changed_by WHERE h.request_id = $1 ORDER BY h.changed_at, h.id`,
      [id],
    );
    const financial = can(user, 'assets.read_financial', row.department_id);
    const costs = financial
      ? (
          await db.query(
            `SELECT c.id, c.kind, c.description, c.amount::text AS amount, c.currency, c.invoice_ref, c.recorded_at, u.full_name AS recorded_by
               FROM maintenance_costs c JOIN users u ON u.id = c.recorded_by WHERE c.request_id = $1 ORDER BY c.recorded_at`,
            [id],
          )
        ).rows
      : null;
    return {
      ...toRequest(row, user),
      history: history.rows.map((h) => ({ from: h.from_status, to: h.to_status, at: h.changed_at, by: h.changed_by, note: h.note })),
      costs: costs?.map((c) => ({
        id: c.id, kind: c.kind, description: c.description, amount: c.amount, currency: c.currency, invoiceRef: c.invoice_ref, recordedAt: c.recorded_at, recordedBy: c.recorded_by,
      })) ?? null,
      costTotals: costs ? totalsByCurrency(costs) : null,
      attachments: [
        ...(await attachmentsFor(db, 'maintenance_request', [id])),
        // Photos from the damage report that opened this request, so whoever repairs it can see the damage.
        ...(await attachmentsFor(
          db,
          'condition_event',
          (await db.query(`SELECT id FROM condition_events WHERE maintenance_request_id = $1 AND source = 'damage_report'`, [id])).rows.map((r) => r.id),
        )),
      ],
    };
  });

  /** Loads the request, checks it has not changed since the client read it, and that the user may manage it. */
  async function lockedRequest(q: Queryable, id: string, version: number) {
    await q.query('SELECT 1 FROM maintenance_requests WHERE id = $1 FOR UPDATE', [id]);
    const row = await loadRequest(q, id);
    if (!row) throw notFound('Maintenance request');
    if (row.version !== version) {
      throw conflict('VERSION_CONFLICT', 'This request was updated by someone else. Reload to see the latest status.', { currentVersion: row.version });
    }
    return row;
  }

  app.post('/maintenance/:id/status', async (req) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(
      z.strictObject({
        to: z.enum(MAINTENANCE_STATUSES),
        version: z.number().int().min(1),
        note: z.string().trim().max(2000).optional(),
        provider: z
          .strictObject({ type: z.enum(['internal', 'external']), name: z.string().trim().min(2).max(200), contact: z.string().trim().max(200).optional() })
          .optional(),
      }),
      req.body,
    );
    const pre = await loadRequest(db, id);
    if (!pre) throw notFound('Maintenance request');
    const user = await requirePermission(db, req, body.to === 'approved' ? 'maintenance.approve' : 'maintenance.manage', pre.department_id);
    if (body.to === 'completed') throw conflict('USE_COMPLETE', 'Complete a request with its outcome and the work performed.');
    if ((body.to === 'rejected' || body.to === 'cancelled') && (body.note ?? '').length < 3) {
      throw fieldError('note', `Give a reason for ${body.to === 'rejected' ? 'rejecting' : 'cancelling'} the request.`);
    }
    if (body.to === 'approved' && pre.reported_by === user.id) {
      throw new AppError(403, 'SELF_APPROVAL', 'Someone other than the person who reported it must approve this request.');
    }
    if (body.to === 'awaiting_external' && !body.provider && !pre.provider_type) {
      throw fieldError('provider', 'Name the external service provider.');
    }
    return db.tx(async (q) => {
      const row = await lockedRequest(q, id, body.version);
      if (!allowedNext(row).includes(body.to)) {
        throw conflict('INVALID_TRANSITION', `A request that is "${row.status.replace('_', ' ')}" cannot move to "${body.to.replace('_', ' ')}".`, {
          allowed: allowedNext(row),
        });
      }
      await q.query(
        `UPDATE maintenance_requests SET status = $2, version = version + 1, updated_at = now(),
                approved_by = CASE WHEN $2 = 'approved' THEN $3::uuid ELSE approved_by END,
                approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END,
                closing_reason = CASE WHEN $2 IN ('rejected','cancelled') THEN $4 ELSE closing_reason END,
                provider_type = coalesce($5, provider_type), provider_name = coalesce($6, provider_name), provider_contact = coalesce($7, provider_contact)
          WHERE id = $1`,
        [id, body.to, user.id, body.note ?? null, body.provider?.type ?? null, body.provider?.name ?? null, body.provider?.contact ?? null],
      );
      await q.query(`INSERT INTO maintenance_status_history (request_id, from_status, to_status, changed_by, note) VALUES ($1,$2,$3,$4,$5)`, [
        id, row.status, body.to, user.id, body.note ?? null,
      ]);
      await audit(q, {
        actorId: user.id, action: 'maintenance.status', entityType: 'maintenance_request', entityId: id, departmentId: row.department_id,
        before: { status: row.status }, after: { status: body.to }, context: { reference: row.reference, note: body.note ?? null, provider: body.provider ?? null }, ip: req.ip,
      });
      return toRequest(await loadRequest(q, id), user);
    });
  });

  app.post('/maintenance/:id/complete', async (req) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(
      z.strictObject({
        version: z.number().int().min(1),
        workPerformed: z.string().trim().min(5, 'Describe the work performed (at least 5 characters).').max(4000),
        outcome: z.enum(['repaired', 'partially_repaired', 'not_repairable', 'no_fault_found', 'replaced_part']),
        provider: z
          .strictObject({ type: z.enum(['internal', 'external']), name: z.string().trim().min(2).max(200), contact: z.string().trim().max(200).optional() })
          .optional(),
      }),
      req.body,
    );
    const pre = await loadRequest(db, id);
    if (!pre) throw notFound('Maintenance request');
    const user = await requirePermission(db, req, 'maintenance.manage', pre.department_id);
    return db.tx(async (q) => {
      const row = await lockedRequest(q, id, body.version);
      if (!WORKING.includes(row.status)) throw conflict('INVALID_TRANSITION', 'Only a request that is being worked on can be completed.');
      await q.query(
        `UPDATE maintenance_requests SET status = 'completed', work_performed = $2, outcome = $3, completed_at = now(), completed_by = $4,
                provider_type = coalesce($5, provider_type), provider_name = coalesce($6, provider_name), provider_contact = coalesce($7, provider_contact),
                version = version + 1, updated_at = now()
          WHERE id = $1`,
        [id, body.workPerformed, body.outcome, user.id, body.provider?.type ?? null, body.provider?.name ?? null, body.provider?.contact ?? null],
      );
      await q.query(`INSERT INTO maintenance_status_history (request_id, from_status, to_status, changed_by, note) VALUES ($1,$2,'completed',$3,$4)`, [
        id, row.status, user.id, `Outcome: ${body.outcome.replace('_', ' ')}`,
      ]);
      await audit(q, {
        actorId: user.id, action: 'maintenance.complete', entityType: 'maintenance_request', entityId: id, departmentId: row.department_id,
        before: { status: row.status }, after: { status: 'completed', outcome: body.outcome }, context: { reference: row.reference, workPerformed: body.workPerformed }, ip: req.ip,
      });
      return toRequest(await loadRequest(q, id), user);
    });
  });

  // Completion does not mean the asset is usable again: a person confirms the resulting condition.
  app.post('/maintenance/:id/confirm-condition', async (req) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(z.strictObject({ version: z.number().int().min(1), condition: z.enum(CONDITIONS), note: z.string().trim().max(1000).optional() }), req.body);
    const pre = await loadRequest(db, id);
    if (!pre) throw notFound('Maintenance request');
    const user = await requirePermission(db, req, 'maintenance.manage', pre.department_id);
    await requirePermission(db, req, 'condition.record', pre.department_id);
    return db.tx(async (q) => {
      const row = await lockedRequest(q, id, body.version);
      if (row.status !== 'completed') throw conflict('NOT_COMPLETED', 'Complete the request before confirming the asset’s condition.');
      if (row.condition_confirmed_at) throw conflict('ALREADY_CONFIRMED', 'The resulting condition has already been confirmed.');
      const asset = await loadAssetRow(q, row.asset_id, true);
      await recordCondition(q, asset, {
        userId: user.id, eventTime: new Date(), condition: body.condition, source: 'maintenance_confirmation', notes: body.note ?? null, requestId: id,
      });
      await q.query(
        `UPDATE maintenance_requests SET resulting_condition = $2, condition_confirmed_by = $3, condition_confirmed_at = now(), version = version + 1, updated_at = now()
          WHERE id = $1`,
        [id, body.condition, user.id],
      );
      await audit(q, {
        actorId: user.id, action: 'maintenance.confirm_condition', entityType: 'maintenance_request', entityId: id, departmentId: row.department_id,
        after: { resultingCondition: body.condition }, context: { reference: row.reference, note: body.note ?? null }, ip: req.ip,
      });
      return toRequest(await loadRequest(q, id), user);
    });
  });

  app.post('/maintenance/:id/costs', async (req, reply) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(
      z.strictObject({
        kind: z.enum(['parts', 'labour', 'external_service', 'other']),
        description: z.string().trim().min(2).max(300),
        amount: z.string().transform((v, ctx) => {
          const m = parseMoney(v);
          if (m === null || /^0+(\.0+)?$/.test(m)) {
            ctx.addIssue({ code: 'custom', message: 'Enter an amount greater than zero, like 120.00.' });
            return z.NEVER;
          }
          return m;
        }),
        currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code such as PGK (kina).'),
        invoiceRef: z.string().trim().max(100).optional(),
      }),
      req.body,
    );
    const pre = await loadRequest(db, id);
    if (!pre) throw notFound('Maintenance request');
    const user = await requirePermission(db, req, 'maintenance.manage', pre.department_id);
    await requirePermission(db, req, 'assets.read_financial', pre.department_id);
    if (pre.status === 'rejected' || pre.status === 'cancelled') throw conflict('CLOSED', 'Costs cannot be added to a rejected or cancelled request.');
    return db.tx(async (q) => {
      const { rows } = await q.query(
        `INSERT INTO maintenance_costs (request_id, kind, description, amount, currency, invoice_ref, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [id, body.kind, body.description, body.amount, body.currency, body.invoiceRef ?? null, user.id],
      );
      await audit(q, {
        actorId: user.id, action: 'maintenance.cost_add', entityType: 'maintenance_request', entityId: id, departmentId: pre.department_id,
        after: { kind: body.kind, description: body.description, amount: body.amount, currency: body.currency }, context: { reference: pre.reference }, ip: req.ip,
      });
      return reply.status(201).send({ id: rows[0].id });
    });
  });

  // ----- attachments (photos and documents) -----

  async function upload(req: FastifyRequest, owner: { type: 'maintenance_request' | 'condition_event'; id: string; assetId: string; departmentId: string }, user: AuthUser) {
    const part = await req.file({ limits: { fileSize: config.maxUploadBytes, files: 1 } });
    if (!part) throw fieldError('file', 'Choose a file to upload.');
    let data: Buffer;
    try {
      data = await part.toBuffer();
    } catch {
      throw new AppError(413, 'FILE_TOO_LARGE', `Files must be ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB or smaller.`);
    }
    if (part.file.truncated) throw new AppError(413, 'FILE_TOO_LARGE', `Files must be ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB or smaller.`);
    const type = sniffFileType(data);
    if (!type) throw new AppError(415, 'UNSUPPORTED_FILE', 'Only photos (JPEG, PNG, WebP) and PDF documents can be attached.');
    const hash = sha256Hex(data);
    // Optional integrity check: the client may send the SHA-256 of what it meant to upload.
    const claimed = req.headers['x-content-sha256'];
    if (typeof claimed === 'string' && claimed.toLowerCase() !== hash) {
      throw new AppError(400, 'CHECKSUM_MISMATCH', 'The file was damaged during upload. Please try again.');
    }
    // A retried upload with the same operation id returns the first result instead of storing the file twice.
    const out = await db.tx((q) => once(q, operationIdFrom(req), user.id, `attachment.upload:${owner.id}`, async () => {
      const key = await store.put(data, type.extension);
      const { rows } = await q.query(
        `INSERT INTO attachments (owner_type, owner_id, asset_id, department_id, file_name, content_type, size_bytes, sha256, storage_key, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, uploaded_at`,
        [owner.type, owner.id, owner.assetId, owner.departmentId, cleanFileName(part.filename, type.extension), type.contentType, data.length, hash, key, user.id],
      );
      await audit(q, {
        actorId: user.id, action: 'attachment.upload', entityType: owner.type, entityId: owner.id, departmentId: owner.departmentId,
        context: { attachmentId: rows[0].id, contentType: type.contentType, sizeBytes: data.length, sha256: hash },
      });
      return { status: 201, body: { id: rows[0].id as string, contentType: type.contentType, sizeBytes: data.length, sha256: hash } };
    }));
    return out.body;
  }

  app.post('/maintenance/:id/attachments', async (req, reply) => {
    const { id } = parse(IdParam, req.params);
    const row = await loadRequest(db, id);
    if (!row) throw notFound('Maintenance request');
    const user = await requirePermission(db, req, 'maintenance.manage', row.department_id);
    return reply.status(201).send(await upload(req, { type: 'maintenance_request', id, assetId: row.asset_id, departmentId: row.department_id }, user));
  });

  app.post('/condition-events/:id/attachments', async (req, reply) => {
    const { id } = parse(IdParam, req.params);
    const ev = (await db.query('SELECT id, asset_id, department_id, recorded_by FROM condition_events WHERE id = $1', [id])).rows[0];
    if (!ev) throw notFound('Condition record');
    const user = await requirePermission(db, req, 'condition.record', ev.department_id);
    return reply.status(201).send(await upload(req, { type: 'condition_event', id, assetId: ev.asset_id, departmentId: ev.department_id }, user));
  });

  // Files are only ever served after checking the viewer may see the asset's department.
  app.get('/attachments/:id', async (req, reply) => {
    const { id } = parse(IdParam, req.params);
    const t = (await db.query('SELECT * FROM attachments WHERE id = $1', [id])).rows[0];
    if (!t) throw notFound('Attachment');
    await requirePermission(db, req, t.owner_type === 'maintenance_request' ? 'maintenance.read' : 'assets.read', t.department_id);
    reply
      .header('Content-Type', t.content_type)
      .header('Content-Length', String(t.size_bytes))
      .header('Content-Disposition', `${t.content_type === 'application/pdf' ? 'attachment' : 'inline'}; filename="${t.file_name}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
      .header('Cache-Control', 'private, max-age=300');
    return reply.send(store.open(t.storage_key));
  });
}
