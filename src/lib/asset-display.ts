// Presentation helpers for assets (labels, tones, history wording). No data access here.
import type { AssetHistory, MaintenanceStatus, Priority, VerificationStatus } from './types';

export {
  COST_KIND_LABELS,
  FLAG_LABELS,
  MAINTENANCE_STATUS_LABELS,
  MISSING_LABELS,
  OUTCOME_LABELS,
  PRIORITY_LABELS,
  VERIFICATION_LABELS,
} from '@shared/status-labels';

export const conditionTone = (c: string) => (c === 'damaged' || c === 'unusable' ? 'bad' : c === 'fair' ? 'warn' : 'good');

export const verificationTone = (s: VerificationStatus) =>
  s === 'overdue' ? 'bad' : s === 'due' ? 'warn' : s === 'verified' ? 'good' : 'neutral';

const ACTIONS: Record<string, string> = {
  'asset.create': 'Asset record created and ID assigned',
  'asset.update': 'Details changed',
  'asset.label_print': 'QR label printed',
  'asset.label_reprint': 'QR label reprinted',
  'asset.label_mismatch': 'Label confirmation failed (wrong label)',
  'asset.register': 'Label attached and confirmed — registration complete',
  'asset.archive': 'Archived',
  'asset.restore': 'Restored from archive',
  'asset.verify': 'Physically verified',
  'asset.move': 'Relocated',
  'asset.report_missing': 'Reported missing',
  'asset.confirm_missing': 'Confirmed missing',
  'asset.clear_missing': 'Missing status cleared',
  'flag.resolve': 'Review flag resolved',
  'asset.condition': 'Condition recorded',
};

export const describeAction = (action: string) => ACTIONS[action] ?? action;

const FIELD_NAMES: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  categoryId: 'Category',
  manufacturer: 'Manufacturer',
  model: 'Model',
  serialNumber: 'Serial number',
  manufacturerBarcode: 'Manufacturer barcode',
  departmentId: 'Department',
  locationId: 'Location',
  acquisitionDate: 'Acquisition date',
  acquisitionMethod: 'Acquisition method',
  acquisitionCost: 'Cost',
  currency: 'Currency',
  costStatus: 'Cost status',
  costExceptionReason: 'Unknown-cost reason',
  supplier: 'Supplier',
  purchaseOrderRef: 'PO / invoice',
  warrantyExpiry: 'Warranty expiry',
  notes: 'Notes',
  condition: 'Condition',
};

/**
 * "Name: Old → New" lines for an edit event. `names` maps record ids (categories, locations,
 * departments) to readable names; unknown ids are shown as stored.
 */
export function describeChanges(e: AssetHistory['events'][number], names: Record<string, string> = {}): string[] {
  if (e.action !== 'asset.update' || !e.after) return [];
  const show = (v: unknown) => (v === null || v === undefined || v === '' ? '(empty)' : names[String(v)] ?? String(v));
  return Object.keys(e.after).map((k) => `${FIELD_NAMES[k] ?? k}: ${show(e.before?.[k])} → ${show(e.after?.[k])}`);
}

/** Short extra detail for non-edit events (reason, method…). */
export function describeContext(e: AssetHistory['events'][number]): string | null {
  const c = e.context ?? {};
  const parts: string[] = [];
  if (typeof c.reason === 'string' && c.reason) parts.push(`Reason: ${c.reason}`);
  if (typeof c.note === 'string' && c.note) parts.push(`Note: ${c.note}`);
  if (c.outcome === 'location_discrepancy') parts.push('Seen in a different location than recorded');
  if (typeof c.foundAfter === 'string') parts.push('Found after being reported missing');
  if (c.method === 'scan') parts.push('QR code scanned');
  if (c.method === 'manual') parts.push('Asset code typed by hand');
  if (Array.isArray(c.duplicateConfirmed)) parts.push(`Confirmed as different from ${c.duplicateConfirmed.join(', ')}`);
  if (c.duplicateConfirmed === true) parts.push('Serial number duplicate confirmed as a different item');
  if (typeof c.costExceptionReason === 'string') parts.push(`Cost unknown: ${c.costExceptionReason}`);
  if (typeof c.read === 'string') parts.push(`Scanned label belongs to ${c.read}`);
  if (typeof c.copies === 'number' && c.copies > 1) parts.push(`${c.copies} copies`);
  return parts.length ? parts.join(' · ') : null;
}

// ----- Phase 4 -----

export const maintenanceTone = (s: MaintenanceStatus) =>
  s === 'completed' ? 'good' : s === 'rejected' || s === 'cancelled' ? 'neutral' : s === 'submitted' || s === 'under_review' ? 'warn' : 'info';

export const priorityTone = (p: Priority) => (p === 'urgent' ? 'bad' : p === 'high' ? 'warn' : 'neutral');

export const CONDITION_SOURCE_LABELS: Record<string, string> = {
  condition_update: 'Condition updated',
  damage_report: 'Damage reported',
  maintenance_confirmation: 'Condition confirmed after maintenance',
};

/** Button wording for moving a request to each status. */
export const STATUS_ACTIONS: Record<MaintenanceStatus, string> = {
  submitted: 'Submit',
  under_review: 'Start review',
  approved: 'Approve',
  in_progress: 'Start work',
  awaiting_parts: 'Waiting for parts',
  awaiting_external: 'Sent to external service',
  completed: 'Complete',
  rejected: 'Reject',
  cancelled: 'Cancel request',
};
