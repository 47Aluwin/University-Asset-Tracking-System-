// Makes a write safe to repeat. Phones retry when a connection drops, so the same operation can reach the
// server twice (for example when the first reply was lost). The client sends one operation id per action
// (X-Operation-Id); the first request does the work and stores its reply, later ones get the stored reply.
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Queryable } from './db.ts';
import { badRequest, conflict } from './errors.ts';

export function operationIdFrom(req: FastifyRequest): string | null {
  const h = req.headers['x-operation-id'];
  if (typeof h !== 'string') return null;
  const r = z.uuid().safeParse(h);
  if (!r.success) throw badRequest('INVALID_OPERATION_ID', 'X-Operation-Id must be a UUID.');
  return r.data;
}

export type Outcome = { status: number; body: unknown };

/**
 * Runs `work` at most once per operation id. Must be called inside a transaction (`q`). The id is claimed
 * first, so a simultaneous duplicate waits for the first to finish and then receives its stored reply.
 * If `work` throws, the transaction rolls back and the id is not used up: the same request can be retried.
 */
export async function once(
  q: Queryable,
  operationId: string | null,
  userId: string,
  operation: string,
  work: () => Promise<Outcome>,
): Promise<Outcome & { replayed: boolean }> {
  if (!operationId) return { ...(await work()), replayed: false };
  const claimed = await q.query(
    `INSERT INTO api_operations (operation_id, user_id, operation, status_code, response)
     VALUES ($1, $2, $3, 0, '{}'::jsonb) ON CONFLICT (operation_id) DO NOTHING RETURNING operation_id`,
    [operationId, userId, operation],
  );
  if (!claimed.rows[0]) {
    const prev = (await q.query('SELECT user_id, operation, status_code, response FROM api_operations WHERE operation_id = $1', [operationId])).rows[0];
    if (!prev || prev.user_id !== userId || prev.operation !== operation) {
      throw conflict('OPERATION_ID_REUSED', 'This operation id was already used for a different request.');
    }
    return { status: prev.status_code as number, body: prev.response, replayed: true };
  }
  const out = await work();
  await q.query('UPDATE api_operations SET status_code = $2, response = $3::jsonb WHERE operation_id = $1', [operationId, out.status, JSON.stringify(out.body)]);
  return { ...out, replayed: false };
}
