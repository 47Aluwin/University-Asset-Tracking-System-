// Phase 5: dashboard figures and the four reports. Every query is limited to the departments the user may read,
// money is only ever totalled per currency, and financial columns are blanked where the user lacks financial access.
// The same report data feeds the on-screen preview, the PDF and the Excel export, so they always agree.
import { can, departmentScope, type Permission, type Principal } from './authz.ts';
import type { Queryable } from './db.ts';
import { AppError } from './errors.ts';
import { getSetting } from './settings.ts';
import { CONDITION_LABELS, COST_STATUS_LABELS, REGISTRATION_STATUS_LABELS, USAGE_STATUS_LABELS } from '../../shared/asset-codes.ts';
import {
  COST_KIND_LABELS,
  MAINTENANCE_STATUS_LABELS,
  MISSING_LABELS,
  OUTCOME_LABELS,
  PRIORITY_LABELS,
  VERIFICATION_LABELS,
} from '../../shared/status-labels.ts';

const label = (map: Record<string, string>, v: string | null | undefined) => (v == null ? null : (map[v] ?? v));
const OPEN = `('completed','rejected','cancelled')`; // statuses that are NOT open

/** Collects positional parameters while a query is assembled. */
class Params {
  readonly values: unknown[] = [];
  add(v: unknown) {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/** `column = ANY(scope)` for a permission, or `true` when the user may see every department. */
function scopeSql(p: Params, user: Principal, perm: Permission, column: string) {
  const s = departmentScope(user, perm);
  return s === 'all' ? 'true' : `${column} = ANY(${p.add(s)}::uuid[])`;
}

/** True if some department the user can see under `perm` is one whose money they may not see. */
function lacksFinancialSomewhere(user: Principal, perm: Permission) {
  const fin = departmentScope(user, 'assets.read_financial');
  if (fin === 'all') return false;
  const seen = departmentScope(user, perm);
  return seen === 'all' || seen.some((d) => !fin.includes(d));
}

/** `column` (a department id) belongs to the chosen faculty; 'central' = departments with no faculty. */
function facultySql(p: Params, facultyId: string | undefined, column: string) {
  if (!facultyId) return 'true';
  if (facultyId === 'central') return `${column} IN (SELECT fd.id FROM departments fd WHERE fd.faculty_id IS NULL)`;
  return `${column} IN (SELECT fd.id FROM departments fd WHERE fd.faculty_id = ${p.add(facultyId)}::uuid)`;
}

export const CENTRAL_UNIT = 'Central administration';

export type Filters = {
  departmentId?: string;
  facultyId?: string;
  categoryId?: string;
  condition?: string;
  from?: string;
  to?: string;
  status?: string;
  periodDays?: number;
};

// ---------------------------------------------------------------- dashboard

export async function dashboard(db: Queryable, user: Principal, f: Filters) {
  const tz = await getSetting(db, 'institution_time_zone');
  const periodDays = f.periodDays ?? 90;

  // Assets in scope (not archived) matching the dashboard filters.
  const assetWhere = (p: Params) =>
    [
      'a.archived_at IS NULL',
      scopeSql(p, user, 'dashboard.read', 'a.owning_department_id'),
      f.departmentId ? `a.owning_department_id = ${p.add(f.departmentId)}` : 'true',
      facultySql(p, f.facultyId, 'a.owning_department_id'),
      f.categoryId ? `a.category_id = ${p.add(f.categoryId)}` : 'true',
      f.condition ? `a.condition = ${p.add(f.condition)}` : 'true',
    ].join(' AND ');

  // 1. Total assets and value
  let p = new Params();
  const totals = (
    await db.query(
      `SELECT count(*)::int AS assets,
              count(*) FILTER (WHERE a.registration_status = 'registered')::int AS registered,
              count(*) FILTER (WHERE a.registration_status = 'awaiting_label')::int AS awaiting_label,
              count(*) FILTER (WHERE a.registration_status = 'draft')::int AS draft
         FROM assets a WHERE ${assetWhere(p)}`,
      p.values,
    )
  ).rows[0];
  p = new Params();
  const valueRows = (
    await db.query(
      `SELECT a.currency,
              coalesce(sum(a.acquisition_cost) FILTER (WHERE a.cost_status = 'recorded'), 0)::numeric(16,2)::text AS total,
              count(*) FILTER (WHERE a.cost_status = 'recorded')::int AS recorded,
              count(*) FILTER (WHERE a.cost_status = 'verified_zero')::int AS verified_zero,
              count(*) FILTER (WHERE a.cost_status = 'unknown_exception')::int AS unknown_cost
         FROM assets a
        WHERE ${assetWhere(p)} AND ${scopeSql(p, user, 'assets.read_financial', 'a.owning_department_id')}
        GROUP BY a.currency ORDER BY a.currency`,
      p.values,
    )
  ).rows;
  const valuedAssets = valueRows.reduce((n, r) => n + r.recorded + r.verified_zero + r.unknown_cost, 0);

  // 2. Verification: computed below from the department summary (one pass over the verification data).

  // 3. Condition and outstanding maintenance
  p = new Params();
  const condRows = (
    await db.query(`SELECT a.condition, count(*)::int AS n FROM assets a WHERE ${assetWhere(p)} GROUP BY a.condition`, p.values)
  ).rows;
  const byCondition = Object.fromEntries(Object.keys(CONDITION_LABELS).map((c) => [c, 0])) as Record<string, number>;
  for (const r of condRows) byCondition[r.condition] = r.n;

  const maintWhere = (p: Params) =>
    [
      scopeSql(p, user, 'maintenance.read', 'mr.department_id'),
      scopeSql(p, user, 'dashboard.read', 'mr.department_id'),
      f.departmentId ? `mr.department_id = ${p.add(f.departmentId)}` : 'true',
      facultySql(p, f.facultyId, 'mr.department_id'),
      f.categoryId ? `a.category_id = ${p.add(f.categoryId)}` : 'true',
      f.condition ? `a.condition = ${p.add(f.condition)}` : 'true',
    ].join(' AND ');
  const maintenanceVisible = can(user, 'maintenance.read');
  let maintenance: null | {
    open: number;
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
    awaitingConfirmation: number;
    damagedWithoutRequest: number;
    openCosts: { currency: string; total: string }[];
    openCostsRestricted: boolean;
  } = null;
  if (maintenanceVisible) {
    p = new Params();
    const rows = (
      await db.query(
        `SELECT mr.status, mr.priority, count(*)::int AS n
           FROM maintenance_requests mr JOIN assets a ON a.id = mr.asset_id
          WHERE mr.status NOT IN ${OPEN} AND ${maintWhere(p)}
          GROUP BY mr.status, mr.priority`,
        p.values,
      )
    ).rows;
    const byStatus: Record<string, number> = {};
    const byPriority: Record<string, number> = { urgent: 0, high: 0, normal: 0, low: 0 };
    let open = 0;
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n;
      byPriority[r.priority] += r.n;
      open += r.n;
    }
    p = new Params();
    const awaiting = (
      await db.query(
        `SELECT count(*)::int AS n FROM maintenance_requests mr JOIN assets a ON a.id = mr.asset_id
          WHERE mr.status = 'completed' AND mr.condition_confirmed_at IS NULL AND ${maintWhere(p)}`,
        p.values,
      )
    ).rows[0].n;
    p = new Params();
    const damagedWithoutRequest = (
      await db.query(
        `SELECT count(*)::int AS n FROM assets a
          WHERE ${assetWhere(p)} AND a.condition IN ('damaged','unusable')
            AND NOT EXISTS (SELECT 1 FROM maintenance_requests mr WHERE mr.asset_id = a.id AND mr.status NOT IN ${OPEN})`,
        p.values,
      )
    ).rows[0].n;
    p = new Params();
    const openCosts = (
      await db.query(
        `SELECT mc.currency, sum(mc.amount)::numeric(16,2)::text AS total
           FROM maintenance_costs mc JOIN maintenance_requests mr ON mr.id = mc.request_id JOIN assets a ON a.id = mr.asset_id
          WHERE mr.status NOT IN ${OPEN} AND ${maintWhere(p)} AND ${scopeSql(p, user, 'assets.read_financial', 'mr.department_id')}
          GROUP BY mc.currency ORDER BY mc.currency`,
        p.values,
      )
    ).rows;
    maintenance = {
      open,
      byStatus,
      byPriority,
      awaitingConfirmation: awaiting,
      damagedWithoutRequest,
      openCosts: openCosts.map((r) => ({ currency: String(r.currency), total: String(r.total) })),
      openCostsRestricted: lacksFinancialSomewhere(user, 'maintenance.read'),
    };
  }

  // 4. Department-by-department summary
  p = new Params();
  const assetJoin = [
    'a.owning_department_id = d.id',
    'a.archived_at IS NULL',
    f.categoryId ? `a.category_id = ${p.add(f.categoryId)}` : 'true',
    f.condition ? `a.condition = ${p.add(f.condition)}` : 'true',
  ].join(' AND ');
  const deptRows = (
    await db.query(
      `SELECT d.id, d.code, d.name, d.is_active, d.faculty_id, fac.name AS faculty_name, fac.sort_order AS faculty_order,
              ${Object.keys(CONDITION_LABELS).map((k) => `count(a.id) FILTER (WHERE a.condition = '${k}')::int AS c_${k}`).join(', ')},
              count(a.id)::int AS assets,
              count(a.id) FILTER (WHERE a.registration_status = 'registered')::int AS registered,
              count(a.id) FILTER (WHERE av.verification_status = 'verified')::int AS verified,
              count(a.id) FILTER (WHERE av.verification_status = 'not_yet_verified')::int AS not_yet_verified,
              count(a.id) FILTER (WHERE av.verification_status = 'due')::int AS due,
              count(a.id) FILTER (WHERE av.verification_status = 'overdue')::int AS overdue,
              count(a.id) FILTER (WHERE a.missing_status <> 'none')::int AS missing,
              count(a.id) FILTER (WHERE a.condition IN ('damaged','unusable'))::int AS damaged,
              count(a.id) FILTER (WHERE av.asset_id IS NOT NULL AND av.schedule_id IS NULL)::int AS no_schedule,
              count(a.id) FILTER (WHERE a.registration_status = 'registered' AND a.missing_status = 'reported_missing')::int AS reported_missing,
              count(a.id) FILTER (WHERE a.registration_status = 'registered' AND a.missing_status = 'confirmed_missing')::int AS confirmed_missing,
              count(a.id) FILTER (WHERE a.registration_status = 'registered'
                                    AND a.last_verified_at >= now() - make_interval(days => ${p.add(periodDays)}::int))::int AS verified_in_period
         FROM departments d
         LEFT JOIN faculties fac ON fac.id = d.faculty_id
         LEFT JOIN assets a ON ${assetJoin}
         LEFT JOIN asset_verification av ON av.asset_id = a.id AND a.registration_status = 'registered'
        WHERE ${scopeSql(p, user, 'dashboard.read', 'd.id')}
          AND ${f.departmentId ? `d.id = ${p.add(f.departmentId)}` : 'true'}
          AND ${facultySql(p, f.facultyId, 'd.id')}
        GROUP BY d.id, fac.id ORDER BY d.name`,
      p.values,
    )
  ).rows;
  // Verification totals = sum over the departments in scope (each registered asset is in exactly one department).
  const sum = (k: string) => deptRows.reduce((n, r) => n + Number(r[k]), 0);
  const v = {
    verified: sum('verified'),
    not_yet_verified: sum('not_yet_verified'),
    due: sum('due'),
    overdue: sum('overdue'),
    no_schedule: sum('no_schedule'),
    reported_missing: sum('reported_missing'),
    confirmed_missing: sum('confirmed_missing'),
    verified_in_period: sum('verified_in_period'),
  };
  p = new Params();
  const deptValues = (
    await db.query(
      `SELECT a.owning_department_id AS id, a.currency,
              coalesce(sum(a.acquisition_cost) FILTER (WHERE a.cost_status = 'recorded'), 0)::numeric(16,2)::text AS total
         FROM assets a
        WHERE ${assetWhere(p)} AND ${scopeSql(p, user, 'assets.read_financial', 'a.owning_department_id')}
        GROUP BY a.owning_department_id, a.currency ORDER BY a.currency`,
      p.values,
    )
  ).rows;
  let deptMaint: Record<string, number> = {};
  if (maintenanceVisible) {
    p = new Params();
    const rows = (
      await db.query(
        `SELECT mr.department_id AS id, count(*)::int AS n FROM maintenance_requests mr JOIN assets a ON a.id = mr.asset_id
          WHERE mr.status NOT IN ${OPEN} AND ${maintWhere(p)} GROUP BY mr.department_id`,
        p.values,
      )
    ).rows;
    deptMaint = Object.fromEntries(rows.map((r) => [r.id, r.n]));
  }
  const departments = deptRows.filter((r) => r.is_active || r.assets > 0).map((d) => ({
    id: d.id,
    code: d.code,
    name: d.name,
    faculty: d.faculty_id ? { id: d.faculty_id as string, name: d.faculty_name as string } : null,
    assets: d.assets,
    registered: d.registered,
    verified: d.verified,
    notYetVerified: d.not_yet_verified,
    due: d.due,
    overdue: d.overdue,
    missing: d.missing,
    damaged: d.damaged,
    openMaintenance: maintenanceVisible ? (deptMaint[d.id] ?? 0) : null,
    // null = the user may not see this department's money (e.g. a read-only grant)
    value: can(user, 'assets.read_financial', d.id)
      ? deptValues.filter((x) => x.id === d.id).map((x) => ({ currency: x.currency, total: x.total }))
      : null,
  }));

  // 4b. Faculty-by-faculty summary, added up from the departments above (each department is in at most one
  // faculty, so every asset is counted exactly once). Value totals stay per currency and include only
  // departments whose money the user may see; `valuePartial` says some were left out.
  type FacultyAgg = {
    id: string | null;
    name: string;
    order: number;
    departments: number;
    assets: number;
    registered: number;
    damaged: number;
    overdue: number;
    missing: number;
    byCondition: Record<string, number>;
    value: Map<string, bigint>;
    valuePartial: boolean;
  };
  const facultyMap = new Map<string, FacultyAgg>();
  const toCents = (s: string) => BigInt(s.replace('.', ''));
  const fromCents = (v: bigint) => `${v / 100n}.${(v % 100n).toString().padStart(2, '0')}`;
  for (const d of deptRows) {
    if (!(d.is_active || d.assets > 0)) continue;
    const key = d.faculty_id ?? 'central';
    let agg = facultyMap.get(key);
    if (!agg) {
      agg = {
        id: d.faculty_id ?? null,
        name: d.faculty_name ?? CENTRAL_UNIT,
        order: d.faculty_id ? Number(d.faculty_order) : Number.MAX_SAFE_INTEGER,
        departments: 0, assets: 0, registered: 0, damaged: 0, overdue: 0, missing: 0,
        byCondition: Object.fromEntries(Object.keys(CONDITION_LABELS).map((c) => [c, 0])),
        value: new Map(), valuePartial: false,
      };
      facultyMap.set(key, agg);
    }
    agg.departments += 1;
    agg.assets += d.assets;
    agg.registered += d.registered;
    agg.damaged += d.damaged;
    agg.overdue += d.overdue;
    agg.missing += d.missing;
    for (const c of Object.keys(CONDITION_LABELS)) agg.byCondition[c] += d[`c_${c}`];
    if (can(user, 'assets.read_financial', d.id)) {
      for (const x of deptValues.filter((v) => v.id === d.id)) agg.value.set(x.currency, (agg.value.get(x.currency) ?? 0n) + toCents(x.total));
    } else if (d.assets > 0) agg.valuePartial = true;
  }
  const faculties = [...facultyMap.values()]
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map((a) => ({
      id: a.id,
      name: a.name,
      departments: a.departments,
      assets: a.assets,
      registered: a.registered,
      damaged: a.damaged,
      overdue: a.overdue,
      missing: a.missing,
      byCondition: a.byCondition,
      value: [...a.value].sort(([x], [y]) => x.localeCompare(y)).map(([currency, total]) => ({ currency, total: fromCents(total) })),
      valuePartial: a.valuePartial,
    }));

  // 5. Pending staff access requests (administrators review them)
  let accessRequests: { restricted: true } | { restricted: false; pending: number; oldestAt: string | null };
  if (can(user, 'access_requests.review')) {
    p = new Params();
    const r = (
      await db.query(
        `SELECT count(*)::int AS n, min(created_at) AS oldest FROM access_requests ar
          WHERE ar.status = 'pending' AND ${f.departmentId ? `ar.department_id = ${p.add(f.departmentId)}` : 'true'}`,
        p.values,
      )
    ).rows[0];
    accessRequests = { restricted: false, pending: r.n, oldestAt: r.oldest };
  } else accessRequests = { restricted: true };

  return {
    generatedAt: new Date().toISOString(),
    timeZone: tz,
    filters: { ...f, periodDays },
    totals: {
      assets: totals.assets,
      registered: totals.registered,
      awaitingLabel: totals.awaiting_label,
      draft: totals.draft,
      value: valueRows.map((r) => ({
        currency: r.currency,
        total: r.total,
        recorded: r.recorded,
        verifiedZero: r.verified_zero,
        unknownCost: r.unknown_cost,
      })),
      // Assets counted above whose value the user may not see (they are left out of every money total).
      valueRestricted: totals.assets - valuedAssets,
    },
    verification: {
      registered: totals.registered,
      verified: v.verified,
      notYetVerified: v.not_yet_verified,
      due: v.due,
      overdue: v.overdue,
      noSchedule: v.no_schedule,
      reportedMissing: v.reported_missing,
      confirmedMissing: v.confirmed_missing,
      verifiedInPeriod: v.verified_in_period,
      periodDays,
    },
    condition: { byCondition, maintenance },
    faculties,
    departments,
    accessRequests,
  };
}

// ---------------------------------------------------------------- reports

export const REPORT_KINDS = ['asset-register', 'department-summary', 'verification', 'maintenance'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export type ColumnKind = 'text' | 'int' | 'money' | 'date' | 'datetime';
export type Column = { label: string; kind?: ColumnKind; width?: number };
export type Cell = string | number | null;
export type Table = { title: string; columns: Column[]; rows: Cell[][]; totalRows: number; emptyText?: string };
export type Report = {
  kind: ReportKind;
  title: string;
  generatedAt: string;
  generatedBy: string;
  timeZone: string;
  filters: [string, string][];
  notes: string[];
  tables: Table[];
};

export const REPORT_TITLES: Record<ReportKind, string> = {
  'asset-register': 'Complete asset register',
  'department-summary': 'Faculty and department inventory and asset value',
  verification: 'Verification and overdue assets',
  maintenance: 'Damaged assets, repairs and maintenance costs',
};

export type ReportOptions = {
  /** Rows to return per table. Previews ask for a few; exports for up to `maxRows`. */
  limit: number;
  /** Exports refuse (rather than silently cut) result sets larger than this. */
  maxRows: number;
  export: boolean;
};

const RESTRICTED = 'Restricted';

/** Formats a timestamp as "YYYY-MM-DD HH:mm" in the institution time zone. */
export function formatTimestamp(iso: string | Date | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

type Ctx = { db: Queryable; user: Principal & { fullName?: string }; f: Filters; o: ReportOptions; tz: string; names: Names };
type Names = {
  department: (id?: string) => Promise<string>;
  category: (id?: string) => Promise<string>;
  faculty: (id?: string) => Promise<string>;
};

/** Runs a row query with `count(*) OVER()` so the true total is known even when only a few rows are returned. */
async function rowsWithTotal(c: Ctx, sql: string, p: Params, what: string) {
  const limit = c.o.export ? c.o.maxRows + 1 : c.o.limit;
  const { rows } = await c.db.query(`${sql} LIMIT ${p.add(limit)}`, p.values);
  const total = rows.length ? Number(rows[0].__total) : 0;
  if (c.o.export && total > c.o.maxRows) {
    throw new AppError(
      422,
      'REPORT_TOO_LARGE',
      `This report would contain ${total.toLocaleString('en')} ${what}; exports are limited to ${c.o.maxRows.toLocaleString('en')}. Narrow the filters (for example by department or date) and try again.`,
    );
  }
  return { rows, total };
}

const dateRange = (p: Params, f: Filters, expr: string) =>
  [f.from ? `${expr} >= ${p.add(f.from)}::date` : 'true', f.to ? `${expr} <= ${p.add(f.to)}::date` : 'true'].join(' AND ');

const canMoney = (c: Ctx, dept: string) => can(c.user, 'assets.read_financial', dept);

function currencyTotalsTable(title: string, rows: { currency: string; total: string; n: number }[], countLabel: string): Table {
  return {
    title,
    columns: [{ label: 'Currency' }, { label: 'Total', kind: 'money' }, { label: countLabel, kind: 'int' }],
    rows: rows.map((r) => [r.currency, r.total, r.n]),
    totalRows: rows.length,
    emptyText: 'No amounts you are allowed to see.',
  };
}

async function filterLines(c: Ctx, dateLabel: string | null, statusLabel?: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  if (c.f.facultyId) out.push(['Faculty', c.f.facultyId === 'central' ? CENTRAL_UNIT : await c.names.faculty(c.f.facultyId)]);
  out.push([
    'School / department',
    c.f.departmentId ? await c.names.department(c.f.departmentId) : c.f.facultyId ? 'All in this faculty that you can access' : 'All departments you can access',
  ]);
  if (c.f.categoryId) out.push(['Category', await c.names.category(c.f.categoryId)]);
  if (c.f.condition) out.push(['Condition', label(CONDITION_LABELS, c.f.condition)!]);
  if (statusLabel) out.push(['Status', statusLabel]);
  if (dateLabel) out.push([dateLabel, c.f.from || c.f.to ? `${c.f.from ?? 'any'} to ${c.f.to ?? 'any'}` : 'Any date']);
  return out;
}

function commonNotes(c: Ctx): string[] {
  const notes = [
    `Times are shown in ${c.tz}.`,
    'Amounts are shown with their currency. Different currencies are never added together; there is no currency conversion.',
  ];
  if (lacksFinancialSomewhere(c.user, 'reports.generate')) notes.push(`"${RESTRICTED}" means you do not have financial access for that department; those amounts are left out of all totals.`);
  return notes;
}

/** Shared WHERE for asset-based reports. */
function assetFilter(c: Ctx, p: Params, alias = 'a') {
  return [
    `${alias}.archived_at IS NULL`,
    scopeSql(p, c.user, 'reports.generate', `${alias}.owning_department_id`),
    scopeSql(p, c.user, 'assets.read', `${alias}.owning_department_id`),
    c.f.departmentId ? `${alias}.owning_department_id = ${p.add(c.f.departmentId)}` : 'true',
    facultySql(p, c.f.facultyId, `${alias}.owning_department_id`),
    c.f.categoryId ? `${alias}.category_id = ${p.add(c.f.categoryId)}` : 'true',
    c.f.condition ? `${alias}.condition = ${p.add(c.f.condition)}` : 'true',
  ].join(' AND ');
}

// Report 1 ---------------------------------------------------------------
async function assetRegister(c: Ctx): Promise<Pick<Report, 'filters' | 'notes' | 'tables'>> {
  const p = new Params();
  const where = `${assetFilter(c, p)} AND ${dateRange(p, c.f, 'a.acquisition_date')}
    AND ${c.f.status ? `a.registration_status = ${p.add(c.f.status)}` : 'true'}`;
  const { rows, total } = await rowsWithTotal(
    c,
    `SELECT count(*) OVER() AS __total, a.institutional_id, a.qr_payload, a.manufacturer_barcode, a.serial_number, a.name, a.description,
            cat.name AS category, d.name AS department, a.owning_department_id, l.building, l.room, a.condition,
            a.acquisition_date::text AS acquisition_date, a.acquisition_cost::text AS cost, a.currency, a.cost_status,
            a.registration_status, a.missing_status, fac.name AS faculty, a.assigned_to, a.usage_status
       FROM assets a JOIN asset_categories cat ON cat.id = a.category_id JOIN departments d ON d.id = a.owning_department_id
       LEFT JOIN faculties fac ON fac.id = d.faculty_id
       JOIN locations l ON l.id = a.location_id
      WHERE ${where}
      ORDER BY a.institutional_id`,
    p,
    'assets',
  );
  const p2 = new Params();
  const totals = (
    await c.db.query(
      `SELECT a.currency, coalesce(sum(a.acquisition_cost) FILTER (WHERE a.cost_status = 'recorded'), 0)::numeric(16,2)::text AS total,
              count(*)::int AS n
         FROM assets a
        WHERE ${assetFilter(c, p2)} AND ${dateRange(p2, c.f, 'a.acquisition_date')}
          AND ${c.f.status ? `a.registration_status = ${p2.add(c.f.status)}` : 'true'}
          AND ${scopeSql(p2, c.user, 'assets.read_financial', 'a.owning_department_id')}
        GROUP BY a.currency ORDER BY a.currency`,
      p2.values,
    )
  ).rows;
  return {
    filters: await filterLines(c, 'Acquired', c.f.status ? label(REGISTRATION_STATUS_LABELS, c.f.status)! : undefined),
    notes: [
      ...commonNotes(c),
      'Archived records are not included. "Cost status" says whether a cost was recorded, verified as zero (for example a donation), or is an approved unknown-cost exception.',
    ],
    tables: [
      {
        title: 'Assets',
        columns: [
          { label: 'Asset ID', width: 1.3 },
          { label: 'QR reference', width: 1.5 },
          { label: 'Manufacturer barcode', width: 1.2 },
          { label: 'Serial number', width: 1.1 },
          { label: 'Name', width: 1.5 },
          { label: 'Description', width: 1.8 },
          { label: 'Category' },
          { label: 'Faculty', width: 1.3 },
          { label: 'School / department', width: 1.3 },
          { label: 'Building' },
          { label: 'Room', width: 0.7 },
          { label: 'Assigned to', width: 1.1 },
          { label: 'Condition', width: 0.8 },
          { label: 'Asset status', width: 0.8 },
          { label: 'Acquired', kind: 'date', width: 0.9 },
          { label: 'Acquisition cost', kind: 'money' },
          { label: 'Currency', width: 0.6 },
          { label: 'Cost status' },
          { label: 'Registration' },
          { label: 'Missing status' },
        ],
        rows: rows.map((r) => {
          const fin = canMoney(c, r.owning_department_id);
          return [
            r.institutional_id,
            r.qr_payload,
            r.manufacturer_barcode,
            r.serial_number,
            r.name,
            r.description,
            r.category,
            r.faculty ?? CENTRAL_UNIT,
            r.department,
            r.building,
            r.room,
            r.assigned_to,
            label(CONDITION_LABELS, r.condition),
            label(USAGE_STATUS_LABELS, r.usage_status),
            r.acquisition_date,
            fin ? r.cost : null,
            fin ? r.currency : RESTRICTED,
            fin ? label(COST_STATUS_LABELS, r.cost_status) : RESTRICTED,
            label(REGISTRATION_STATUS_LABELS, r.registration_status),
            label(MISSING_LABELS, r.missing_status),
          ];
        }),
        totalRows: total,
        emptyText: 'No assets match the selected filters.',
      },
      currencyTotalsTable('Totals by currency (recorded acquisition cost)', totals.map((r) => ({ currency: r.currency, total: r.total, n: r.n })), 'Assets'),
    ],
  };
}

// Report 2 ---------------------------------------------------------------
async function departmentSummary(c: Ctx): Promise<Pick<Report, 'filters' | 'notes' | 'tables'>> {
  const where = (p: Params) => `${assetFilter(c, p)} AND ${dateRange(p, c.f, 'a.acquisition_date')}`;
  const conditionCols = Object.keys(CONDITION_LABELS).map((k) => `count(*) FILTER (WHERE a.condition = '${k}')::int AS c_${k}`).join(', ');
  const FROM = `FROM assets a JOIN departments d ON d.id = a.owning_department_id LEFT JOIN faculties fac ON fac.id = d.faculty_id`;
  // Faculties in the university's order; central administrative units (no faculty) last.
  const FAC_ORDER = `coalesce(fac.sort_order, 2147483647), fac.name`;
  let p = new Params();
  const byFaculty = (
    await c.db.query(
      `SELECT fac.name AS faculty, count(DISTINCT d.id)::int AS departments, count(*)::int AS assets,
              count(*) FILTER (WHERE a.registration_status = 'registered')::int AS registered,
              count(*) FILTER (WHERE a.registration_status = 'awaiting_label')::int AS awaiting, ${conditionCols}
         ${FROM} WHERE ${where(p)} GROUP BY fac.id, fac.name, fac.sort_order ORDER BY ${FAC_ORDER}`,
      p.values,
    )
  ).rows;
  p = new Params();
  const byDept = (
    await c.db.query(
      `SELECT d.name, fac.name AS faculty, count(*)::int AS assets,
              count(*) FILTER (WHERE a.registration_status = 'registered')::int AS registered,
              count(*) FILTER (WHERE a.registration_status = 'awaiting_label')::int AS awaiting, ${conditionCols}
         ${FROM} WHERE ${where(p)} GROUP BY d.name, fac.id, fac.name, fac.sort_order ORDER BY ${FAC_ORDER}, d.name`,
      p.values,
    )
  ).rows;
  p = new Params();
  const byCat = (
    await c.db.query(
      `SELECT d.name AS department, cat.name AS category, count(*)::int AS n
         FROM assets a JOIN departments d ON d.id = a.owning_department_id JOIN asset_categories cat ON cat.id = a.category_id
        WHERE ${where(p)} GROUP BY d.name, cat.name ORDER BY d.name, cat.name`,
      p.values,
    )
  ).rows;
  p = new Params();
  const values = (
    await c.db.query(
      `SELECT d.name AS department, a.owning_department_id AS dept, fac.id AS faculty_id, fac.name AS faculty,
              coalesce(fac.sort_order, 2147483647) AS faculty_order, a.currency,
              coalesce(sum(a.acquisition_cost) FILTER (WHERE a.cost_status = 'recorded'), 0)::numeric(16,2)::text AS total,
              count(*) FILTER (WHERE a.cost_status = 'recorded')::int AS recorded,
              count(*) FILTER (WHERE a.cost_status = 'verified_zero')::int AS zero,
              count(*) FILTER (WHERE a.cost_status = 'unknown_exception')::int AS unknown
         ${FROM}
        WHERE ${where(p)} GROUP BY d.name, a.owning_department_id, fac.id, fac.name, fac.sort_order, a.currency ORDER BY d.name, a.currency`,
      p.values,
    )
  ).rows;
  const visible = values.filter((r) => canMoney(c, r.dept));
  const overall = new Map<string, { total: bigint; n: number }>();
  // Faculty value = sum of its departments' values the user may see, per currency (never across currencies).
  const facultyValue = new Map<string, { faculty: string; order: number; currency: string; total: bigint; recorded: number; zero: number; unknown: number }>();
  for (const r of visible) {
    const cents = BigInt(r.total.replace('.', ''));
    const cur = overall.get(r.currency) ?? { total: 0n, n: 0 };
    overall.set(r.currency, { total: cur.total + cents, n: cur.n + r.recorded + r.zero + r.unknown });
    const key = `${r.faculty_id ?? 'central'}|${r.currency}`;
    const fv = facultyValue.get(key) ?? { faculty: r.faculty ?? CENTRAL_UNIT, order: Number(r.faculty_order), currency: r.currency, total: 0n, recorded: 0, zero: 0, unknown: 0 };
    facultyValue.set(key, { ...fv, total: fv.total + cents, recorded: fv.recorded + r.recorded, zero: fv.zero + r.zero, unknown: fv.unknown + r.unknown });
  }
  const restrictedFaculties = [...new Set(values.filter((r) => !canMoney(c, r.dept)).map((r) => r.faculty ?? CENTRAL_UNIT))];
  const centsText = (v: bigint) => `${v / 100n}.${(v % 100n).toString().padStart(2, '0')}`;
  const conditionHeaders = Object.values(CONDITION_LABELS).map((l) => ({ label: l, kind: 'int' as const }));
  const conditionCells = (r: Record<string, any>) => Object.keys(CONDITION_LABELS).map((k) => r[`c_${k}`]);
  const notes = [...commonNotes(c), 'Counts include every asset record that is not archived, including assets still awaiting their label.'];
  notes.push(`"${CENTRAL_UNIT}" groups units that do not belong to a faculty (for example the Library).`);
  if (restrictedFaculties.length) {
    notes.push(`Faculty value totals leave out departments whose money you may not see (${restrictedFaculties.join(', ')}).`);
  }
  return {
    filters: await filterLines(c, 'Acquired'),
    notes,
    tables: [
      {
        title: 'Assets by faculty (condition breakdown)',
        columns: [
          { label: 'Faculty', width: 2.2 },
          { label: 'Schools / units', kind: 'int' },
          { label: 'Assets', kind: 'int' },
          { label: 'Registered', kind: 'int' },
          { label: 'Awaiting label', kind: 'int' },
          ...conditionHeaders,
        ],
        rows: byFaculty.map((r) => [r.faculty ?? CENTRAL_UNIT, r.departments, r.assets, r.registered, r.awaiting, ...conditionCells(r)]),
        totalRows: byFaculty.length,
        emptyText: 'No assets match the selected filters.',
      },
      {
        title: 'Recorded acquisition value by faculty and currency',
        columns: [
          { label: 'Faculty', width: 2.2 },
          { label: 'Currency' },
          { label: 'Total recorded value', kind: 'money' },
          { label: 'Assets with a cost', kind: 'int' },
          { label: 'Verified zero cost', kind: 'int' },
          { label: 'Unknown cost (exception)', kind: 'int' },
        ],
        rows: [...facultyValue.values()]
          .sort((a, b) => a.order - b.order || a.faculty.localeCompare(b.faculty) || a.currency.localeCompare(b.currency))
          .map((v) => [v.faculty, v.currency, centsText(v.total), v.recorded, v.zero, v.unknown]),
        totalRows: facultyValue.size,
        emptyText: 'No amounts you are allowed to see.',
      },
      {
        title: 'Assets by school / department (condition breakdown)',
        columns: [
          { label: 'School / department', width: 2 },
          { label: 'Faculty', width: 1.6 },
          { label: 'Assets', kind: 'int' },
          { label: 'Registered', kind: 'int' },
          { label: 'Awaiting label', kind: 'int' },
          ...conditionHeaders,
        ],
        rows: byDept.map((r) => [r.name, r.faculty ?? CENTRAL_UNIT, r.assets, r.registered, r.awaiting, ...conditionCells(r)]),
        totalRows: byDept.length,
        emptyText: 'No assets match the selected filters.',
      },
      {
        title: 'Recorded acquisition value by school / department and currency',
        columns: [
          { label: 'School / department', width: 2 },
          { label: 'Faculty', width: 1.6 },
          { label: 'Currency' },
          { label: 'Total recorded value', kind: 'money' },
          { label: 'Assets with a cost', kind: 'int' },
          { label: 'Verified zero cost', kind: 'int' },
          { label: 'Unknown cost (exception)', kind: 'int' },
        ],
        rows: values.map((r) =>
          canMoney(c, r.dept)
            ? [r.department, r.faculty ?? CENTRAL_UNIT, r.currency, r.total, r.recorded, r.zero, r.unknown]
            : [r.department, r.faculty ?? CENTRAL_UNIT, RESTRICTED, null, null, null, null],
        ),
        totalRows: values.length,
      },
      currencyTotalsTable(
        'Totals by currency (all departments in this report)',
        [...overall].map(([currency, v]) => ({ currency, total: centsText(v.total), n: v.n })),
        'Assets',
      ),
      {
        title: 'Assets by school / department and category',
        columns: [{ label: 'School / department', width: 2 }, { label: 'Category', width: 2 }, { label: 'Assets', kind: 'int' }],
        rows: byCat.map((r) => [r.department, r.category, r.n]),
        totalRows: byCat.length,
      },
    ],
  };
}

// Report 3 ---------------------------------------------------------------
const VERIFICATION_REPORT_STATUSES = {
  due_or_overdue: 'Due or overdue',
  overdue: 'Overdue',
  due: 'Due',
  not_yet_verified: 'Not yet verified',
  verified: 'Verified',
  missing: 'Reported or confirmed missing',
  discrepancy: 'Location discrepancy',
} as const;
export const VERIFICATION_REPORT_STATUS_KEYS = Object.keys(VERIFICATION_REPORT_STATUSES) as (keyof typeof VERIFICATION_REPORT_STATUSES)[];

async function verificationReport(c: Ctx): Promise<Pick<Report, 'filters' | 'notes' | 'tables'>> {
  const p = new Params();
  const s = c.f.status;
  const statusSql =
    !s ? 'true'
    : s === 'due_or_overdue' ? `av.verification_status IN ('due','overdue')`
    : s === 'missing' ? `a.missing_status <> 'none'`
    : s === 'discrepancy' ? `(disc.open_flags > 0 OR (a.last_verified_location_id IS NOT NULL AND a.last_verified_location_id <> a.location_id))`
    : `av.verification_status = ${p.add(s)}`;
  const base = `FROM assets a
       JOIN asset_verification av ON av.asset_id = a.id
       JOIN departments d ON d.id = a.owning_department_id
       JOIN locations l ON l.id = a.location_id
       LEFT JOIN locations lv ON lv.id = a.last_verified_location_id
       LEFT JOIN users u ON u.id = a.last_verified_by
       CROSS JOIN LATERAL (SELECT count(*)::int AS open_flags FROM asset_flags f
                            WHERE f.asset_id = a.id AND f.status = 'open' AND f.kind = 'location_discrepancy') disc
      WHERE a.registration_status = 'registered' AND ${assetFilter(c, p)} AND ${dateRange(p, c.f, 'av.due_date')} AND ${statusSql}`;
  const baseParams = [...p.values]; // before the row query adds its LIMIT
  const { rows, total } = await rowsWithTotal(
    c,
    `SELECT count(*) OVER() AS __total, a.institutional_id, a.name, d.name AS department, l.building, l.room,
            av.verification_status, a.last_verified_at, u.full_name AS verified_by, lv.building AS seen_building, lv.room AS seen_room,
            a.last_verified_location_id <> a.location_id AS moved_since, disc.open_flags,
            av.interval_days, av.due_date::text AS due_date, av.overdue_days, a.missing_status
       ${base}
      ORDER BY av.overdue_days DESC NULLS LAST, av.due_date ASC NULLS LAST, a.institutional_id`,
    p,
    'assets',
  );
  const summary = (
    await c.db.query(
      `SELECT av.verification_status AS s, count(*)::int AS n,
              count(*) FILTER (WHERE a.missing_status = 'reported_missing')::int AS reported,
              count(*) FILTER (WHERE a.missing_status = 'confirmed_missing')::int AS confirmed
         ${base}
        GROUP BY av.verification_status`,
      baseParams,
    )
  ).rows;
  const order = ['overdue', 'due', 'not_yet_verified', 'verified'] as const;
  return {
    filters: await filterLines(c, 'Due date', s ? VERIFICATION_REPORT_STATUSES[s as keyof typeof VERIFICATION_REPORT_STATUSES] : undefined),
    notes: [
      `Times are shown in ${c.tz}.`,
      'Only registered, non-archived assets are included. Due date = last successful verification (or registration) + the schedule interval. "Due" starts the number of days set in the schedule before the due date; "Overdue" starts the day after it.',
      'Overdue does not mean missing. "Reported missing" (by department staff) and "Confirmed missing" (by the Asset Management Team) are recorded separately.',
      'A location discrepancy means the asset was last scanned somewhere other than its recorded location, or has an open "found in a different location" flag.',
    ],
    tables: [
      {
        title: 'Summary by verification status',
        columns: [{ label: 'Status', width: 2 }, { label: 'Assets', kind: 'int' }, { label: 'Of which reported missing', kind: 'int' }, { label: 'Of which confirmed missing', kind: 'int' }],
        rows: order.map((k) => {
          const r = summary.find((x) => x.s === k);
          return [VERIFICATION_LABELS[k], r?.n ?? 0, r?.reported ?? 0, r?.confirmed ?? 0];
        }),
        totalRows: order.length,
      },
      {
        title: 'Assets',
        columns: [
          { label: 'Asset ID', width: 1.3 },
          { label: 'Name', width: 1.5 },
          { label: 'Department', width: 1.3 },
          { label: 'Recorded location', width: 1.4 },
          { label: 'Verification status' },
          { label: 'Last verified', kind: 'datetime', width: 1.1 },
          { label: 'Verified by' },
          { label: 'Last seen at', width: 1.4 },
          { label: 'Location discrepancy', width: 0.9 },
          { label: 'Interval (days)', kind: 'int', width: 0.7 },
          { label: 'Due date', kind: 'date', width: 0.9 },
          { label: 'Days overdue', kind: 'int', width: 0.7 },
          { label: 'Missing status' },
        ],
        rows: rows.map((r) => [
          r.institutional_id,
          r.name,
          r.department,
          `${r.building} / ${r.room}`,
          label(VERIFICATION_LABELS, r.verification_status),
          formatTimestamp(r.last_verified_at, c.tz),
          r.verified_by,
          r.seen_building ? `${r.seen_building} / ${r.seen_room}` : null,
          r.moved_since || r.open_flags > 0 ? 'Yes' : 'No',
          r.interval_days,
          r.due_date,
          r.overdue_days,
          label(MISSING_LABELS, r.missing_status),
        ]),
        totalRows: total,
        emptyText: 'No assets match the selected filters.',
      },
    ],
  };
}

// Report 4 ---------------------------------------------------------------
async function maintenanceReport(c: Ctx): Promise<Pick<Report, 'filters' | 'notes' | 'tables'>> {
  const reqWhere = (p: Params) =>
    [
      scopeSql(p, c.user, 'reports.generate', 'mr.department_id'),
      scopeSql(p, c.user, 'maintenance.read', 'mr.department_id'),
      c.f.departmentId ? `mr.department_id = ${p.add(c.f.departmentId)}` : 'true',
      facultySql(p, c.f.facultyId, 'mr.department_id'),
      c.f.categoryId ? `a.category_id = ${p.add(c.f.categoryId)}` : 'true',
      c.f.status === 'open' ? `mr.status NOT IN ${OPEN}` : c.f.status === 'closed' ? `mr.status IN ${OPEN}` : 'true',
      c.f.from || c.f.to ? dateRange(p, c.f, `(mr.reported_at AT TIME ZONE ${p.add(c.tz)})::date`) : 'true',
    ].join(' AND ');
  let p = new Params();
  const { rows, total } = await rowsWithTotal(
    c,
    `SELECT count(*) OVER() AS __total, mr.id, mr.reference, a.institutional_id, a.name AS asset, d.name AS department, mr.department_id,
            mr.reported_at, ru.full_name AS reported_by, mr.problem, mr.condition_at_report, mr.priority, mr.status,
            mr.provider_type, mr.provider_name, mr.provider_contact, mr.work_performed, mr.outcome, mr.completed_at,
            mr.resulting_condition, cu.full_name AS confirmed_by, mr.condition_confirmed_at, a.condition AS current_condition,
            (SELECT string_agg(x.currency || ' ' || x.total, '; ' ORDER BY x.currency)
               FROM (SELECT mc.currency, sum(mc.amount)::numeric(16,2)::text AS total FROM maintenance_costs mc
                      WHERE mc.request_id = mr.id GROUP BY mc.currency) x) AS costs
       FROM maintenance_requests mr JOIN assets a ON a.id = mr.asset_id JOIN departments d ON d.id = mr.department_id
       JOIN users ru ON ru.id = mr.reported_by LEFT JOIN users cu ON cu.id = mr.condition_confirmed_by
      WHERE ${reqWhere(p)}
      ORDER BY mr.reported_at DESC, mr.reference`,
    p,
    'maintenance requests',
  );
  p = new Params();
  const costLines = await rowsWithTotal(
    c,
    `SELECT count(*) OVER() AS __total, mr.reference, a.institutional_id, mc.kind, mc.description, mc.amount::text AS amount, mc.currency,
            mc.invoice_ref, mc.recorded_at
       FROM maintenance_costs mc JOIN maintenance_requests mr ON mr.id = mc.request_id JOIN assets a ON a.id = mr.asset_id
      WHERE ${reqWhere(p)} AND ${scopeSql(p, c.user, 'assets.read_financial', 'mr.department_id')}
      ORDER BY mr.reported_at DESC, mr.reference, mc.recorded_at`,
    p,
    'cost lines',
  );
  p = new Params();
  const costTotals = (
    await c.db.query(
      `SELECT mc.currency, sum(mc.amount)::numeric(16,2)::text AS total, count(DISTINCT mr.id)::int AS n
         FROM maintenance_costs mc JOIN maintenance_requests mr ON mr.id = mc.request_id JOIN assets a ON a.id = mr.asset_id
        WHERE ${reqWhere(p)} AND ${scopeSql(p, c.user, 'assets.read_financial', 'mr.department_id')}
        GROUP BY mc.currency ORDER BY mc.currency`,
      p.values,
    )
  ).rows;
  p = new Params();
  const byStatus = (
    await c.db.query(
      `SELECT mr.status, count(*)::int AS n FROM maintenance_requests mr JOIN assets a ON a.id = mr.asset_id
        WHERE ${reqWhere(p)} GROUP BY mr.status`,
      p.values,
    )
  ).rows;
  p = new Params();
  const history = await rowsWithTotal(
    c,
    `SELECT count(*) OVER() AS __total, mr.reference, h.from_status, h.to_status, u.full_name AS changed_by, h.changed_at, h.note
       FROM maintenance_status_history h JOIN maintenance_requests mr ON mr.id = h.request_id JOIN assets a ON a.id = mr.asset_id
       JOIN users u ON u.id = h.changed_by
      WHERE ${reqWhere(p)}
      ORDER BY mr.reported_at DESC, mr.reference, h.changed_at`,
    p,
    'status changes',
  );
  // Assets currently damaged or unusable (not limited by the request date range: this is their current state).
  p = new Params();
  const damaged = await rowsWithTotal(
    c,
    `SELECT count(*) OVER() AS __total, a.institutional_id, a.name, d.name AS department, a.condition,
            ce.damage_description, ce.event_time AS damage_at,
            (SELECT string_agg(mr.reference || ' (' || mr.status || ')', '; ') FROM maintenance_requests mr
              WHERE mr.asset_id = a.id AND mr.status NOT IN ${OPEN}) AS open_requests
       FROM assets a JOIN departments d ON d.id = a.owning_department_id
       LEFT JOIN LATERAL (SELECT ce.damage_description, ce.event_time FROM condition_events ce
                           WHERE ce.asset_id = a.id AND ce.source = 'damage_report' ORDER BY ce.event_time DESC LIMIT 1) ce ON true
      WHERE a.condition IN ('damaged','unusable') AND ${assetFilter(c, p)}
        AND ${scopeSql(p, c.user, 'maintenance.read', 'a.owning_department_id')}
      ORDER BY d.name, a.institutional_id`,
    p,
    'damaged assets',
  );
  const statusOrder = Object.keys(MAINTENANCE_STATUS_LABELS);
  return {
    filters: await filterLines(c, 'Reported', c.f.status === 'open' ? 'Open requests' : c.f.status === 'closed' ? 'Closed requests' : undefined),
    notes: [
      ...commonNotes(c),
      'Each department manages its own maintenance. Open = any status other than Completed, Rejected or Cancelled.',
      'Completing a request does not change the asset\'s condition; the resulting condition is confirmed separately and shown with who confirmed it.',
      'The damaged-assets table shows current condition and is not limited by the reported-date filter.',
    ],
    tables: [
      {
        title: 'Requests by status',
        columns: [{ label: 'Status', width: 2 }, { label: 'Requests', kind: 'int' }],
        rows: statusOrder.filter((s) => byStatus.some((b) => b.status === s)).map((s) => [label(MAINTENANCE_STATUS_LABELS, s), byStatus.find((b) => b.status === s)!.n]),
        totalRows: byStatus.length,
        emptyText: 'No maintenance requests match the selected filters.',
      },
      {
        title: 'Maintenance requests',
        columns: [
          { label: 'Reference', width: 1.1 },
          { label: 'Asset ID', width: 1.2 },
          { label: 'Asset', width: 1.2 },
          { label: 'Department', width: 1.2 },
          { label: 'Reported', kind: 'datetime', width: 1.1 },
          { label: 'Reported by' },
          { label: 'Problem', width: 1.8 },
          { label: 'Condition at report', width: 0.8 },
          { label: 'Priority', width: 0.7 },
          { label: 'Status', width: 0.9 },
          { label: 'Service provider', width: 1.2 },
          { label: 'Provider contact' },
          { label: 'Work performed', width: 1.6 },
          { label: 'Outcome', width: 0.9 },
          { label: 'Completed', kind: 'datetime', width: 1.1 },
          { label: 'Confirmed condition', width: 0.8 },
          { label: 'Confirmed by' },
          { label: 'Costs', width: 1.2 },
        ],
        rows: rows.map((r) => [
          r.reference,
          r.institutional_id,
          r.asset,
          r.department,
          formatTimestamp(r.reported_at, c.tz),
          r.reported_by,
          r.problem,
          label(CONDITION_LABELS, r.condition_at_report),
          label(PRIORITY_LABELS, r.priority),
          label(MAINTENANCE_STATUS_LABELS, r.status),
          r.provider_type ? `${r.provider_type === 'external' ? 'External' : 'Internal'}${r.provider_name ? `: ${r.provider_name}` : ''}` : null,
          r.provider_contact,
          r.work_performed,
          label(OUTCOME_LABELS, r.outcome),
          formatTimestamp(r.completed_at, c.tz),
          r.condition_confirmed_at ? label(CONDITION_LABELS, r.resulting_condition) : r.status === 'completed' ? 'Not yet confirmed' : null,
          r.confirmed_by,
          canMoney(c, r.department_id) ? (r.costs ?? 'None recorded') : RESTRICTED,
        ]),
        totalRows: total,
        emptyText: 'No maintenance requests match the selected filters.',
      },
      currencyTotalsTable('Recorded repair costs by currency', costTotals.map((r) => ({ currency: r.currency, total: r.total, n: r.n })), 'Requests'),
      {
        title: 'Repair cost lines',
        columns: [
          { label: 'Reference', width: 1.1 },
          { label: 'Asset ID', width: 1.2 },
          { label: 'Type' },
          { label: 'Description', width: 2 },
          { label: 'Amount', kind: 'money' },
          { label: 'Currency', width: 0.6 },
          { label: 'Invoice ref.' },
          { label: 'Recorded', kind: 'datetime', width: 1.1 },
        ],
        rows: costLines.rows.map((r) => [
          r.reference,
          r.institutional_id,
          COST_KIND_LABELS[r.kind] ?? r.kind,
          r.description,
          r.amount,
          r.currency,
          r.invoice_ref,
          formatTimestamp(r.recorded_at, c.tz),
        ]),
        totalRows: costLines.total,
        emptyText: 'No cost lines you are allowed to see.',
      },
      {
        title: 'Repair history (status changes)',
        columns: [{ label: 'Reference', width: 1.1 }, { label: 'From' }, { label: 'To' }, { label: 'Changed by' }, { label: 'When', kind: 'datetime', width: 1.1 }, { label: 'Note', width: 2.5 }],
        rows: history.rows.map((r) => [
          r.reference,
          label(MAINTENANCE_STATUS_LABELS, r.from_status),
          label(MAINTENANCE_STATUS_LABELS, r.to_status),
          r.changed_by,
          formatTimestamp(r.changed_at, c.tz),
          r.note,
        ]),
        totalRows: history.total,
      },
      {
        title: 'Assets currently damaged or unusable',
        columns: [
          { label: 'Asset ID', width: 1.2 },
          { label: 'Name', width: 1.4 },
          { label: 'Department', width: 1.3 },
          { label: 'Condition' },
          { label: 'Latest damage report', width: 2.4 },
          { label: 'Reported', kind: 'datetime', width: 1.1 },
          { label: 'Open requests', width: 1.6 },
        ],
        rows: damaged.rows.map((r) => [
          r.institutional_id,
          r.name,
          r.department,
          label(CONDITION_LABELS, r.condition),
          r.damage_description,
          formatTimestamp(r.damage_at, c.tz),
          r.open_requests?.replace(/\((\w+)\)/g, (_: string, s: string) => `(${label(MAINTENANCE_STATUS_LABELS, s)})`) ?? 'None',
        ]),
        totalRows: damaged.total,
        emptyText: 'No damaged or unusable assets.',
      },
    ],
  };
}

const BUILDERS: Record<ReportKind, (c: Ctx) => Promise<Pick<Report, 'filters' | 'notes' | 'tables'>>> = {
  'asset-register': assetRegister,
  'department-summary': departmentSummary,
  verification: verificationReport,
  maintenance: maintenanceReport,
};

export async function buildReport(
  db: Queryable,
  user: Principal & { fullName: string },
  kind: ReportKind,
  f: Filters,
  o: ReportOptions,
): Promise<Report> {
  const tz = await getSetting(db, 'institution_time_zone');
  const names: Names = {
    department: async (id) => (id ? ((await db.query('SELECT name FROM departments WHERE id = $1', [id])).rows[0]?.name ?? 'Unknown') : ''),
    category: async (id) => (id ? ((await db.query('SELECT name FROM asset_categories WHERE id = $1', [id])).rows[0]?.name ?? 'Unknown') : ''),
    faculty: async (id) => (id ? ((await db.query('SELECT name FROM faculties WHERE id = $1', [id])).rows[0]?.name ?? 'Unknown') : ''),
  };
  const body = await BUILDERS[kind]({ db, user, f, o, tz, names });
  return { kind, title: REPORT_TITLES[kind], generatedAt: new Date().toISOString(), generatedBy: user.fullName, timeZone: tz, ...body };
}
