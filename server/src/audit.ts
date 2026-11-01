import type { Queryable } from './db.ts';
import { redact } from './security.ts';

export type AuditEntry = {
  actorId: string | null;
  action: string; // e.g. 'user.create', 'auth.login'
  entityType: string; // e.g. 'user', 'access_request'
  entityId?: string | null;
  departmentId?: string | null;
  outcome?: 'success' | 'denied' | 'failure';
  before?: unknown;
  after?: unknown;
  context?: unknown;
  ip?: string | null;
};

/** Writes one audit event. Call inside the same transaction as the change it describes. */
export async function audit(q: Queryable, e: AuditEntry): Promise<void> {
  const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(redact(v)));
  await q.query(
    `INSERT INTO audit_events
       (actor_user_id, action, entity_type, entity_id, department_id, outcome, before_data, after_data, context, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10)`,
    [
      e.actorId,
      e.action,
      e.entityType,
      e.entityId ?? null,
      e.departmentId ?? null,
      e.outcome ?? 'success',
      json(e.before),
      json(e.after),
      json(e.context),
      e.ip ?? null,
    ],
  );
}

/** Only the fields that changed, for compact before/after audit records. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    if (after[k] !== undefined && JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}
