// Asset registration, management, QR label printing records and label-attachment confirmation.
// Registration flow:  create (validated, ID assigned) → awaiting_label → print label (any number of times)
//                     → confirm the attached label by scanning/typing its code → registered.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { pageParams, parse, requirePermission, requireUser, type AppDeps, type AuthUser } from '../app.ts';
import { audit } from '../audit.ts';
import { once, operationIdFrom } from '../idempotency.ts';
import { can, departmentScope } from '../authz.ts';
import type { Db, Queryable } from '../db.ts';
import { AppError, conflict, notFound } from '../errors.ts';
import { getSetting } from '../settings.ts';
import {
  ACQUISITION_METHODS,
  CONDITIONS,
  COST_STATUSES,
  REGISTRATION_STATUSES,
  USAGE_STATUSES,
  formatInstitutionalId,
  isValidDate,
  isZeroMoney,
  parseMoney,
  parseScannedCode,
  qrPayloadFor,
  todayIn,
} from '../../../shared/asset-codes.ts';

// ---------- input validation ----------

const optionalText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .optional()
    .transform((v) => (v === '' ? null : v));

const DateString = z.string().trim().refine(isValidDate, 'Use a real date in YYYY-MM-DD format.');

const Money = z.string().transform((v, ctx) => {
  const m = parseMoney(v);
  if (m === null) {
    ctx.addIssue({ code: 'custom', message: 'Enter an amount like 1250.00 (digits, up to 2 decimal places).' });
    return z.NEVER;
  }
  return m;
});

const FIELDS = {
  name: z.string().trim().min(2, 'Enter a name (at least 2 characters).').max(200),
  description: optionalText(2000),
  categoryId: z.uuid('Choose a category.'),
  manufacturer: optionalText(200),
  model: optionalText(200),
  // Optional since migration 008: no longer asked for on the form; kept for older records and API clients.
  serialNumber: optionalText(100),
  manufacturerBarcode: optionalText(64).refine((v) => v == null || /^[0-9A-Za-z.\-]+$/.test(v), 'Barcode may contain letters, digits, "-" and "." only.'),
  departmentId: z.uuid('Choose a department.'),
  locationId: z.uuid('Choose a location.'),
  acquisitionDate: DateString,
  acquisitionMethod: z.enum(ACQUISITION_METHODS),
  costStatus: z.enum(COST_STATUSES),
  acquisitionCost: Money.nullable().optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code such as PGK (kina).'),
  costExceptionReason: optionalText(500),
  supplier: optionalText(200),
  purchaseOrderRef: optionalText(100),
  warrantyExpiry: DateString.nullable().optional(),
  notes: optionalText(2000),
  condition: z.enum(CONDITIONS),
  // Staff member responsible for the asset (custodian). Free text: they may not have an account.
  assignedTo: optionalText(200).refine((v) => v == null || v.length >= 2, 'Enter at least 2 characters, or leave empty.'),
  usageStatus: z.enum(USAGE_STATUSES).default('in_use'),
};

const CreateBody = z.strictObject({
  ...FIELDS,
  confirmNotDuplicate: z.boolean().optional(),
  // Offline registration: an ID this user reserved earlier (it may already be printed on the label).
  institutionalId: z.string().trim().max(40).optional(),
});

const UpdateBody = z.strictObject({
  ...Object.fromEntries(
    Object.entries(FIELDS).map(([k, v]) => [k, k === 'usageStatus' ? z.enum(USAGE_STATUSES).optional() : (v as z.ZodType).optional()]),
  ),
  version: z.number().int().min(1),
  confirmNotDuplicate: z.boolean().optional(),
  // Offline edits: the values the device saw for the fields it changes. Other changes to the asset in the
  // meantime (e.g. the same person's own relocation) are then not mistaken for a conflict.
  baseValues: z.record(z.string(), z.unknown()).optional(),
}) as unknown as z.ZodType<Partial<AssetFields> & { version: number; confirmNotDuplicate?: boolean; baseValues?: Record<string, unknown> }>;

type AssetFields = {
  name: string;
  description: string | null | undefined;
  categoryId: string;
  manufacturer: string | null | undefined;
  model: string | null | undefined;
  serialNumber: string | null | undefined;
  manufacturerBarcode: string | null | undefined;
  departmentId: string;
  locationId: string;
  acquisitionDate: string;
  acquisitionMethod: (typeof ACQUISITION_METHODS)[number];
  costStatus: (typeof COST_STATUSES)[number];
  acquisitionCost: string | null | undefined;
  currency: string;
  costExceptionReason: string | null | undefined;
  supplier: string | null | undefined;
  purchaseOrderRef: string | null | undefined;
  warrantyExpiry: string | null | undefined;
  notes: string | null | undefined;
  condition: (typeof CONDITIONS)[number];
  assignedTo: string | null | undefined;
  usageStatus: (typeof USAGE_STATUSES)[number];
};

export const FINANCIAL_FIELDS = ['acquisitionCost', 'currency', 'costStatus', 'costExceptionReason', 'supplier', 'purchaseOrderRef'] as const;

/** Fields that, once an asset is registered, change only through their own workflows (relocation, condition history). */
const WORKFLOW_FIELDS = ['departmentId', 'locationId', 'condition'] as const;

type Issue = { path: string; message: string };

/** Business rules that involve several fields. Applied to the full record on create and on every edit. */
function ruleIssues(a: AssetFields, ctx: { today: string; allowUnknownCost: boolean }): Issue[] {
  const issues: Issue[] = [];
  if (a.acquisitionDate > ctx.today) issues.push({ path: 'acquisitionDate', message: 'Acquisition date cannot be in the future.' });
  if (a.warrantyExpiry && a.warrantyExpiry < a.acquisitionDate) {
    issues.push({ path: 'warrantyExpiry', message: 'Warranty expiry cannot be before the acquisition date.' });
  }
  const cost = a.acquisitionCost ?? null;
  switch (a.costStatus) {
    case 'recorded':
      if (cost === null) issues.push({ path: 'acquisitionCost', message: 'Enter the acquisition cost.' });
      else if (isZeroMoney(cost)) issues.push({ path: 'acquisitionCost', message: 'A recorded cost must be more than zero. Use "Verified zero cost" for items that cost nothing.' });
      break;
    case 'verified_zero':
      if (cost !== null && !isZeroMoney(cost)) issues.push({ path: 'acquisitionCost', message: 'Verified zero cost must be 0.00.' });
      break;
    case 'unknown_exception':
      if (!ctx.allowUnknownCost) {
        issues.push({ path: 'costStatus', message: 'Institution policy requires a recorded cost for every asset.' });
      }
      if (cost !== null) issues.push({ path: 'acquisitionCost', message: 'Leave the cost empty when it is unknown.' });
      if ((a.costExceptionReason ?? '').trim().length < 5) {
        issues.push({ path: 'costExceptionReason', message: 'Explain why the cost is unknown (at least 5 characters).' });
      }
      break;
  }
  return issues;
}

function throwIssues(issues: Issue[]) {
  if (issues.length) throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', issues);
}

// ---------- reading ----------

const ASSET_SELECT = `
  SELECT a.id, a.institutional_id, a.qr_payload, a.name, a.description, a.category_id, c.name AS category_name,
         a.manufacturer, a.model, a.serial_number, a.manufacturer_barcode,
         a.owning_department_id, d.name AS department_name, d.code AS department_code,
         d.faculty_id, fac.name AS faculty_name, a.assigned_to, a.usage_status,
         a.location_id, l.building, l.room,
         a.acquisition_date::text AS acquisition_date, a.acquisition_method, a.acquisition_cost::text AS acquisition_cost,
         a.currency, a.cost_status, a.cost_exception_reason, a.supplier, a.purchase_order_ref,
         a.warranty_expiry::text AS warranty_expiry, a.notes, a.condition, a.registration_status,
         a.registered_at, ru.full_name AS registered_by_name, a.version,
         a.created_at, cu.full_name AS created_by_name, a.updated_at,
         a.archived_at, au.full_name AS archived_by_name, a.archive_reason,
         (SELECT count(*)::int FROM label_print_events p WHERE p.asset_id = a.id) AS print_count,
         (SELECT max(p.printed_at) FROM label_print_events p WHERE p.asset_id = a.id) AS last_printed_at,
         av.verification_status, av.due_date::text AS due_date, av.overdue_days, av.interval_days, av.due_window_days,
         a.last_verified_at, lvu.full_name AS last_verified_by_name, a.last_verified_location_id,
         lvl.building AS last_verified_building, lvl.room AS last_verified_room,
         a.missing_status, a.missing_reported_at, mru.full_name AS missing_reported_by_name, a.missing_reason,
         a.missing_confirmed_at, mcu.full_name AS missing_confirmed_by_name,
         (SELECT count(*)::int FROM asset_flags f WHERE f.asset_id = a.id AND f.status = 'open') AS open_flags,
         (SELECT count(*)::int FROM maintenance_requests mr WHERE mr.asset_id = a.id
             AND mr.status NOT IN ('completed','rejected','cancelled')) AS open_maintenance,
         a.review_status, lr.note AS review_note, lr.fields AS review_fields, lr.created_at AS review_at,
         lr.action AS review_action, lru.full_name AS review_by
    FROM assets a
    JOIN asset_categories c ON c.id = a.category_id
    JOIN departments d ON d.id = a.owning_department_id
    LEFT JOIN faculties fac ON fac.id = d.faculty_id
    JOIN locations l ON l.id = a.location_id
    JOIN users cu ON cu.id = a.created_by
    JOIN asset_verification av ON av.asset_id = a.id
    LEFT JOIN users ru ON ru.id = a.registered_by
    LEFT JOIN users au ON au.id = a.archived_by
    LEFT JOIN users lvu ON lvu.id = a.last_verified_by
    LEFT JOIN locations lvl ON lvl.id = a.last_verified_location_id
    LEFT JOIN users mru ON mru.id = a.missing_reported_by
    LEFT JOIN users mcu ON mcu.id = a.missing_confirmed_by
    LEFT JOIN LATERAL (SELECT r.* FROM asset_reviews r WHERE r.asset_id = a.id ORDER BY r.created_at DESC LIMIT 1) lr ON true
    LEFT JOIN users lru ON lru.id = lr.actor_id`;

function rowToFields(r: Record<string, any>): AssetFields {
  return {
    name: r.name,
    description: r.description,
    categoryId: r.category_id,
    manufacturer: r.manufacturer,
    model: r.model,
    serialNumber: r.serial_number,
    manufacturerBarcode: r.manufacturer_barcode,
    departmentId: r.owning_department_id,
    locationId: r.location_id,
    acquisitionDate: r.acquisition_date,
    acquisitionMethod: r.acquisition_method,
    costStatus: r.cost_status,
    acquisitionCost: r.acquisition_cost,
    currency: r.currency,
    costExceptionReason: r.cost_exception_reason,
    supplier: r.supplier,
    purchaseOrderRef: r.purchase_order_ref,
    warrantyExpiry: r.warranty_expiry,
    notes: r.notes,
    condition: r.condition,
    assignedTo: r.assigned_to,
    usageStatus: r.usage_status,
  };
}

export function toAsset(r: Record<string, any>, user: AuthUser) {
  const showFinancial = can(user, 'assets.read_financial', r.owning_department_id);
  return {
    id: r.id,
    institutionalId: r.institutional_id,
    qrPayload: r.qr_payload,
    name: r.name,
    description: r.description,
    category: { id: r.category_id, name: r.category_name },
    manufacturer: r.manufacturer,
    model: r.model,
    serialNumber: r.serial_number,
    manufacturerBarcode: r.manufacturer_barcode,
    department: { id: r.owning_department_id, name: r.department_name, code: r.department_code },
    // From the owning school; null = a central administrative unit.
    faculty: r.faculty_id ? { id: r.faculty_id, name: r.faculty_name } : null,
    location: { id: r.location_id, building: r.building, room: r.room },
    assignedTo: r.assigned_to,
    usageStatus: r.usage_status,
    acquisitionDate: r.acquisition_date,
    acquisitionMethod: r.acquisition_method,
    financial: showFinancial
      ? {
          acquisitionCost: r.acquisition_cost,
          currency: r.currency,
          costStatus: r.cost_status,
          costExceptionReason: r.cost_exception_reason,
          supplier: r.supplier,
          purchaseOrderRef: r.purchase_order_ref,
        }
      : null,
    warrantyExpiry: r.warranty_expiry,
    notes: r.notes,
    condition: r.condition,
    registrationStatus: r.registration_status,
    registeredAt: r.registered_at,
    registeredBy: r.registered_by_name,
    labelPrintCount: r.print_count,
    lastPrintedAt: r.last_printed_at,
    version: r.version,
    createdAt: r.created_at,
    createdBy: r.created_by_name,
    updatedAt: r.updated_at,
    archived: r.archived_at ? { at: r.archived_at, by: r.archived_by_name, reason: r.archive_reason } : null,
    verification: {
      status: r.verification_status as 'not_applicable' | 'not_yet_verified' | 'verified' | 'due' | 'overdue',
      dueDate: r.due_date,
      overdueDays: r.overdue_days,
      intervalDays: r.interval_days,
      dueWindowDays: r.due_window_days,
      lastVerifiedAt: r.last_verified_at,
      lastVerifiedBy: r.last_verified_by_name,
      lastVerifiedLocation: r.last_verified_location_id
        ? { id: r.last_verified_location_id, building: r.last_verified_building, room: r.last_verified_room }
        : null,
    },
    missing: {
      status: r.missing_status as 'none' | 'reported_missing' | 'confirmed_missing',
      reportedAt: r.missing_reported_at,
      reportedBy: r.missing_reported_by_name,
      reason: r.missing_reason,
      confirmedAt: r.missing_confirmed_at,
      confirmedBy: r.missing_confirmed_by_name,
    },
    openFlags: r.open_flags,
    openMaintenance: r.open_maintenance,
    // Post-registration review (separate from registration status; never blocks registration).
    review: {
      status: r.review_status as 'not_reviewed' | 'approved' | 'returned_for_correction' | 'corrected_awaiting_rereview',
      last: r.review_action
        ? { action: r.review_action as 'approved' | 'returned' | 'corrections_submitted', note: r.review_note, fields: r.review_fields ?? [], by: r.review_by, at: r.review_at }
        : null,
    },
    can: {
      edit: !r.archived_at && can(user, 'assets.edit', r.owning_department_id),
      review:
        !r.archived_at && r.registration_status === 'registered' && ['not_reviewed', 'corrected_awaiting_rereview'].includes(r.review_status) &&
        can(user, 'assets.review', r.owning_department_id),
      submitCorrections: !r.archived_at && r.review_status === 'returned_for_correction' && can(user, 'assets.edit', r.owning_department_id),
      printLabel: !r.archived_at && can(user, 'labels.print', r.owning_department_id),
      confirmLabel: !r.archived_at && r.registration_status === 'awaiting_label' && can(user, 'assets.register', r.owning_department_id),
      archive:
        !r.archived_at &&
        (r.registration_status === 'registered'
          ? can(user, 'assets.archive_registered', r.owning_department_id)
          : can(user, 'assets.archive', r.owning_department_id)),
      restore: !!r.archived_at && can(user, 'assets.restore', r.owning_department_id),
      verify: !r.archived_at && r.registration_status === 'registered' && can(user, 'verification.record', r.owning_department_id),
      move: !r.archived_at && r.registration_status === 'registered' && can(user, 'movement.record', r.owning_department_id),
      reportMissing:
        !r.archived_at && r.registration_status === 'registered' && r.missing_status === 'none' && can(user, 'missing.report', r.owning_department_id),
      confirmMissing: !r.archived_at && r.missing_status === 'reported_missing' && can(user, 'missing.confirm', r.owning_department_id),
      clearMissing: !r.archived_at && r.missing_status !== 'none' && can(user, 'missing.confirm', r.owning_department_id),
      recordCondition: !r.archived_at && r.registration_status === 'registered' && can(user, 'condition.record', r.owning_department_id),
      requestMaintenance: !r.archived_at && r.registration_status === 'registered' && can(user, 'maintenance.manage', r.owning_department_id),
    },
  };
}

export async function loadAssetRow(q: Queryable, id: string, lock = false) {
  if (lock) await q.query('SELECT 1 FROM assets WHERE id = $1 FOR UPDATE', [id]);
  const { rows } = await q.query(`${ASSET_SELECT} WHERE a.id = $1`, [id]);
  return rows[0];
}

/**
 * Re-reads the asset inside a transaction with a row lock, and refuses if it changed after the
 * permission check that ran before the transaction. (Permission checks run outside transactions so a
 * denial is audited independently of any rolled-back work.)
 */
async function lockUnchanged(q: Queryable, id: string, checked: Record<string, any>) {
  const row = await loadAssetRow(q, id, true);
  if (!row) throw notFound('Asset');
  if (row.version !== checked.version) {
    throw conflict('VERSION_CONFLICT', 'This asset was changed by someone else a moment ago. Reload and try again.', { currentVersion: row.version });
  }
  return row;
}

export async function existingAsset(db: Db, id: string) {
  const row = await loadAssetRow(db, id);
  if (!row) throw notFound('Asset');
  return row;
}

/** Loads an asset the user is allowed to see, or throws 404/403. */
export async function readableAsset(db: Db, req: FastifyRequest, id: string) {
  const user = requireUser(req);
  const row = await loadAssetRow(db, id);
  if (!row) throw notFound('Asset');
  await requirePermission(db, req, 'assets.read', row.owning_department_id);
  return { user, row };
}

// ---------- duplicates ----------

/** `name` is null when the match is in a department the user may not read: the ID and department are
 *  enough to resolve the duplicate with that department without exposing its records. */
type DuplicateMatch = { id: string; institutionalId: string; name: string | null; department: string; reason: string };

/**
 * Potential duplicates: same serial number (and same or unknown manufacturer) on a non-archived asset.
 * A shared manufacturer barcode is normal for identical models and is reported only as information.
 * Minimal fields are returned so a match in another department can be explained without exposing details.
 */
async function findDuplicates(
  q: Queryable,
  user: AuthUser,
  a: { serialNumber?: string | null; manufacturer?: string | null; manufacturerBarcode?: string | null },
  excludeId: string | null,
) {
  // Without a serial number there is nothing that identifies one physical item (a barcode is shared by a model).
  const { rows } = !a.serialNumber ? { rows: [] as Record<string, any>[] } : await q.query(
    `SELECT a.id, a.institutional_id, a.name, a.owning_department_id, d.name AS department
       FROM assets a JOIN departments d ON d.id = a.owning_department_id
      WHERE a.archived_at IS NULL
        AND lower(a.serial_number) = lower($1)
        AND ($2::uuid IS NULL OR a.id <> $2::uuid)
        AND ($3::text IS NULL OR a.manufacturer IS NULL OR lower(a.manufacturer) = lower($3::text))
      ORDER BY a.created_at LIMIT 10`,
    [a.serialNumber, excludeId, a.manufacturer ?? null],
  );
  const matches: DuplicateMatch[] = rows.map((r) => ({
    id: r.id,
    institutionalId: r.institutional_id,
    name: can(user, 'assets.read', r.owning_department_id) ? r.name : null,
    department: r.department,
    reason: 'Same serial number' + (a.manufacturer ? ' and manufacturer' : ''),
  }));
  let sameBarcodeCount = 0;
  if (a.manufacturerBarcode) {
    const b = await q.query(
      `SELECT count(*)::int AS n FROM assets WHERE manufacturer_barcode = $1 AND archived_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
      [a.manufacturerBarcode, excludeId],
    );
    sameBarcodeCount = b.rows[0].n;
  }
  return { matches, sameBarcodeCount };
}

// ---------- shared checks ----------

async function checkReferences(q: Queryable, a: Pick<AssetFields, 'departmentId' | 'locationId' | 'categoryId'>) {
  const issues: Issue[] = [];
  const d = await q.query('SELECT 1 FROM departments WHERE id = $1 AND is_active', [a.departmentId]);
  if (!d.rows[0]) issues.push({ path: 'departmentId', message: 'Choose an active department.' });
  const l = await q.query('SELECT department_id, is_active FROM locations WHERE id = $1', [a.locationId]);
  if (!l.rows[0] || !l.rows[0].is_active) issues.push({ path: 'locationId', message: 'Choose an active location.' });
  else if (l.rows[0].department_id !== a.departmentId) {
    issues.push({ path: 'locationId', message: 'This location belongs to a different department.' });
  }
  const c = await q.query('SELECT is_active FROM asset_categories WHERE id = $1', [a.categoryId]);
  if (!c.rows[0]?.is_active) issues.push({ path: 'categoryId', message: 'Choose an active category.' });
  throwIssues(issues);
}

async function ruleContext(q: Queryable) {
  const tz = await getSetting(q, 'institution_time_zone');
  return { today: todayIn(tz), allowUnknownCost: await getSetting(q, 'allow_unknown_cost') };
}

/** Allocates the next institutional ID for the year. The counter row update is atomic, so concurrent
 *  registrations always receive different numbers; the UNIQUE constraint is a second safeguard. */
async function allocateInstitutionalId(q: Queryable, year: number): Promise<string> {
  const prefix = await getSetting(q, 'asset_id_prefix');
  const { rows } = await q.query(
    `INSERT INTO asset_id_counters (year, last_value) VALUES ($1, 1)
     ON CONFLICT (year) DO UPDATE SET last_value = asset_id_counters.last_value + 1
     RETURNING last_value`,
    [year],
  );
  return formatInstitutionalId(prefix, year, rows[0].last_value);
}

function costValue(a: AssetFields) {
  if (a.costStatus === 'verified_zero') return '0.00';
  if (a.costStatus === 'unknown_exception') return null;
  return a.acquisitionCost ?? null;
}

/** For users who may not see financial details, remove those fields from audit before/after values. */
function stripFinancial(v: unknown) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) if (!(FINANCIAL_FIELDS as readonly string[]).includes(k)) out[k] = val;
  return out;
}

const IdParam = z.object({ id: z.uuid() });

// ---------- routes ----------

export function assetRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get('/assets', async (req) => {
    const user = await requirePermission(db, req, 'assets.read');
    const q = parse(
      z.object({
        q: z.string().trim().max(100).optional(),
        departmentId: z.uuid().optional(),
        // A faculty id, or 'central' for central administrative units (no faculty).
        facultyId: z.union([z.uuid(), z.literal('central')]).optional(),
        categoryId: z.uuid().optional(),
        locationId: z.uuid().optional(),
        condition: z.enum(CONDITIONS).optional(),
        status: z.enum(REGISTRATION_STATUSES).optional(),
        usageStatus: z.enum(USAGE_STATUSES).optional(),
        archived: z.enum(['exclude', 'only', 'include']).default('exclude'),
        verification: z.enum(['not_yet_verified', 'verified', 'due', 'overdue', 'due_or_overdue']).optional(),
        missing: z.enum(['reported_missing', 'confirmed_missing', 'any']).optional(),
        review: z.enum(['not_reviewed', 'approved', 'returned_for_correction', 'corrected_awaiting_rereview', 'needs_review']).optional(),
        sort: z.enum(['newest', 'oldest', 'name', 'id', 'most_overdue']).default('newest'),
        page: z.coerce.number().int().optional(),
        pageSize: z.coerce.number().int().optional(),
      }),
      req.query,
    );
    const p = pageParams(q);
    const scope = departmentScope(user, 'assets.read');
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => '\\' + c)}%` : null;
    const order = {
      newest: 'a.created_at DESC',
      oldest: 'a.created_at ASC',
      name: 'lower(a.name), a.created_at',
      id: 'a.institutional_id',
      most_overdue: 'av.due_date ASC NULLS LAST, a.institutional_id',
    }[q.sort];
    // Filter and page on the bare asset rows first (the verification view only when a filter or sort needs it),
    // then load full details for just this page. Counting and paging over the full detail query was too slow
    // at 100,000 assets (docs/testing.md, Phase 7).
    const needsVerification = !!q.verification || q.sort === 'most_overdue';
    const where = `
        WHERE ($1::uuid[] IS NULL OR a.owning_department_id = ANY($1::uuid[]))
          AND ($2::text IS NULL OR a.name ILIKE $2 OR a.institutional_id ILIKE $2 OR a.serial_number ILIKE $2
               OR a.manufacturer ILIKE $2 OR a.model ILIKE $2 OR a.manufacturer_barcode ILIKE $2 OR a.assigned_to ILIKE $2)
          AND ($3::uuid IS NULL OR a.owning_department_id = $3)
          AND ($4::uuid IS NULL OR a.category_id = $4)
          AND ($5::uuid IS NULL OR a.location_id = $5)
          AND ($6::text IS NULL OR a.condition = $6)
          AND ($7::text IS NULL OR a.registration_status = $7)
          AND ($8 = 'include' OR ($8 = 'exclude' AND a.archived_at IS NULL) OR ($8 = 'only' AND a.archived_at IS NOT NULL))
          AND ($9::text IS NULL OR ${needsVerification ? `av.verification_status = $9 OR ($9 = 'due_or_overdue' AND av.verification_status IN ('due', 'overdue'))` : 'true'})
          AND ($10::text IS NULL OR a.missing_status = $10 OR ($10 = 'any' AND a.missing_status <> 'none'))
          AND ($11::text IS NULL OR (a.registration_status = 'registered' AND (a.review_status = $11
               OR ($11 = 'needs_review' AND a.review_status IN ('not_reviewed', 'corrected_awaiting_rereview')))))
          AND ($12::text IS NULL OR a.owning_department_id IN (SELECT fd.id FROM departments fd
               WHERE ($12 = 'central' AND fd.faculty_id IS NULL) OR fd.faculty_id::text = $12))
          AND ($13::text IS NULL OR a.usage_status = $13)`;
    const from = `FROM assets a ${needsVerification ? 'JOIN asset_verification av ON av.asset_id = a.id' : ''}`;
    const params = [
      scope === 'all' ? null : scope,
      like,
      q.departmentId ?? null,
      q.categoryId ?? null,
      q.locationId ?? null,
      q.condition ?? null,
      q.status ?? null,
      q.archived,
      q.verification ?? null,
      q.missing ?? null,
      q.review ?? null,
      q.facultyId ?? null,
      q.usageStatus ?? null,
    ];
    const total = Number((await db.query(`SELECT count(*) AS n ${from} ${where}`, params)).rows[0].n);
    const ids = (await db.query(`SELECT a.id ${from} ${where} ORDER BY ${order} LIMIT $14 OFFSET $15`, [...params, p.limit, p.offset])).rows.map((r) => r.id as string);
    const byId = new Map(
      ids.length ? (await db.query(`${ASSET_SELECT} WHERE a.id = ANY($1::uuid[])`, [ids])).rows.map((r) => [r.id as string, r]) : [],
    );
    const rows = ids.map((id) => byId.get(id)).filter((r): r is Record<string, any> => !!r);
    return { page: p.page, pageSize: p.pageSize, total, items: rows.map((r) => toAsset(r, user)) };
  });

  // Resolve a scanned QR payload or typed asset ID. Scanning grants nothing: normal permissions apply.
  app.get('/assets/lookup', async (req) => {
    const user = requireUser(req);
    const { code } = parse(z.object({ code: z.string().max(200) }), req.query);
    const id = parseScannedCode(code);
    if (!id) throw new AppError(400, 'NOT_AN_ASSET_CODE', 'This is not a University asset code.');
    const { rows } = await db.query(`${ASSET_SELECT} WHERE a.institutional_id = $1`, [id]);
    if (!rows[0]) throw notFound(`Asset ${id}`);
    if (!can(user, 'assets.read', rows[0].owning_department_id)) {
      await requirePermission(db, req, 'assets.read', rows[0].owning_department_id);
    }
    return toAsset(rows[0], user);
  });

  app.post('/assets/check-duplicates', async (req) => {
    const user = await requirePermission(db, req, 'assets.register');
    const body = parse(
      z.strictObject({
        serialNumber: optionalText(100),
        manufacturer: optionalText(200),
        manufacturerBarcode: optionalText(64),
        excludeAssetId: z.uuid().optional(),
      }),
      req.body,
    );
    return findDuplicates(db, user, body, body.excludeAssetId ?? null);
  });

  app.get('/assets/:id', async (req) => {
    const { id } = parse(IdParam, req.params);
    const { user, row } = await readableAsset(db, req, id);
    return toAsset(row, user);
  });

  app.post('/assets', async (req, reply) => {
    const body = parse(CreateBody, req.body) as AssetFields & { confirmNotDuplicate?: boolean; institutionalId?: string };
    const user = await requirePermission(db, req, 'assets.register', body.departmentId);
    const opHeader = req.headers['x-operation-id'];
    const operationId = typeof opHeader === 'string' ? parse(z.uuid('X-Operation-Id must be a UUID.'), opHeader) : null;

    const result = await db.tx(async (q) => {
      // Idempotency: claim the operation id before doing any work. If the same id was already used, return
      // the stored result. A simultaneous duplicate blocks on the primary key until the first request
      // commits (then sees its result) or rolls back (then proceeds normally) — never a second asset.
      if (operationId) {
        const claimed = await q.query(
          `INSERT INTO api_operations (operation_id, user_id, operation, status_code, response)
           VALUES ($1, $2, 'asset.create', 0, '{}'::jsonb) ON CONFLICT (operation_id) DO NOTHING RETURNING operation_id`,
          [operationId, user.id],
        );
        if (!claimed.rows[0]) {
          const prev = (await q.query('SELECT user_id, operation, status_code, response FROM api_operations WHERE operation_id = $1', [operationId])).rows[0];
          if (!prev || prev.user_id !== user.id || prev.operation !== 'asset.create') {
            throw conflict('OPERATION_ID_REUSED', 'This operation id was already used for a different request.');
          }
          return { status: prev.status_code as number, body: prev.response, replayed: true };
        }
      }

      const ctx = await ruleContext(q);
      throwIssues(ruleIssues(body, ctx));
      await checkReferences(q, body);

      const dups = await findDuplicates(q, user, body, null);
      if (dups.matches.length && !body.confirmNotDuplicate) {
        throw conflict('POSSIBLE_DUPLICATE', 'An asset with the same serial number is already registered. Check it is a different physical item.', dups);
      }

      let institutionalId: string;
      if (body.institutionalId) {
        // Accepted only if this user reserved it and it is unused. An expired reservation is still honoured:
        // the label may have been printed and attached before it expired.
        const r = await q.query(
          `SELECT 1 FROM asset_id_reservations WHERE institutional_id = $1 AND user_id = $2 AND used_by_asset_id IS NULL FOR UPDATE`,
          [body.institutionalId, user.id],
        );
        if (!r.rows[0]) {
          throw conflict('RESERVED_ID_INVALID', `Asset ID ${body.institutionalId} was not reserved by you or has already been used.`);
        }
        institutionalId = body.institutionalId;
      } else {
        institutionalId = await allocateInstitutionalId(q, Number(ctx.today.slice(0, 4)));
      }
      const { rows } = await q.query(
        `INSERT INTO assets (institutional_id, qr_payload, name, description, category_id, manufacturer, model, serial_number,
            manufacturer_barcode, owning_department_id, location_id, acquisition_date, acquisition_method, acquisition_cost,
            currency, cost_status, cost_exception_reason, supplier, purchase_order_ref, warranty_expiry, notes, condition,
            registration_status, created_by, updated_by, assigned_to, usage_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'awaiting_label',$23,$23,$24,$25)
         RETURNING id`,
        [
          institutionalId,
          qrPayloadFor(institutionalId),
          body.name,
          body.description ?? null,
          body.categoryId,
          body.manufacturer ?? null,
          body.model ?? null,
          body.serialNumber ?? null,
          body.manufacturerBarcode ?? null,
          body.departmentId,
          body.locationId,
          body.acquisitionDate,
          body.acquisitionMethod,
          costValue(body),
          body.currency,
          body.costStatus,
          body.costStatus === 'unknown_exception' ? body.costExceptionReason : null,
          body.supplier ?? null,
          body.purchaseOrderRef ?? null,
          body.warrantyExpiry ?? null,
          body.notes ?? null,
          body.condition,
          user.id,
          body.assignedTo ?? null,
          body.usageStatus ?? 'in_use',
        ],
      );
      const assetId = rows[0].id as string;
      if (body.institutionalId) {
        await q.query(`UPDATE asset_id_reservations SET used_by_asset_id = $2, used_at = now() WHERE institutional_id = $1`, [institutionalId, assetId]);
      }
      const { confirmNotDuplicate: _ignored, institutionalId: _reserved, ...fields } = body;
      await audit(q, {
        actorId: user.id,
        action: 'asset.create',
        entityType: 'asset',
        entityId: assetId,
        departmentId: body.departmentId,
        after: { institutionalId, ...fields, acquisitionCost: costValue(body), registrationStatus: 'awaiting_label' },
        context: {
          ...(dups.matches.length ? { duplicateConfirmed: dups.matches.map((m) => m.institutionalId) } : {}),
          ...(body.costStatus === 'unknown_exception' ? { costExceptionReason: body.costExceptionReason } : {}),
          ...(operationId ? { operationId } : {}),
          ...(body.institutionalId ? { reservedId: true } : {}),
        },
        ip: req.ip,
      });
      const created = toAsset(await loadAssetRow(q, assetId), user);
      if (operationId) {
        await q.query(`UPDATE api_operations SET status_code = 201, response = $2::jsonb WHERE operation_id = $1`, [
          operationId,
          JSON.stringify(created),
        ]);
      }
      return { status: 201, body: created, replayed: false };
    });
    if (result.replayed) reply.header('Idempotent-Replay', 'true');
    return reply.status(result.status).send(result.body);
  });

  app.patch('/assets/:id', async (req, reply) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(UpdateBody, req.body);
    const operationId = operationIdFrom(req);
    const pre = await existingAsset(db, id);
    const user = await requirePermission(db, req, 'assets.edit', pre.owning_department_id);
    if (pre.archived_at) throw conflict('ARCHIVED', 'Archived assets cannot be edited. An administrator can restore it first.');
    // An offline edit may be based on an older version. It is a conflict only if a field it changes was changed by
    // someone else since: compare the values the device saw with the server's current values, field by field.
    // Empty text and "no value" count as the same; amounts compare as numbers ("40" equals "40.00").
    const norm = (k: string, v: unknown) => (v === undefined || v === '' ? null : k === 'acquisitionCost' && typeof v === 'string' ? Number(v) : v);
    const same = (k: string, x: unknown, y: unknown) => JSON.stringify(norm(k, x)) === JSON.stringify(norm(k, y));
    const touched = Object.entries(body).filter(([k, v]) => v !== undefined && !['version', 'confirmNotDuplicate', 'baseValues'].includes(k)).map(([k]) => k);
    const preFields = rowToFields(pre) as Record<string, unknown>;
    const untouchedSince =
      !!operationId && body.version < pre.version && !!body.baseValues &&
      touched.every((k) => Object.prototype.hasOwnProperty.call(body.baseValues, k) && same(k, body.baseValues![k], preFields[k]));
    if (operationId && body.version < pre.version && !untouchedSince) {
      // An edit made offline (or a retry of one): if it was already applied, `once` returns the stored reply.
      // Otherwise someone changed the asset in the meantime, so the edit is kept for review, never applied blindly.
      const out = await db.tx((q) =>
        once(q, operationId, user.id, 'asset.update', async () => {
          const current = rowToFields(pre);
          const { version: _v, confirmNotDuplicate: _c, baseValues: _b, ...changes } = body;
          const proposed: Record<string, unknown> = {};
          const serverValues: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(changes)) {
            if (v === undefined) continue;
            proposed[k] = v;
            serverValues[k] = (current as Record<string, unknown>)[k] ?? null;
          }
          const { rows } = await q.query(
            `INSERT INTO sync_conflicts (operation_id, entity_type, entity_id, department_id, submitted_by, base_version, server_version, proposed, server_values)
             VALUES ($1, 'asset', $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb) RETURNING id`,
            [operationId, id, pre.owning_department_id, user.id, body.version, pre.version, JSON.stringify(proposed), JSON.stringify(serverValues)],
          );
          await audit(q, {
            actorId: user.id, action: 'sync.conflict', entityType: 'asset', entityId: id, departmentId: pre.owning_department_id,
            context: { conflictId: rows[0].id, operationId, baseVersion: body.version, serverVersion: pre.version, fields: Object.keys(proposed) }, ip: req.ip,
          });
          return {
            status: 409,
            body: {
              error: {
                code: 'SYNC_CONFLICT',
                message: 'This asset was changed by someone else after your edit was made. Your edit has been kept for review and nothing was overwritten.',
                details: { conflictId: rows[0].id, currentVersion: pre.version },
              },
            },
          };
        }),
      );
      return reply.status(out.status).send(out.body);
    }
    if (body.version !== pre.version && !untouchedSince) {
      throw conflict('VERSION_CONFLICT', 'Someone else changed this asset after you opened it. Reload to see the latest version, then reapply your changes.', {
        currentVersion: pre.version,
      });
    }
    const current = rowToFields(pre);
    const { version: _v, confirmNotDuplicate, baseValues: _base, ...changes } = body;
    const changedKeys = (Object.keys(changes) as (keyof AssetFields)[]).filter(
      (k) => changes[k] !== undefined && (changes[k] ?? null) !== (current[k] ?? null),
    );
    if (changedKeys.length === 0) return reply.send(toAsset(pre, user));

    if (pre.registration_status === 'registered') {
      const blocked = changedKeys.filter((k) => (WORKFLOW_FIELDS as readonly string[]).includes(k));
      if (blocked.length) {
        throw conflict(
          'USE_WORKFLOW',
          'For a registered asset, use "Relocate" to change its department or location, and "Update condition" to change its condition, so their history is kept.',
          { fields: blocked },
        );
      }
    }
    if (changedKeys.some((k) => (FINANCIAL_FIELDS as readonly string[]).includes(k))) {
      await requirePermission(db, req, 'assets.read_financial', pre.owning_department_id);
    }
    const next: AssetFields = { ...current };
    for (const k of changedKeys) (next as Record<string, unknown>)[k] = changes[k] ?? null;
    if (next.costStatus === 'verified_zero') next.acquisitionCost = '0.00';
    if (next.costStatus === 'unknown_exception') next.acquisitionCost = null;
    if (next.costStatus !== 'unknown_exception') next.costExceptionReason = null;
    if (next.departmentId !== current.departmentId) {
      await requirePermission(db, req, 'assets.register', next.departmentId);
    }

    const out = await db.tx((q) => once(q, operationId, user.id, 'asset.update', async () => {
      const row = await lockUnchanged(q, id, pre);
      throwIssues(ruleIssues(next, await ruleContext(q)));
      if (changedKeys.some((k) => k === 'departmentId' || k === 'locationId' || k === 'categoryId')) await checkReferences(q, next);
      if (changedKeys.some((k) => k === 'serialNumber' || k === 'manufacturer')) {
        const dups = await findDuplicates(q, user, next, id);
        if (dups.matches.length && !confirmNotDuplicate) {
          throw conflict('POSSIBLE_DUPLICATE', 'Another asset already has this serial number. Check it is a different physical item.', dups);
        }
      }

      await q.query(
        `UPDATE assets SET name=$2, description=$3, category_id=$4, manufacturer=$5, model=$6, serial_number=$7,
                manufacturer_barcode=$8, owning_department_id=$9, location_id=$10, acquisition_date=$11, acquisition_method=$12,
                acquisition_cost=$13, currency=$14, cost_status=$15, cost_exception_reason=$16, supplier=$17,
                purchase_order_ref=$18, warranty_expiry=$19, notes=$20, condition=$21,
                assigned_to=$23, usage_status=$24,
                version = version + 1, updated_by = $22, updated_at = now()
          WHERE id = $1`,
        [
          id, next.name, next.description ?? null, next.categoryId, next.manufacturer ?? null, next.model ?? null,
          next.serialNumber ?? null, next.manufacturerBarcode ?? null, next.departmentId, next.locationId, next.acquisitionDate,
          next.acquisitionMethod, next.acquisitionCost ?? null, next.currency, next.costStatus, next.costExceptionReason ?? null,
          next.supplier ?? null, next.purchaseOrderRef ?? null, next.warrantyExpiry ?? null, next.notes ?? null, next.condition,
          user.id, next.assignedTo ?? null, next.usageStatus,
        ],
      );
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const k of Object.keys(next) as (keyof AssetFields)[]) {
        if ((current[k] ?? null) !== (next[k] ?? null)) {
          before[k] = current[k] ?? null;
          after[k] = next[k] ?? null;
        }
      }
      await audit(q, {
        actorId: user.id,
        action: 'asset.update',
        entityType: 'asset',
        entityId: id,
        departmentId: next.departmentId,
        before,
        after,
        context: {
          institutionalId: row.institutional_id,
          version: row.version + 1,
          ...(confirmNotDuplicate ? { duplicateConfirmed: true } : {}),
          ...(operationId ? { operationId } : {}),
        },
        ip: req.ip,
      });
      return { status: 200, body: toAsset(await loadAssetRow(q, id), user) };
    }));
    return reply.status(out.status).send(out.body);
  });

  // Records a label print. The label itself is produced on the device; this never creates or changes an asset's identity.
  app.post('/assets/:id/label-prints', async (req, reply) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(
      z.strictObject({
        copies: z.number().int().min(1).max(50).default(1),
        layout: z.enum(['sheet', 'single']),
        reason: z.string().trim().max(300).optional(),
      }),
      req.body,
    );
    const pre = await existingAsset(db, id);
    const user = await requirePermission(db, req, 'labels.print', pre.owning_department_id);
    const operationId = operationIdFrom(req);
    const out = await db.tx((q) => once(q, operationId, user.id, 'asset.label_print', async () => {
      const row = await lockUnchanged(q, id, pre);
      if (row.archived_at) throw conflict('ARCHIVED', 'Archived assets cannot have labels printed.');
      const isReprint = row.print_count > 0;
      if (isReprint && (body.reason ?? '').length < 3) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are missing or invalid.', [
          { path: 'reason', message: 'Say why the label is being reprinted (e.g. damaged, lost, misprinted).' },
        ]);
      }
      await q.query(
        `INSERT INTO label_print_events (asset_id, printed_by, copies, layout, is_reprint, reason) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, user.id, body.copies, body.layout, isReprint, body.reason ?? null],
      );
      await audit(q, {
        actorId: user.id,
        action: isReprint ? 'asset.label_reprint' : 'asset.label_print',
        entityType: 'asset',
        entityId: id,
        departmentId: row.owning_department_id,
        context: { institutionalId: row.institutional_id, copies: body.copies, layout: body.layout, reason: body.reason ?? null },
        ip: req.ip,
      });
      return {
        status: 201,
        body: { institutionalId: row.institutional_id, qrPayload: row.qr_payload, isReprint, printCount: row.print_count + 1 },
      };
    }));
    return reply.status(out.status).send(out.body);
  });

  // Completes registration: the label must have been printed, and the code read from the attached label must match.
  app.post('/assets/:id/confirm-label', async (req, reply) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(z.strictObject({ code: z.string().max(200), method: z.enum(['scan', 'manual']) }), req.body);
    const pre = await existingAsset(db, id);
    const user = await requirePermission(db, req, 'assets.register', pre.owning_department_id);
    const scanned = parseScannedCode(body.code);
    if (!scanned) {
      throw new AppError(400, 'NOT_AN_ASSET_CODE', 'That is not a University asset code. Scan the label you attached, or type the ID printed under the QR code.');
    }
    // The institutional ID never changes, so this check is safe outside the transaction, and the
    // failure record is committed on its own (it must survive even though the request fails).
    if (scanned !== pre.institutional_id) {
      await audit(db, {
        actorId: user.id,
        action: 'asset.label_mismatch',
        entityType: 'asset',
        entityId: id,
        departmentId: pre.owning_department_id,
        outcome: 'failure',
        context: { expected: pre.institutional_id, read: scanned, method: body.method },
        ip: req.ip,
      });
      throw new AppError(400, 'LABEL_MISMATCH', `The label you scanned is for ${scanned}, not ${pre.institutional_id}. Check the right label is on this asset.`, {
        expected: pre.institutional_id,
        read: scanned,
      });
    }
    const operationId = operationIdFrom(req);
    const out = await db.tx((q) => once(q, operationId, user.id, 'asset.confirm_label', async () => {
      const row = await lockUnchanged(q, id, pre);
      if (row.archived_at) throw conflict('ARCHIVED', 'This asset is archived.');
      if (row.registration_status === 'registered') throw conflict('ALREADY_REGISTERED', 'This asset is already registered.');
      if (row.registration_status !== 'awaiting_label') throw conflict('NOT_READY', 'This asset is not ready for label confirmation.');
      if (row.print_count === 0) throw conflict('LABEL_NOT_PRINTED', 'Print the QR label and attach it before confirming.');
      await q.query(
        `UPDATE assets SET registration_status = 'registered', registered_at = now(), registered_by = $2,
                version = version + 1, updated_by = $2, updated_at = now() WHERE id = $1`,
        [id, user.id],
      );
      await audit(q, {
        actorId: user.id,
        action: 'asset.register',
        entityType: 'asset',
        entityId: id,
        departmentId: row.owning_department_id,
        before: { registrationStatus: 'awaiting_label' },
        after: { registrationStatus: 'registered' },
        context: { institutionalId: row.institutional_id, method: body.method, ...(operationId ? { operationId } : {}) },
        ip: req.ip,
      });
      return { status: 200, body: toAsset(await loadAssetRow(q, id), user) };
    }));
    return reply.status(out.status).send(out.body);
  });

  // "Delete": archives the asset. Nothing is physically removed; the record and its history remain.
  app.post('/assets/:id/archive', async (req) => {
    const { id } = parse(IdParam, req.params);
    const { reason } = parse(z.strictObject({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(500) }), req.body);
    const pre = await existingAsset(db, id);
    const perm = pre.registration_status === 'registered' ? 'assets.archive_registered' : 'assets.archive';
    const user = await requirePermission(db, req, perm, pre.owning_department_id);
    return db.tx(async (q) => {
      const row = await lockUnchanged(q, id, pre);
      if (row.archived_at) throw conflict('ARCHIVED', 'This asset is already archived.');
      await q.query(
        `UPDATE assets SET archived_at = now(), archived_by = $2, archive_reason = $3, version = version + 1,
                updated_by = $2, updated_at = now() WHERE id = $1`,
        [id, user.id, reason],
      );
      await audit(q, {
        actorId: user.id,
        action: 'asset.archive',
        entityType: 'asset',
        entityId: id,
        departmentId: row.owning_department_id,
        before: { archived: false },
        after: { archived: true },
        context: { institutionalId: row.institutional_id, reason, registrationStatus: row.registration_status },
        ip: req.ip,
      });
      return toAsset(await loadAssetRow(q, id), user);
    });
  });

  app.post('/assets/:id/restore', async (req) => {
    const { id } = parse(IdParam, req.params);
    const { reason } = parse(z.strictObject({ reason: z.string().trim().min(3).max(500) }), req.body);
    const pre = await existingAsset(db, id);
    const user = await requirePermission(db, req, 'assets.restore', pre.owning_department_id);
    return db.tx(async (q) => {
      const row = await lockUnchanged(q, id, pre);
      if (!row.archived_at) throw conflict('NOT_ARCHIVED', 'This asset is not archived.');
      await q.query(
        `UPDATE assets SET archived_at = NULL, archived_by = NULL, archive_reason = NULL, version = version + 1,
                updated_by = $2, updated_at = now() WHERE id = $1`,
        [id, user.id],
      );
      await audit(q, {
        actorId: user.id,
        action: 'asset.restore',
        entityType: 'asset',
        entityId: id,
        departmentId: row.owning_department_id,
        before: { archived: true, archiveReason: row.archive_reason },
        after: { archived: false },
        context: { institutionalId: row.institutional_id, reason },
        ip: req.ip,
      });
      return toAsset(await loadAssetRow(q, id), user);
    });
  });

  app.get('/assets/:id/history', async (req) => {
    const { id } = parse(IdParam, req.params);
    const { user, row } = await readableAsset(db, req, id);
    const financial = can(user, 'assets.read_financial', row.owning_department_id);
    const { rows } = await db.query(
      `SELECT a.id, a.occurred_at, a.action, a.outcome, a.before_data, a.after_data, a.context, u.full_name AS actor_name
         FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.entity_type = 'asset' AND a.entity_id = $1
        ORDER BY a.occurred_at DESC, a.id DESC LIMIT 200`,
      [id],
    );
    const prints = await db.query(
      `SELECT p.printed_at, p.copies, p.layout, p.is_reprint, p.reason, u.full_name AS printed_by
         FROM label_print_events p JOIN users u ON u.id = p.printed_by WHERE p.asset_id = $1 ORDER BY p.printed_at DESC`,
      [id],
    );
    return {
      events: rows.map((r) => ({
        id: String(r.id),
        occurredAt: r.occurred_at,
        action: r.action,
        outcome: r.outcome,
        actor: r.actor_name,
        before: financial ? r.before_data : stripFinancial(r.before_data),
        after: financial ? r.after_data : stripFinancial(r.after_data),
        context: financial ? r.context : stripFinancial(r.context),
      })),
      labelPrints: prints.rows.map((p) => ({
        printedAt: p.printed_at,
        printedBy: p.printed_by,
        copies: p.copies,
        layout: p.layout,
        isReprint: p.is_reprint,
        reason: p.reason,
      })),
    };
  });
}
