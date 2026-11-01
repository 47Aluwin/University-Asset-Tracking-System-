# Implementation plan and progress

Each phase ends with its acceptance gate: tests run, failures fixed, docs updated, verified result recorded here.

| Phase | Scope | Gate (acceptance criteria) | Status |
|---|---|---|---|
| 0 | Discovery, architecture, hosting evaluation, data model, permissions, offline design | Architecture & plan documented; assumptions listed; environment reproducible | **Done** 2026-10-28 |
| 1 | Server, DB + migrations, auth, password reset, lockout, access requests, admin user management, role+department authorisation, audit log; client sign-in, request access, admin screens | Auth, provisioning, access restrictions, migrations, core security tests pass | **Done** 2026-10-28 (device testing pending) |
| 2 | Locations, categories, asset registration, barcode scan/manual, product lookup adapter, duplicates, ID allocation, QR, label templates/printing, attach-confirm, review & correction | Registration rules, ID uniqueness, reprint, review workflow tests pass | **Implemented 2026-10-28, awaiting review** — camera scanning added in Phase 3, review/correction in Phase 7; product lookup still open (no provider) |
| 3 | Verification scans, schedules, due/overdue, discrepancies, relocation + history | Verification states, schedules, history, discrepancy, permission tests pass | **Implemented 2026-10-29, awaiting review** — all tests pass |
| 4 | Condition history, damage + photos, maintenance workflow, costs, oversight | Department permissions, history, attachment access, transitions, costs pass | **Implemented 2026-10-29, awaiting review** — all tests pass |
| 5 | Five dashboard sections, four reports, PDF/XLSX exports | Figures reconcile with DB; exports valid; authorisation enforced | **Implemented 2026-10-31, awaiting review** — all tests pass |
| 6 | Offline queue, sync, ID blocks, conflicts, offline photos | Restart survival, duplicate prevention, conflict surfacing, timestamps correct | **Implemented 2026-10-31, awaiting review** — all tests pass; not yet tried on a phone |
| 7 | Hardening, security checks, backup/restore test, device & printer tests, ops docs, final acceptance | Critical criteria pass; risks documented; recovery tested | **Implemented 2026-10-31, awaiting review** — implementation-complete; production approval items in `acceptance.md` |

## Phase log

Results for each phase are appended below as they are verified.

### Phase 0 — Discovery and architecture (2026-10-28)

- Found an unmodified Expo SDK 57 template; no backend. No PostgreSQL or Docker on the machine; ~6.6 GB disk free.
- Chose Node/Fastify/PostgreSQL, with embedded PGlite for dev/test so the environment needs no database install.
- Documented: `architecture.md`, `data-model.md`, `access-control.md`, `hosting-comparison.md` (recommends managed
  cloud, with confirmations required), `offline-sync.md`, `requirements.md`, `decisions-and-limitations.md` (15 defaults).

### Phase 1 — Foundation and security (2026-10-28)

**Implemented**
- API: sign-in with progressive lockout; logout; `/auth/me`; change password; forgot/reset with single-use tokens;
  public access requests; admin approve/reject; admin user create (setup link), edit, deactivate/reactivate,
  unlock, reset link; cross-department scope grants; departments; settings; audit log viewer; rate limits; security headers.
- Database: migration `001_foundation.sql` (departments, users, access requests, sessions, reset tokens, scope grants,
  append-only audit log, settings, idempotency table).
- CLI: `migrate`, `create-admin`, `seed-dev` (refuses to run against production).
- App: sign-in, request access, forgot/reset password, home (role-aware), my account, access requests,
  users list/detail/new, departments, audit log. Session in SecureStore (native) / sessionStorage (web).
  Template demo screens removed.

**Files:** `server/**`, `src/app/**`, `src/lib/**`, `src/components/ui.tsx`, `src/constants/theme.ts`,
`src/hooks/use-color-scheme.web.ts`, `e2e/**`, `docs/**`, `README.md`, `.env.example`, `package.json`, `tsconfig.json`.

**Tests:** 54/54 server tests, 12/12 browser steps, typechecks, lint and expo-doctor all pass. See `testing.md`.

**Incomplete / unverified:** native device testing; production PostgreSQL driver path; email delivery.

**Security notes:** app toolchain has 11 upstream advisories (see `security.md`); server has none.

**Next — Phase 2 (asset registration and QR labels).** Acceptance: mandatory-field and currency/cost-policy validation;
institutional IDs unique under concurrent allocation; shared manufacturer barcodes allowed while serial duplicates are
flagged; QR payload stable across reprints; printing never creates an asset; registration only completes after
attachment + scan confirmation; review/return-for-correction preserves identity and records before/after values;
department scoping enforced on every asset endpoint.

### Phase 2 — Asset registration and QR labels (2026-10-28, awaiting review; not committed)

**Implemented**
- API: categories (admin), locations (per department; staff add their own), asset create with server-assigned
  IDs, duplicate-serial warning with audited override, idempotent create (`X-Operation-Id`), list with search,
  filters, sorting and pagination, details, edit with optimistic locking and before/after audit, label print
  and reprint records (reprint reason required), label-attachment confirmation, code lookup, archive ("delete")
  and admin restore, per-asset history, label-layout read endpoint.
- Database: migration `002_assets.sql`.
- Shared code: `shared/asset-codes.ts` (ID/QR formats, strict code parsing, money, dates),
  `shared/label-template.ts` (layout rules), `shared/labels.ts` (QR SVG + label sheet HTML).
- App: asset list, register, details (with QR and history), edit, label (preview, print, reprint, confirm),
  find by code, admin categories, admin label layout (presets, validation, test print). Home tiles.
- Web printing via a hidden frame; native printing via `expo-print`.

**Tests:** 90 server, 10 shared, 12 + 20 browser steps, typechecks, lint, web + Android bundles. See `testing.md`.

**Open against the brief's Phase 2 gate** (not requested in this round; proposed for a Phase 2b or folded into Phase 3):
- Post-registration review queue and return-for-correction workflow (Asset Management Team).
- Camera scanning of the manufacturer barcode and of the attached QR label (Phase 3 adds `expo-camera`).
- Product-information lookup (needs a licensed provider; manual entry works today).
- Physical printer and device tests (procedure in `qr-printing.md`).

### Phase 3 — Verification and relocation (started 2026-10-28; in progress, not committed)

**Implemented and tested (server)**
- Migration `003_verification_movement.sql`: verification schedules, verification events (event time and
  received time kept separately), movement events, missing status on assets, review flags, and the
  `asset_verification` view that derives due / overdue in the institution time zone.
- API: record verification (`POST /assets/:id/verifications`), relocation (`POST /assets/:id/movements`),
  histories, report / confirm / clear missing, review flags (`GET /flags`, resolve), schedules (admin).
- Rules: double scans within 10 minutes counted once; retries with the same operation id never recorded twice;
  future event times refused; older (offline-style) events never hide newer ones; events > 7 days late flagged;
  sightings elsewhere flagged as discrepancies; cross-department moves need permission in both departments and a
  reason, and are flagged; overdue never means missing; only oversight roles confirm or clear "missing".

**Screens (browser-tested):** Scan (camera or typed ID), Verify, Relocate, Review flags, Verification schedules,
asset-page verification/missing/history sections, asset-list verification and missing filters, home tiles with live
counts, and scanning the attached label to confirm registration.

**Fixes found during Phase 3**
- Asset pages could not be opened by address in the web build (dynamic routes are not pre-rendered with
  static output). Web output switched to single-page (`app.json` → `web.output: "single"`).
- App screens moved from `/assets/...` to `/inventory/...`: Expo reserves `/assets/*` for bundled images, so typed
  or refreshed `/assets/...` addresses never reached the app. API paths are unchanged.

- Web QR decoder self-hosted (D25), so browser scanning does not load code from a CDN.

**Tests:** 115 server, 12 shared, browser journeys 12 + 20 + 10 steps (two fake-camera scans with CDNs blocked). See `testing.md`.

**Open:** verify scanning on real phones and printed labels (no device available); production hosting must rewrite
unknown paths to `index.html` and allow WebAssembly in its CSP (see `deployment.md`).

**Next — Phase 4 (condition and department-managed maintenance).** Acceptance: condition history and damage reports
with photos; maintenance requests with configurable statuses, costs with currency, provider and outcome; an authorised
person confirms the resulting condition; department permissions; attachment access control.

### Phase 4 — Condition and department-managed maintenance (2026-10-29, awaiting review; not committed)

**Implemented**
- Migration `004_condition_maintenance.sql`: condition events, maintenance requests (with references `MR-<year>-<n>`),
  status history, cost lines (each with its own currency), attachments, and a per-department approval setting.
- API: update condition / report damage (optionally opening a request), condition history, maintenance requests
  (create, list, detail, status changes, completion, condition confirmation, costs), photo/PDF uploads and protected
  downloads.
- Rules: each department manages its own requests (no central maintenance team); the Asset Management Team and
  admins can see all but change nothing; statuses follow a fixed set of allowed moves; rejecting or cancelling needs a
  reason; completion needs the work performed and an outcome; **completion never changes the asset's condition** — a
  person confirms the resulting condition separately; optional per-department approval, never by the reporter; a
  policy change applies only to new requests; costs are never added across currencies; people without financial
  access see no costs; late condition records never overwrite newer ones.
- Uploads: up to 5 MB; JPEG, PNG, WebP or PDF identified from the file's contents (not its name); stored under random
  keys outside the web root; served only after a permission check, with `nosniff` and a sandboxing CSP; optional
  SHA-256 integrity check; file names cleaned of path tricks.
- App: Report damage / Update condition (photos via camera or library, optional maintenance request), Request
  maintenance, Maintenance list (open / closed, by department), request page (next steps, external provider,
  completion, condition confirmation, costs with per-currency totals, photos, status history), condition history and
  maintenance on the asset page, department approval switch, home tile with the open count.

**Tests:** 135 server (20 in `maintenance.test.ts`), 12 shared, browser journeys 12 + 20 + 10 + 9. See `testing.md`.

**Open / not verified:** taking photos with a real phone camera; opening PDF attachments on phones (listed, but
opened from the browser version for now); photos are not resized on the device beyond the picker's quality setting.

**Next — Phase 5 (dashboards and reports).** Acceptance: the five dashboard sections from live data with totals per
currency; the four reports with date/department filters; valid PDF and Excel exports; permissions enforced.

### Phase 5 — Dashboards and reporting (2026-10-31, awaiting review; not committed)

**Implemented**
- `GET /dashboard` with the five sections from the brief: (1) total assets and recorded value **per currency**,
  (2) verified / not yet verified / due / overdue, with reported and confirmed missing shown separately,
  (3) condition counts and outstanding maintenance (open requests by status and priority, damaged assets without a
  request, repairs awaiting a condition check, open repair costs per currency), (4) department-by-department
  summaries, (5) pending staff access requests (administrators only; others see "restricted").
  Filters: department, category, condition, verification period (30/90/180/365 days).
- `GET /reports/:kind` for the four reports — complete asset register; department inventory and value; verification
  and overdue assets; damaged assets, repairs and maintenance costs — as a JSON preview (first 50 rows per table, with
  the true total) or as **PDF** (pdfkit, A4 landscape, header row repeated on every page, page numbers) or **Excel**
  (exceljs; an "About" sheet with generation time, filters and notes, then one sheet per table with real numbers,
  dates and frozen, filterable headers). Date filters: acquisition date, due date, or reported date depending on the
  report. Every export is audited (`report.export`).
- App: Dashboard screen (cards open the matching filtered asset or maintenance list), Reports screen (preview,
  Download PDF, Download Excel, Print). Asset and maintenance lists accept those filters from links. Home screen has
  an Overview section. Phones save to the cache and open the share sheet (Excel) or print dialog (PDF).
- Status wording moved to `shared/status-labels.ts` so the app and exported files use the same words.

**Tests:** 151 server (16 in `reports.test.ts`), 12 shared, browser journeys 12 + 20 + 10 + 9 + 9. See `testing.md`.

**Open / not verified:** saving, sharing and printing exports on a real phone; opening the Excel file in Microsoft
Excel itself (verified by reading it back with exceljs); very large exports are refused above `REPORT_MAX_ROWS`
instead of being streamed; characters outside Western European languages print as "?" in PDFs (built-in fonts).

**Next — Phase 6 (offline operation and synchronisation).** Acceptance: queued operations survive restarts,
duplicate submissions are prevented, conflicts are surfaced, event times stay correct, offline photos sync.

### Phase 6 — Offline operation and synchronisation (2026-10-31, awaiting review; not committed)

**Implemented**
- Offline queue (`shared/offline-queue.ts`): each action is saved with a permanent operation id and the time it
  happened, sent oldest first when a connection is available, and kept through app restarts (SQLite `ats-local.db`
  on phones). Statuses: saved / sending / sent / server problem (retried with growing waits, max 1 hour) / not
  accepted (not retried automatically) / conflict. Actions can depend on earlier ones (a photo waits for its damage
  report; a label confirmation waits for the registration). An expired sign-in pauses sending; nothing is lost.
  One person's saved actions are never sent with another person's sign-in.
- Offline on phones: verify, relocate, update condition / report damage with photos, request maintenance, register
  assets (with a reserved ID, so the label is printed and confirmed offline with its final ID) and edit asset
  details. Assets, locations, categories and the label layout are kept on the phone for use offline. The app can
  start offline with the account details saved at the last sign-in; the server checks the sign-in again before
  accepting anything. Signing out warns about unsent work and then removes it and the cached data.
- Server: migration `005_offline_sync.sql` (`asset_id_reservations`, `sync_conflicts`); `POST/GET /assets/id-blocks`;
  `GET /sync-conflicts`, `POST /sync-conflicts/:id/resolve` (apply or discard, audited). Repeat protection
  (`server/src/idempotency.ts`) added to asset edits, label prints, label confirmation and photo uploads (the other
  actions already had it). Offline edits carry the values the phone saw; they are a conflict only if one of the
  changed fields was changed by someone else since, and are then kept for review — never applied blindly.
- App: "Waiting to sync" screen (status of every saved action, retry, remove, "different item — send anyway" for
  possible duplicates, side-by-side review of conflicts), home-screen banner, offline label screen. The web app stays
  online-only and says so when the connection is lost.

**Tests:** 166 server (15 in `offline-sync.test.ts`, which run the app's queue code against the real API),
12 shared, browser journeys 12 + 20 + 10 + 9 + 9 + 4. See `testing.md`.

**Not verified:** nothing has been run on a real phone in this environment — SQLite storage, airplane-mode
behaviour, the camera, photo storage and printing offline must be checked on a device (see `testing.md`).

**Next — Phase 7 (hardening and production readiness).**

### Phase 7 — Hardening and production readiness (2026-10-31, awaiting review; not committed)

**Done**
- **Missing feature built:** post-registration review and correction (brief §9), which had been deferred from Phase 2:
  migration `006_asset_review.sql` (review status separate from registration status; append-only `asset_reviews`),
  approve / return-for-correction with reason and flagged fields, department corrections with before/after values,
  re-review, review queue and home-screen tiles, asset-page review card with full history.
- **Security:** a global rule now refuses every route without a valid sign-in unless it is on an explicit public list
  (8 routes); a test sweeps all routes. Before this, some routes answered unauthenticated requests with validation
  or "not found" errors (low severity: let outsiders probe for record existence). Dependency audits assessed
  (`security.md`); secrets scan clean; root `.gitignore` now ignores `.env`.
- **Production database path:** the whole server suite also runs through the production `pg` driver
  (`npm --prefix server run test:pg-wire`).
- **Backups:** `npm run backup`, `npm run restore` (with a manifest check), `npm run cleanup-uploads`; restore drill
  performed on the development database; automated backup → restore → app-works test.
- **Monitoring:** `GET /health/ready` (database, pending migrations, file storage).
- **Performance:** measured at 100,000 assets (`server/scripts/perf.ts`); the asset list took 1.75 s and was rebuilt
  (now 0.06 s); the dashboard's verification figures now come from one pass (0.96 s → 0.65 s). All measured
  requests are under 1 s.
- **Documentation:** `operations.md`, `backup-recovery.md`, `user-guide.md`, `acceptance.md`; deployment checklist.

**Tests:** 180 server (embedded) / 178 + 2 skipped (production driver), 12 shared, 68 browser steps in 7 journeys.

**Not possible here:** phones, label printers, a real PostgreSQL server, SMTP, hosting. See `acceptance.md`.
