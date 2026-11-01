// Account operations shared by several routes: sessions, lockout, password changes, reset tokens.
import type { Config } from './config.ts';
import type { Db, Queryable } from './db.ts';
import { AppError } from './errors.ts';
import { audit } from './audit.ts';
import { checkPasswordAgainstEmail, hashPassword, newToken, sha256, verifyPassword } from './security.ts';

export type ClientType = 'web' | 'mobile';

export async function createSession(
  q: Queryable,
  cfg: Config,
  userId: string,
  client: ClientType,
  meta: { userAgent?: string; ip?: string },
) {
  const policy = cfg.auth[client];
  const { token, hash } = newToken();
  const { rows } = await q.query(
    `INSERT INTO sessions (user_id, token_hash, client_type, idle_timeout_s, expires_at, user_agent, ip)
     VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5), $6, $7)
     RETURNING id, expires_at`,
    [userId, hash, client, policy.idleSeconds, policy.absoluteSeconds, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null],
  );
  return { token, sessionId: rows[0].id as string, expiresAt: rows[0].expires_at as Date };
}

export async function revokeSessions(q: Queryable, userId: string, reason: string, exceptSessionId?: string) {
  const r = await q.query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [userId, reason, exceptSessionId ?? null],
  );
  return r.rowCount;
}

type LoginResult =
  | { ok: true; userId: string }
  | { ok: false; code: 'INVALID_CREDENTIALS' | 'ACCOUNT_LOCKED' | 'ACCOUNT_DEACTIVATED' | 'ACCOUNT_PENDING' | 'ACCESS_REJECTED'; retryAfterSeconds?: number };

/**
 * Verifies credentials with progressive lockout:
 * after `maxFailedAttempts` failures the account locks for base minutes, doubling per lock (capped).
 */
export async function attemptLogin(db: Db, cfg: Config, email: string, password: string, ip: string): Promise<LoginResult> {
  const { rows } = await db.query(
    `SELECT id, password_hash, status, failed_login_count, lockout_count, department_id,
            CASE WHEN locked_until > now() THEN ceil(extract(epoch FROM locked_until - now()))::int END AS locked_for
       FROM users WHERE email = $1`,
    [email],
  );
  const user = rows[0];

  if (!user) {
    // No account: maybe a pending or rejected access request with this password.
    const req = (
      await db.query(
        `SELECT status, password_hash FROM access_requests WHERE email = $1 AND status IN ('pending','rejected')
          ORDER BY created_at DESC LIMIT 1`,
        [email],
      )
    ).rows[0];
    const ok = await verifyPassword(req?.password_hash, password);
    await audit(db, { actorId: null, action: 'auth.login', entityType: 'user', outcome: 'failure', context: { email, reason: ok ? req.status : 'unknown_or_wrong' }, ip });
    if (ok && req.status === 'pending') return { ok: false, code: 'ACCOUNT_PENDING' };
    if (ok && req.status === 'rejected') return { ok: false, code: 'ACCESS_REJECTED' };
    return { ok: false, code: 'INVALID_CREDENTIALS' };
  }

  if (user.locked_for) {
    await audit(db, { actorId: null, action: 'auth.login', entityType: 'user', entityId: user.id, outcome: 'denied', context: { reason: 'locked' }, ip });
    return { ok: false, code: 'ACCOUNT_LOCKED', retryAfterSeconds: user.locked_for };
  }

  if (!user.password_hash) {
    // Admin-created account whose owner has not used the setup link yet.
    await verifyPassword(null, password);
    return { ok: false, code: 'INVALID_CREDENTIALS' };
  }

  const valid = await verifyPassword(user.password_hash, password);
  if (!valid) {
    // Atomic increment, then lock in the same statement once the threshold is reached.
    const { rows: upd } = await db.query(
      `UPDATE users SET
              failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
              lockout_count      = CASE WHEN failed_login_count + 1 >= $2 THEN lockout_count + 1 ELSE lockout_count END,
              locked_until       = CASE WHEN failed_login_count + 1 >= $2
                                        THEN now() + make_interval(mins => LEAST($3 * power(2, lockout_count)::int, $4))
                                        ELSE locked_until END
        WHERE id = $1
        RETURNING (locked_until > now()) AS locked, ceil(extract(epoch FROM locked_until - now()))::int AS locked_for`,
      [user.id, cfg.auth.maxFailedAttempts, cfg.auth.baseLockoutMinutes, cfg.auth.maxLockoutMinutes],
    );
    if (upd[0]?.locked) {
      await audit(db, { actorId: null, action: 'auth.lockout', entityType: 'user', entityId: user.id, departmentId: user.department_id, outcome: 'failure', context: { seconds: upd[0].locked_for }, ip });
      return { ok: false, code: 'ACCOUNT_LOCKED', retryAfterSeconds: upd[0].locked_for };
    }
    await audit(db, { actorId: null, action: 'auth.login', entityType: 'user', entityId: user.id, outcome: 'failure', context: { reason: 'bad_credentials' }, ip });
    return { ok: false, code: 'INVALID_CREDENTIALS' };
  }

  if (user.status !== 'active') {
    await audit(db, { actorId: null, action: 'auth.login', entityType: 'user', entityId: user.id, outcome: 'denied', context: { reason: 'deactivated' }, ip });
    return { ok: false, code: 'ACCOUNT_DEACTIVATED' };
  }

  await db.query(
    `UPDATE users SET failed_login_count = 0, lockout_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
    [user.id],
  );
  return { ok: true, userId: user.id };
}

export function validateNewPassword(password: string, email: string) {
  const problem = checkPasswordAgainstEmail(password, email);
  if (problem) throw new AppError(400, 'WEAK_PASSWORD', problem);
}

/** Sets a new password, revokes other sessions and outstanding reset tokens. Caller audits. */
export async function setPassword(q: Queryable, userId: string, email: string, password: string, keepSessionId?: string) {
  validateNewPassword(password, email);
  const hash = await hashPassword(password);
  await q.query(
    `UPDATE users SET password_hash = $2, password_changed_at = now(), failed_login_count = 0,
            lockout_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
    [userId, hash],
  );
  await revokeSessions(q, userId, 'password_changed', keepSessionId);
  await q.query(
    `UPDATE password_reset_tokens SET invalidated_at = now()
      WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
    [userId],
  );
}

/** Creates a single-use reset/setup token, invalidating older unused ones. Returns the raw token (never stored). */
export async function issueResetToken(
  q: Queryable,
  cfg: Config,
  userId: string,
  purpose: 'reset' | 'setup',
  createdBy: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  await q.query(
    `UPDATE password_reset_tokens SET invalidated_at = now()
      WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
    [userId],
  );
  const { token, hash } = newToken();
  const minutes = purpose === 'setup' ? cfg.auth.setupTokenHours * 60 : cfg.auth.resetTokenMinutes;
  const { rows } = await q.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, purpose, created_by, expires_at)
     VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5)) RETURNING expires_at`,
    [userId, hash, purpose, createdBy, minutes],
  );
  return { token, expiresAt: rows[0].expires_at };
}

/** Consumes a reset token atomically. Returns the user, or throws if invalid/expired/used. */
export async function consumeResetToken(q: Queryable, token: string) {
  const { rows } = await q.query(
    `UPDATE password_reset_tokens t SET used_at = now()
       FROM users u
      WHERE t.token_hash = $1 AND t.user_id = u.id
        AND t.used_at IS NULL AND t.invalidated_at IS NULL AND t.expires_at > now()
        AND u.status = 'active'
      RETURNING u.id, u.email, u.department_id, t.purpose`,
    [sha256(token)],
  );
  if (!rows[0]) throw new AppError(400, 'INVALID_RESET_TOKEN', 'This link is invalid, expired, or has already been used.');
  return rows[0] as { id: string; email: string; department_id: string | null; purpose: 'reset' | 'setup' };
}

/**
 * Reads a reset/setup token WITHOUT using it, so the password page can show which account it is for.
 * Only someone holding the (secret, single-use) link learns the email it belongs to.
 */
export async function peekResetToken(q: Queryable, token: string) {
  const { rows } = await q.query(
    `SELECT u.email, u.full_name, t.purpose, t.expires_at
       FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1
        AND t.used_at IS NULL AND t.invalidated_at IS NULL AND t.expires_at > now()
        AND u.status = 'active'`,
    [sha256(token)],
  );
  if (!rows[0]) throw new AppError(400, 'INVALID_RESET_TOKEN', 'This link is invalid, expired, or has already been used.');
  return {
    email: rows[0].email as string,
    fullName: rows[0].full_name as string,
    purpose: rows[0].purpose as 'reset' | 'setup',
    expiresAt: rows[0].expires_at as Date,
  };
}

export function resetLink(cfg: Config, token: string) {
  return `${cfg.publicAppUrl}/reset-password?token=${encodeURIComponent(token)}`;
}
