# Final acceptance (Phase 7, 2026-10-31)

Each item of the brief's Definition of Done (§26), with its status and evidence. As the brief requires,
**implementation completion is separated from production approval**: the system is implementation-complete in
this environment; production approval needs the items in the second table, which depend on the university.

Evidence: `docs/testing.md` (all results), the test files named below, and the browser journeys in `e2e/`.
Final run on 2026-10-31: **180 / 180** server tests (embedded database), **178 / 178** through the production
PostgreSQL driver (2 backup tests skipped: `pg_dump` not installed), **12 / 12** shared tests, **68 / 68** browser
journey steps (7 journeys), typecheck, lint and `expo-doctor` (21 / 21) clean.

## Definition of Done

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Frontend, backend and central database work together | **Met** (web); phones not run on a device | 7 browser journeys drive the real app against the real API and database |
| 2 | Authentication and combined role / department authorisation enforced | **Met** | `auth`, `authz`, `users` tests; `security.test.ts` sweeps every route (401 without sign-in except 8 listed public ones); department scope in every feature's tests |
| 3 | Department staff register assets with the defined workflow | **Met** | `assets.test.ts`; journey 2 |
| 4 | Every physical asset gets a unique institutional identity | **Met** | unique, never-reused IDs from one counter (also offline blocks); concurrent-registration test; `offline-sync.test.ts` |
| 5 | QR generation, reprinting, scanning, supported printing | **Met in browser**; physical printers and phone cameras **not verified** | QR decoded from screen and printed label in journey 2; camera scan with a fake camera in journey 3; printers: `qr-printing.md` procedure |
| 6 | Registration completes only after label attachment and confirmation | **Met** | `assets.test.ts` (print before confirm, wrong label refused, mismatch audited) |
| 7 | Review and correction preserve records and audit history | **Met** (built in Phase 7) | `reviews.test.ts`; journey 7 (return → correct → re-review; history with before/after; ID and QR unchanged) |
| 8 | Verification schedules, scans, discrepancies, movements | **Met** | `verification.test.ts`; journey 3 |
| 9 | Condition and department-managed maintenance | **Met** | `maintenance.test.ts`; journey 4 |
| 10 | Dashboard sections use real authorised data | **Met** | `reports.test.ts` reconciles every figure with hand-worked totals, linked lists and SQL; journey 5 |
| 11 | Four report categories generated and exported | **Met** | PDF and Excel read back and checked in `reports.test.ts` and journey 5 |
| 12 | Offline fieldwork and safe synchronisation | **Met against the real API**; **not run on a phone** | `offline-sync.test.ts` (restart survival, event times, ID blocks, photos, retries); journey 6 |
| 13 | Duplicate operations and conflicts handled safely | **Met** | every offline action resent with lost replies is recorded once; conflicts kept for review (`offline-sync.test.ts`, journey 6) |
| 14 | Automated backups and documented recovery procedures | **Met** (commands + procedure); scheduling depends on hosting | `npm run backup` / `restore`; `backup-recovery.md` |
| 15 | Restoration tested and recorded | **Met** in this environment | restore drill of the development database and `backup.test.ts` (app works on the restored copy) — `backup-recovery.md` §3 |
| 16 | Critical automated tests pass | **Met** | final run above; mutation checks show the tests catch broken rules |
| 17 | No unresolved critical security defect knowingly ignored | **Met** — no critical findings; high/moderate dependency advisories assessed and listed with actions | `security.md` (Phase 7) |
| 18 | Installation, configuration, migrations, testing, deployment, maintenance, recovery documented | **Met** | `README.md`, `deployment.md`, `testing.md`, `operations.md`, `backup-recovery.md`, `user-guide.md` |

## Needed before production approval

| Item | Why it is not done here | Owner / next step |
|---|---|---|
| Choose hosting; provision PostgreSQL, file storage, HTTPS | Institutional decision (D1) | University IT — `hosting-comparison.md` |
| Run the server suite against the real PostgreSQL server; test `pg_dump` / `pg_restore` there | No PostgreSQL server or client tools here | `npm --prefix server run test:pg-wire` style run with a real `DATABASE_URL`; backup-recovery.md §2 |
| Phone testing (Expo Go, then EAS builds): camera, offline mode, photos, printing, report sharing | No device here | Procedures in `testing.md` ("Not yet verified") |
| Label printers and label stock | No printer here | `qr-printing.md` |
| Email (password reset by email) | No SMTP credentials | Configure SMTP |
| Upgrade to the next Expo SDK (fixes the `decode-uri-component` advisory in Expo Router) | Major upgrade; not available as a patch | Before release — `security.md` |
| Confirm the open decisions (D1–D38 marked **Confirm**) | Policy decisions | University — `decisions-and-limitations.md` |
| Product lookup by barcode | No provider chosen or licensed | University — `decisions-and-limitations.md` |
| Use of the university's name and logo | Needs permission | University |
