# Security

Status: Phase 1 controls implemented and tested. Later phases add file-upload, QR and offline-storage controls.

## Implemented (Phase 1)

| Control | Implementation | Test evidence |
|---|---|---|
| Password hashing | Argon2id (19 MiB, t=2, p=1) via `@node-rs/argon2` | `auth.test.ts` |
| Password policy | ≥ 12 chars, ≤ 256, must not equal or contain the email name | `auth.test.ts`, browser journey |
| Account lockout | 5 failures → 15 min lock, doubling per repeat lock (max 24 h); atomic counter update; admin unlock | `auth.test.ts` |
| Rate limiting | 300 req/min/IP globally; sign-in 10/min; password reset 5/15 min; access requests 5/h | `platform.test.ts` |
| Account enumeration | Same error for unknown email and wrong password; dummy hash checked when no account; forgot-password always returns 202 | `auth.test.ts` |
| Sessions | 256-bit random opaque token; only SHA-256 hash stored; idle (12 h web) and absolute (7 d web, 30 d mobile) expiry; checked against the user's current status on every request | `auth.test.ts` |
| Session revocation | Logout; password change/reset (other sessions); role/department change; deactivation | `auth.test.ts`, `users.test.ts` |
| Reset/setup tokens | Single-use, hashed, expiring (30 min self-service, 72 h admin-issued); new token invalidates older ones; refused for deactivated accounts | `auth.test.ts` |
| Authorisation | Role × department scope checked server-side on every protected route (`server/src/authz.ts`); denials audited | `authz.test.ts`, `users.test.ts`, browser journey |
| Privilege escalation | Only admins change roles/departments/status/grants; strict request schemas reject unknown fields; requesters cannot ask for admin; self-demotion and last-admin removal blocked | `users.test.ts`, `access-requests.test.ts` |
| Input validation | Zod schemas on every body/query/param; DB CHECK constraints as a second line | `platform.test.ts` |
| Error handling | Generic 500 message; no stack traces in responses | `platform.test.ts` |
| Audit log | Append-only (DB triggers block UPDATE/DELETE/TRUNCATE); secrets stripped before writing | `platform.test.ts`, `auth.test.ts` |
| Security headers | Helmet defaults (HSTS, nosniff, frame-deny, etc.) | `platform.test.ts` |
| CORS | Explicit allow-list (`CORS_ORIGINS`) | manual check: unknown origin gets no allow header |
| Logging | Authorization header, cookies and password/token body fields redacted | code review |
| Secrets | None in source. `.env` is git-ignored; `.env.example` holds placeholders only | code review |

## Added in Phase 7

| Control | Implementation | Test evidence |
|---|---|---|
| Sign-in required everywhere by default | Global check before every route; only 8 listed public routes work without a sign-in, so a route that forgets its own check is still protected | `security.test.ts` (sweeps every route) |
| Review separation | Only the Asset Management Team / administrators review; only the owning department submits corrections; review history append-only (database trigger); costs hidden from people without financial access | `reviews.test.ts` |
| Readiness without data exposure | `/health/ready` reports only ok / not-ok per check | `security.test.ts` |
| Backups checkable | Manifest of row counts and file SHA-256; restores refuse to overwrite existing data | `backup.test.ts` |
| Secrets | Scan of the repository for keys and passwords: none found; `.env` ignored in the root and in `server/` | Phase 7 review |

### Dependency audit — 2026-10-31 (no critical advisories)

| Where | Advisory | Assessment | Action |
|---|---|---|---|
| App (ships in the app) | `decode-uri-component` ≤ 0.5.0, high — denial of service on crafted URLs, via Expo Router's `query-string` | Affects only the device opening a crafted link (the app can hang); no data exposure. The fixed version is not accepted by Expo Router 57 | **Upgrade to Expo SDK 58 before production** (`acceptance.md`) |
| App (build tools only) | `@expo/cli`, config plugins, `glob`, `minimatch`, `deepmerge`, nested `zod` — high/moderate/low | Run on developer and build machines, not in the app; inputs are the project's own files | Upgrade with the SDK; do not use `npm audit fix --force` (installs incompatible versions) |
| Server | `minimatch` (moderate, pattern denial of service) inside `exceljs` → `archiver` | Only used for folder-pattern zipping, which Excel export never calls; patterns never come from users | Accepted; re-check when `exceljs` updates |

## Added in Phase 6

| Control | Implementation | Test evidence |
|---|---|---|
| Replayed or duplicated requests | Every offline-capable write is processed once per operation id; an id cannot be reused by another user or for another action | `offline-sync.test.ts` |
| No blind overwrites | Offline edits that clash with newer changes are kept for review; resolving re-runs the edit with the reviewer's permissions | `offline-sync.test.ts`, browser journey |
| Reserved IDs | Usable once, only by the person who reserved them; at most 100 unused per person; reservations audited | `offline-sync.test.ts` |
| Device clock | Event times more than 5 minutes in the future are refused; old ones are flagged | `offline-sync.test.ts` |
| Shared phones | Saved actions are tied to the person who made them and never sent with another person's sign-in; sign-out warns, then removes saved work and cached data | `offline-sync.test.ts` |
| Offline start | Uses the account details saved at the last sign-in only to let work be saved; the server re-checks the sign-in before accepting anything | code review |

Data kept on phones (SQLite, app-private storage): the person's saved actions, photos waiting to upload, and cached
asset, location and category details for their departments. It is not encrypted beyond the phone's own storage
protection; a lost phone should be handled by deactivating the account (which revokes its sessions).

## Added in Phase 5

| Control | Implementation | Test evidence |
|---|---|---|
| Report and dashboard scope | Every query is limited to the departments the user may read; asking for another department is refused (403) and audited, for previews and exports alike | `reports.test.ts`, browser journey |
| Financial data in exports | Amounts for departments without financial access are shown as "Restricted" and left out of every total; they do not appear anywhere in the file | `reports.test.ts` |
| Access requests | Shown on the dashboard only to administrators | `reports.test.ts` |
| Spreadsheet formula injection | Text is written as text cells; a value beginning with `=` is never turned into a formula | `reports.test.ts` |
| Export auditing | Each PDF / Excel export is recorded with format, filters and row counts | `reports.test.ts` |
| Resource limits | Exports above `REPORT_MAX_ROWS` (default 20,000 per table) are refused with advice; previews return at most 50 rows per table | `reports.test.ts` |
| Download handling | Exports are sent as attachments with `Cache-Control: no-store` and `nosniff` | `reports.test.ts` |

## Help assistant (2026-11-01)

- **Help-only by design.** The server sends the AI service (Google Gemini by default, or Claude — `ASSISTANT_PROVIDER`) only the conversation the person typed (at most 20 messages of up
  to 2,000 characters) and their role name. No asset, user, department, audit or report data is sent, and the assistant
  has no tools, so it cannot read or change records. Its instructions are grounded in `docs/user-guide.md`.
- **Key on the server only.** `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` live in the server environment (`server/.env` in development,
  git-ignored; the hosting secret store in production). The app never sees it. Without a key the assistant is off.
- **Signed-in users only** (global sign-in rule, covered by the route sweep in `security.test.ts`); 20 questions per
  minute per client.
- **Privacy.** The audit log records `assistant.ask` with message count and usage, never the question or answer text.
  Questions are processed by the chosen provider under its API terms. **Gemini free tier: Google may use prompts and
  answers to improve its products** (paid tier: not used). Staff are told not to type passwords, links or personal data.
- **Failures** (bad key, rate limit, no connection) return plain messages; provider error text is never shown.

## Added in Phase 4

| Control | Implementation | Test evidence |
|---|---|---|
| Upload type checking | File type decided from its first bytes; a script named `.jpg` is refused (415) | `maintenance.test.ts` |
| Upload size limit | 5 MB per file (413), one file per request | `maintenance.test.ts` |
| Upload integrity | Optional `X-Content-SHA256`; mismatch refused | `maintenance.test.ts` |
| Private file serving | Download only after a department permission check; `nosniff`, sandboxing CSP; PDFs download, never render in the app's origin | `maintenance.test.ts` |
| No path tricks | Stored under random keys; display names stripped of paths and special characters | `maintenance.test.ts` |
| Separation of duties | Reporter cannot approve their own request; oversight roles cannot change requests | `maintenance.test.ts` |
| Financial data | Maintenance costs hidden from users without financial access | `maintenance.test.ts` |

## Added in Phase 3

| Control | Implementation | Test evidence |
|---|---|---|
| Fieldwork scoped to department | Verify / relocate / report missing only within the user's departments; transfers need permission in both | `verification.test.ts` |
| Oversight separated from fieldwork | Only the Asset Management Team / admins confirm or clear missing and resolve flags | `verification.test.ts` |
| Event integrity | Future times refused; older events never overwrite newer state; late events flagged; duplicates suppressed | `verification.test.ts` |
| QR content treated as data | Scanner accepts only university asset codes; other codes are reported, never opened | `shared/asset-codes.ts` tests |
| No third-party code at scan time | Web QR decoder self-hosted (`public/zxing/`); version drift caught by a test | `e2e/web-phase3.mjs` blocks all CDN requests during camera scans; `tests/labels.test.ts` |

## Added in Phase 2

| Control | Implementation | Test evidence |
|---|---|---|
| Department scoping of assets | Every asset query filtered by the user's department scope; direct access to another department's asset returns 403 and is audited | `assets.test.ts` |
| Financial data minimisation | Cost/currency/supplier/PO hidden (also in history) without `assets.read_financial` | `assets.test.ts` |
| QR content treated as data | Strict parser accepts only `UATS:<ID>` or a bare ID; scanning grants no access | `labels.test.ts`, `assets.test.ts` |
| Label HTML injection | Asset names and footer text HTML-escaped in printed labels | `labels.test.ts` |
| No physical deletion | Archive only; restore admin-only; full audit trail | `assets.test.ts` |
| Lost-update protection | Optimistic version check on edits; locked re-read inside transactions | `assets.test.ts` |
| Duplicate submissions | `X-Operation-Id` idempotency (per user) on asset creation; id claimed before work so simultaneous retries replay instead of failing | `assets.test.ts` |
| Cross-department disclosure via duplicate checks | Duplicate matches outside the user's read scope return only asset ID and department, never the name | `assets.test.ts` |

## Token storage on clients

- iOS/Android: `expo-secure-store` (Keychain / Android Keystore).
- Browser: `sessionStorage` (cleared when the tab closes). This is readable by script running on the page,
  so cross-site scripting must be prevented: the app renders no user-supplied HTML, and production hosting
  must serve a strict Content-Security-Policy (see `deployment.md`). HttpOnly cookies are a possible future hardening (D15).

## Production requirements (not verifiable in development)

- HTTPS only, with TLS terminated at the load balancer/proxy; set `TRUST_PROXY=true` behind it so rate limits use the real client IP.
- Database user for the API should not own the schema; grant it no UPDATE/DELETE on `audit_events`.
- Secrets supplied by the hosting platform's secret store, never in files committed to git.
- Run `npm audit` for both `package.json` files during each release.

## Known gaps / future work

- Multi-factor authentication (proposed enhancement, not in baseline).
- Email delivery is not configured; administrators issue reset links manually.
- Dependency audit (2026-10-31): **server production dependencies: 0 advisories** (exceljs pulls in an old `uuid`
  with a moderate advisory; `server/package.json` overrides it to `uuid@^11.1.1`, and Excel export is tested with it).
  Earlier audit (2026-10-28): App: 11 advisories
  (5 low, 3 moderate, 3 high, 0 critical), all inside the Expo SDK 57 toolchain (`@expo/cli`, `expo`,
  `expo-router`, and nested `zod`, `query-string`, `decode-uri-component`), not in code written for this project.
  Most are build/dev-server tooling, but `expo-router` ships in the app, so each must be reviewed and
  resolved by a later SDK patch before production (Phase 7). `npm audit fix --force` would install
  incompatible SDK versions and must not be used.
