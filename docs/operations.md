# Operations runbook

How to run, monitor, back up and recover the Asset Tracking System. Written in Phase 7 (2026-10-31).
Items marked **(tested)** were performed in this environment; others are procedures for the production hosting,
which has not been chosen yet (see `hosting-comparison.md`).

## 1. Monitoring

| What | How | Alert when |
|---|---|---|
| Liveness | `GET /health` → `{"status":"ok"}` (checks the database answers) **(tested)** | not 200 for 2 minutes |
| Readiness | `GET /health/ready` → database, schema up to date (no pending migrations), file storage writable; 503 if any check fails **(tested)** | 503 for 2 minutes, or after a deployment |
| Errors | Structured JSON logs (one line per request: method, URL, status, response time; errors with stack traces in the log only, never in responses). Authorization headers, cookies, passwords and tokens are redacted | more than 1% of responses are 5xx over 10 minutes |
| Security events | Audit log (`/admin/audit` in the app): failed sign-ins, lockouts, `authz.denied`, role changes, deactivations, exports | repeated `authz.denied` from one account; many lockouts |
| Capacity | Database size, disk space of `UPLOAD_DIR`, response times (`responseTime` in the logs) | disk above 80%; p95 response time above 1 s |
| Backups | Age of the newest backup and its manifest (backup-recovery.md) | no successful backup for 26 hours |

The hosting platform's own monitoring (uptime checks against `/health/ready`, log collection, disk alerts) should be
pointed at these. No third-party monitoring service is built in.

## 2–3. Backups and restore

See **[backup-recovery.md](backup-recovery.md)**: backup policy and commands, restore procedure, recovery objectives,
and the recorded restore drill.

## 4. Routine tasks

| Task | Command / place | When |
|---|---|---|
| Apply migrations | automatic on API start, or `npm --prefix server run migrate`; back up first | each release |
| Unreferenced uploads | `npm --prefix server run cleanup-uploads` (lists only); `-- --delete` to remove | monthly |
| Dependency audit | `npm audit --omit=dev` in the root and `server/` | each release |
| Review accounts | Users screen: deactivate leavers, review cross-department grants | monthly |
| Restore drill | backup-recovery.md §3, into a scratch database | quarterly |

## 5. Incidents

| Situation | Do this |
|---|---|
| A phone is lost or stolen | Deactivate the person's account (signs out every session, including the phone). Unsent offline work on that phone is lost; ask the person what was recorded since their last sync. Reactivate or create a new account when they have a new phone. |
| An administrator account may be compromised | Another administrator deactivates it (the last active admin cannot be removed), checks the audit log for its actions, then issues a new setup link. |
| API down | Check `/health/ready`: "database unreachable" → database/network; "pending migrations" → run `migrate`; "file storage not writable" → disk or volume permissions. Logs show the error. |
| Disk full | Free space on the upload volume; run `cleanup-uploads`; enlarge the volume. Uploads fail with a clear message meanwhile; nothing else is affected. |
| Data damaged or deleted by mistake | Assets are never physically deleted (archive/restore). For other damage: restore the last good backup into a new database (backup-recovery.md), compare, and copy back what is needed. |
| Many failed sign-ins | Accounts lock automatically (5 attempts, growing lock time). Check the audit log for the source; administrators can unlock. |

## 6. Secrets

- `DATABASE_URL` (with password) and any SMTP credentials live only in the hosting platform's secret store.
- Sessions are random tokens stored as hashes; there is no signing key to rotate. To sign everyone out (e.g. after a
  suspected leak), run `UPDATE sessions SET revoked_at = now(), revoke_reason = 'forced' WHERE revoked_at IS NULL`
  against the database.
- Changing the database password: set the new one in the secret store, restart the API.
