// Phase 5: dashboard and reports. Figures come from live records, limited to what the user may see.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { parse, requirePermission, type AppDeps } from '../app.ts';
import { audit } from '../audit.ts';
import { AppError } from '../errors.ts';
import { fileBaseName, toPdf, toXlsx } from '../report-render.ts';
import { buildReport, dashboard, REPORT_KINDS, VERIFICATION_REPORT_STATUS_KEYS, type Filters, type ReportKind } from '../reports.ts';
import { CONDITIONS, isValidDate, REGISTRATION_STATUSES } from '../../../shared/asset-codes.ts';

const DateParam = z.string().refine(isValidDate, 'Use a real date in the form YYYY-MM-DD.');

const Common = {
  departmentId: z.uuid().optional(),
  // A faculty id, or 'central' for units that belong to no faculty.
  facultyId: z.union([z.uuid(), z.literal('central')]).optional(),
  categoryId: z.uuid().optional(),
  condition: z.enum(CONDITIONS).optional(),
};

/** Allowed `status` values per report (each report filters on a different kind of status). */
const STATUS_BY_KIND: Record<ReportKind, readonly string[]> = {
  'asset-register': REGISTRATION_STATUSES.filter((s) => s !== 'draft'),
  'department-summary': [],
  verification: VERIFICATION_REPORT_STATUS_KEYS,
  maintenance: ['open', 'closed'],
};

const PREVIEW_ROWS = 50;

export function reportRoutes(app: FastifyInstance, { db, config }: AppDeps) {
  app.get('/dashboard', async (req) => {
    const q = parse(
      z.object({ ...Common, periodDays: z.coerce.number().int().refine((n) => [30, 90, 180, 365].includes(n), 'Choose 30, 90, 180 or 365 days.').optional() }),
      req.query,
    );
    const user = await requirePermission(db, req, 'dashboard.read', q.departmentId);
    return dashboard(db, user, q);
  });

  app.get('/reports/:kind', async (req, reply) => {
    const { kind } = parse(z.object({ kind: z.enum(REPORT_KINDS) }), req.params);
    const q = parse(
      z
        .object({
          ...Common,
          status: z.string().max(40).optional(),
          from: DateParam.optional(),
          to: DateParam.optional(),
          format: z.enum(['json', 'pdf', 'xlsx']).default('json'),
        })
        .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'The start date must be on or before the end date.', path: ['to'] })
        .refine((v) => !v.status || STATUS_BY_KIND[kind].includes(v.status), { message: 'This status filter is not available for this report.', path: ['status'] }),
      req.query,
    );
    // A department filter must be one the user may report on; without one, results are limited to their scope.
    const user = await requirePermission(db, req, 'reports.generate', q.departmentId);
    const filters: Filters = { departmentId: q.departmentId, facultyId: q.facultyId, categoryId: q.categoryId, condition: q.condition, status: q.status, from: q.from, to: q.to };
    const exporting = q.format !== 'json';
    const report = await buildReport(db, user, kind, filters, { limit: PREVIEW_ROWS, maxRows: config.reportMaxRows, export: exporting });
    if (!exporting) return report;

    let body: Buffer;
    try {
      body = q.format === 'pdf' ? await toPdf(report) : await toXlsx(report);
    } catch (e) {
      req.log.error(e, 'report export failed');
      throw new AppError(500, 'EXPORT_FAILED', 'The report could not be exported. Please try again; if it keeps failing, contact an administrator.');
    }
    await audit(db, {
      actorId: user.id,
      action: 'report.export',
      entityType: 'report',
      entityId: kind,
      departmentId: q.departmentId ?? null,
      context: { format: q.format, filters, rows: Object.fromEntries(report.tables.map((t) => [t.title, t.totalRows])), bytes: body.length },
      ip: req.ip,
    });
    const name = `${fileBaseName(report)}.${q.format}`;
    return reply
      .header('content-type', q.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(body);
  });
}
