import { z } from 'zod';
import type { Queryable } from './db.ts';
import { templateProblems, type LabelTemplate } from '../../shared/label-template.ts';

const mm = (min: number, max: number) => z.number().min(min).max(max);

const LabelTemplateSchema = z
  .strictObject({
    layout: z.enum(['sheet', 'single']),
    pageWidthMm: mm(20, 500),
    pageHeightMm: mm(20, 1000),
    columns: z.number().int().min(1).max(10),
    rows: z.number().int().min(1).max(30),
    labelWidthMm: mm(15, 500),
    labelHeightMm: mm(15, 500),
    marginTopMm: mm(0, 100),
    marginLeftMm: mm(0, 100),
    gapXMm: mm(0, 50),
    gapYMm: mm(0, 50),
    qrSizeMm: mm(10, 200),
    paddingMm: mm(0, 20),
    showName: z.boolean(),
    showDepartment: z.boolean(),
    footerText: z.string().max(60),
  })
  .superRefine((t, ctx) => {
    for (const message of templateProblems(t as LabelTemplate)) ctx.addIssue({ code: 'custom', message });
  });

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Every configurable setting with its validation rule. Unknown keys are rejected. */
export const SETTING_SCHEMAS = {
  allowed_email_domains: z
    .array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter a domain like university.ac.xx'))
    .max(20),
  institution_time_zone: z.string().refine(isTimeZone, 'Unknown time zone (use an IANA name such as Africa/Nairobi).'),
  allow_unknown_cost: z.boolean(),
  // Changing the prefix only affects new IDs; existing IDs and printed labels stay valid.
  asset_id_prefix: z.string().trim().toUpperCase().regex(/^[A-Z]{2,6}$/, 'Use 2–6 letters, e.g. UAT.'),
  label_template: LabelTemplateSchema,
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_SCHEMAS)[K]>;

export async function getSetting<K extends SettingKey>(q: Queryable, key: K): Promise<SettingValue<K>> {
  const { rows } = await q.query('SELECT value FROM system_settings WHERE key = $1', [key]);
  return SETTING_SCHEMAS[key].parse(rows[0]?.value) as SettingValue<K>;
}

export async function getAllSettings(q: Queryable) {
  const { rows } = await q.query('SELECT key, value, updated_at FROM system_settings ORDER BY key');
  return rows.filter((r) => r.key in SETTING_SCHEMAS);
}
