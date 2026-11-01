// Shared by the API server and the app. No dependencies, so both can import it.
// Server: import '../../shared/asset-codes.ts'   App: import '@shared/asset-codes'

/** Institutional asset ID, e.g. UAT-2026-000123. Assigned only by the server; never reused. */
export const INSTITUTIONAL_ID_RE = /^[A-Z]{2,6}-\d{4}-\d{6,}$/;

export function formatInstitutionalId(prefix: string, year: number, sequence: number): string {
  return `${prefix}-${year}-${String(sequence).padStart(6, '0')}`;
}

/**
 * QR payload printed on labels. Stable, non-secret, and not a URL, so labels keep working if web
 * addresses change. Scanning it never grants access: the server still authenticates and authorises.
 * Uses only QR "alphanumeric" characters (A–Z, 0–9, '-', ':') so the code stays small.
 */
export const QR_PREFIX = 'UATS:';

export const qrPayloadFor = (institutionalId: string) => `${QR_PREFIX}${institutionalId}`;

/**
 * Turns scanned or typed text into an institutional ID, or null if it is not one of ours.
 * Accepts "UATS:UAT-2026-000123" or a bare "UAT-2026-000123" (any case, surrounding spaces).
 * Anything else (URLs, scripts, other barcodes) is rejected — QR content is treated as data only.
 */
export function parseScannedCode(text: string): string | null {
  if (typeof text !== 'string' || text.length > 80) return null;
  let s = text.trim().toUpperCase();
  if (s.startsWith(QR_PREFIX)) s = s.slice(QR_PREFIX.length);
  return INSTITUTIONAL_ID_RE.test(s) ? s : null;
}

export const CONDITIONS = ['excellent', 'good', 'fair', 'damaged', 'unusable'] as const;
export type Condition = (typeof CONDITIONS)[number];
export const CONDITION_LABELS: Record<Condition, string> = {
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
  damaged: 'Damaged',
  unusable: 'Unusable',
};

/** Whether the asset is being used. Separate from registration, condition, missing and archive status. */
export const USAGE_STATUSES = ['in_use', 'in_storage', 'not_in_use', 'awaiting_disposal'] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];
export const USAGE_STATUS_LABELS: Record<UsageStatus, string> = {
  in_use: 'In use',
  in_storage: 'In storage',
  not_in_use: 'Not in use',
  awaiting_disposal: 'Awaiting disposal',
};

/** Registration status. 'draft' is reserved for offline drafts (Phase 6). */
export const REGISTRATION_STATUSES = ['draft', 'awaiting_label', 'registered'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];
export const REGISTRATION_STATUS_LABELS: Record<RegistrationStatus, string> = {
  draft: 'Draft',
  awaiting_label: 'Awaiting label',
  registered: 'Registered',
};

export const ACQUISITION_METHODS = ['purchase', 'donation', 'transfer', 'other'] as const;
export type AcquisitionMethod = (typeof ACQUISITION_METHODS)[number];
export const ACQUISITION_METHOD_LABELS: Record<AcquisitionMethod, string> = {
  purchase: 'Purchase',
  donation: 'Donation',
  transfer: 'Transfer',
  other: 'Other',
};

/**
 * How the acquisition cost is known.
 * - recorded: a positive amount from an invoice or record
 * - verified_zero: confirmed to have cost nothing (e.g. a donation with no value)
 * - unknown_exception: cost genuinely unknown; requires a reason and is reported separately, never as zero
 */
export const COST_STATUSES = ['recorded', 'verified_zero', 'unknown_exception'] as const;
export type CostStatus = (typeof COST_STATUSES)[number];
export const COST_STATUS_LABELS: Record<CostStatus, string> = {
  recorded: 'Recorded amount',
  verified_zero: 'Verified zero cost',
  unknown_exception: 'Cost unknown (exception)',
};

/** Money is handled as a decimal string ("1234.50") end to end — never as a float. */
export const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;

/** Normalises user input like " 1,234.5 " to "1234.50"; returns null if invalid. */
export function parseMoney(input: string): string | null {
  const s = String(input ?? '').trim().replace(/,/g, '');
  if (!MONEY_RE.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return `${BigInt(whole).toString()}.${frac.padEnd(2, '0')}`;
}

export function isZeroMoney(amount: string): boolean {
  return /^0+(\.0+)?$/.test(amount);
}

/** Display an amount with its explicit currency code, e.g. "USD 1,234.50". */
/** The university's home currency: Papua New Guinea kina. Default for departments, assets and costs. */
export const HOME_CURRENCY = 'PGK';

/**
 * "K1,250.00" for kina (the usual PNG way of writing it); other currencies keep their code, e.g. "USD 120.50",
 * so a foreign price is never mistaken for kina. Amounts in different currencies are never added together.
 */
export function formatMoney(amount: string | null | undefined, currency: string): string {
  if (amount == null) return '—';
  const [whole, frac = '00'] = amount.split('.');
  const digits = `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac.padEnd(2, '0').slice(0, 2)}`;
  return currency === HOME_CURRENCY ? `K${digits}` : `${currency} ${digits}`;
}

/** Strict calendar-date check for YYYY-MM-DD strings. */
export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Today's date (YYYY-MM-DD) in the institution's time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
