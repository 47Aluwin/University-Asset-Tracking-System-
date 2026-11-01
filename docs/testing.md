# Testing

## How to run

| Suite | Command | What it uses |
|---|---|---|
| API + database (unit and integration) | `npm run server:test` | Node test runner; each file gets a fresh in-memory PostgreSQL 18 (PGlite) with all migrations |
| Type checks | `npm run server:typecheck` and `npm run typecheck` | TypeScript strict mode |
| Lint | `npx expo lint` | eslint-config-expo |
| Dependency health | `npx expo-doctor` | Expo SDK compatibility checks |
| Shared code (QR, labels, money, dates) | `npm run test:shared` | Node test runner; QR output decoded with `jsqr` |
| Browser journeys | `npm run test:e2e` (all) or `sh e2e/run.sh web-phase2.mjs` | Exported web app + real API + headless Edge/Chrome via `puppeteer-core` (no browser download); fresh dev database per journey |

## Results log

### Phase 1 — 2026-10-28 (Windows 11, Node 24.19, Edge headless)

| Suite | Result |
|---|---|
| `server` tests | **54 / 54 passed** (`authz` 7, `auth` 13, `access-requests` 11, `users` 13, `platform` 10) |
| Server typecheck | passed |
| App typecheck | passed |
| Lint | passed (0 problems) |
| `expo-doctor` | 21 / 21 checks passed (after applying 3 patch updates) |
| Browser journey (`e2e/web-phase1.mjs`) | **12 / 12 steps passed**: setup link → reuse refused → wrong password → admin sign-in → access request at phone width → pending sign-in refused → approve → staff sign-in without admin tools → direct admin URL refused by server → deactivate → staff signed out and refused → audit entries visible |
| Manual HTTP smoke test | health, setup link, sign-in, `/auth/me`, access request, pending sign-in, CORS allow/deny all behaved as expected |

**Mutation check:** to confirm the tests can fail, two rules were deliberately broken. Widening department
staff to all departments made 6 tests fail. Removing session revocation on deactivation was at first
**not** caught, because deactivated users are also blocked by a status check on every request. A
database-level assertion was added so the test now fails if revocation is removed. Both rules were restored.

**Bug found by running for real (not by tests):** the embedded database failed to start when its parent
folder did not exist. Fixed in `server/src/db.ts`.

### Phase 2 — 2026-10-28 (Windows 11, Node 24.19, Edge headless)

| Suite | Result |
|---|---|
| `server` tests | **90 / 90 passed** — Phase 1's 54 unchanged + 36 new in `assets.test.ts` (reference data 2, registration 10, duplicates 4, permissions 4, editing 5, labels/confirmation 4, archiving 3, listing 1, settings 3) |
| Shared tests (`tests/labels.test.ts`) | **10 / 10 passed**, including decoding the generated QR SVG with an independent reader |
| Server + app typecheck, lint | passed (0 problems) |
| Web build (`expo export --platform web`) | passed |
| Android bundle (`expo export --platform android`) | compiled to Hermes bytecode — shows native code resolves; **not run on a device** |
| Browser journey Phase 1 (regression) | 12 / 12 passed |
| Browser journey Phase 2 (`e2e/web-phase2.mjs`) | **20 / 20 passed**: category → staff account → validation messages → registration with server ID → on-screen QR decoded from pixels → label document captured from the print dialog, rendered and decoded → reprint requires reason, same code → wrong label refused → correct code registers → edit shows before/after → duplicate serial warning and override → search/filter → find by code → staff cannot archive registered → admin archives, archived filter → label-printer preset and QR-size validation → audit log |

**Mutation check:** breaking (1) department filtering of the asset list, (2) the admin-only rule for archiving
registered assets, and (3) the `asset.update` audit record each made the asset tests fail; restored code passes.

#### Pre-commit review — 2026-10-28

All three commands were run before and after the review fixes:

| Command | Before fixes | After fixes |
|---|---|---|
| `npm run server:test` | 90 / 90 | **93 / 93** (3 new regression tests) |
| `npm run test:shared` | 10 / 10 | **11 / 11** (1 new) |
| `npm run test:e2e` | 12 / 12 + 20 / 20 | **12 / 12 + 20 / 20** |

Typechecks (app, server) and lint also pass. Issues found by code review and fixed:

1. **Security — duplicate warnings leaked other departments' asset names.** `POST /assets/check-duplicates` and the
   duplicate-serial 409 response returned the name of matching assets in departments the user cannot read, so any
   registrar could probe serial numbers. Now only the asset ID and department are returned for such matches.
2. **Bug — simultaneous retries with one operation id** could make the second request fail with a 500 on PostgreSQL.
   The operation id is now claimed first (`INSERT … ON CONFLICT DO NOTHING`), so duplicates wait and then replay.
   A failed (e.g. invalid) attempt does not consume the id.
3. **Bug — labels could be printed without the human-readable asset ID** when the QR filled the label width, making
   manual confirmation impossible. Layouts must now leave ≥ 12 mm for text, and the ID is always printed.
4. **Bug — browser print frame removed after 1 s.** In browsers whose `print()` returns before the dialog closes,
   the document could disappear mid-print. The frame now stays until `afterprint` (5-minute fallback).
5. **Test defect — two tests hard-coded the year 2026** in expected IDs and would fail from 2027. They now use the current year.
6. Usability: the registration form now shows "Loading locations…" instead of an empty area.

The new tests were mutation-checked: re-introducing issue 1 or 3 makes them fail.

**Bugs found while testing:** (1) a label-mismatch audit entry was written inside the transaction that the
error then rolled back, so it was lost — now written outside the transaction; (2) permission denials inside
transactions would have blocked on the embedded database — all asset permission checks now run before the
transaction, with a locked re-read and version check inside.

### Phase 3 — 2026-10-29

| Suite | Result |
|---|---|
| `server` tests | **115 / 115 passed** — 21 in `verification.test.ts` (scans 9, schedules 5, relocation 4, missing & flags 3) |
| Shared tests | 12 / 12 passed (new: self-hosted QR decoder matches the installed library) |
| Server + app typecheck, lint | passed (after regenerating typed routes for the `/inventory` rename) |
| Browser journeys | **Phase 1 12 / 12, Phase 2 20 / 20, Phase 3 10 / 10** |

Phase 3 journey: schedule created in the UI → "not yet verified" with due date → find by typed code → verify at a
different room (discrepancy shown) → flag resolved in Review → relocation with history → report and confirm missing →
a scan marks it found and raises a "found after missing" flag → overdue asset listed under "Due and overdue" with
days overdue → **camera scan**: headless Edge with a fake camera playing a video of the asset's QR label; the scan
screen decoded it and showed the right asset (no typing) → **label confirmation by camera**: scanning a freshly
printed label completed registration, recorded as "QR code scanned". During both camera steps every request to a
public CDN is blocked and recorded; the scans succeed and the decoder is loaded from `/zxing/zxing_reader.wasm`.

Deep links (e.g. `/inventory/<id>`) load correctly with the single-page build. Browser tests now serve the build with
`e2e/spa-server.mjs`, which behaves like production single-page hosting (`npx expo serve` has no index.html fallback).

**Bug found by the Phase 3 journey:** the double-scan rule ("same person, asset and place within 10 minutes counts
once") also swallowed a scan of an asset that had been moved or reported missing in the meantime, so a missing asset
was not marked found. Repeat scans are now ignored only if the asset was not moved and is not missing; a regression
test reproduces the original bug.

**Mutation check:** letting an older scan overwrite a newer one, counting double scans twice, and allowing staff to
confirm "missing" each made the Phase 3 tests fail; restored code passes.

The time-zone test is deterministic: a verification at 20:00 UTC on 10 January gives a due date of 9 February in UTC
and 10 February in Port Moresby (UTC+10).

### Phase 4 — 2026-10-29

| Suite | Result |
|---|---|
| `server` tests | **135 / 135 passed** — 20 in `maintenance.test.ts` (condition 5, workflow 7, costs 2, attachments 4, oversight 2) |
| Shared tests | 12 / 12 passed |
| Typecheck, lint, `expo-doctor` | passed (21 / 21) |
| Browser journeys | Phase 1 12 / 12, Phase 2 20 / 20, Phase 3 10 / 10, **Phase 4 9 / 9** |

Phase 4 journey: report damage with a real JPEG chosen through the photo picker and open an urgent request in one
step → the photo is shown in the condition history after loading through the protected endpoint → start work → send
to an external provider → costs in USD and PGK shown as "PGK 300.00 + USD 120.50 (different currencies are not added
together)" → completion leaves the asset "damaged" → a person confirms "good", which enters the condition history →
an admin turns on approval for the department; the reporter's own approval is refused (403); another person approves
→ open and closed request lists.

**Mutation check:** making completion silently set the asset's condition, allowing self-approval, and accepting any
file as a JPEG each made the Phase 4 tests fail; restored code passes.

**Found while testing:** a request opened from a damage report did not show the report's photos on the request page;
it now does (still permission-checked). A test-only issue (checkbox vs. radio selector) was fixed in the journey.

### Phase 5 — 2026-10-31

| Suite | Result |
|---|---|
| `server` tests | **151 / 151 passed** — 16 in `reports.test.ts` (dashboard 5, reports 7, exports 3, large result sets 1) |
| Shared tests | 12 / 12 passed |
| Typecheck (app, server), lint, `expo-doctor` | passed (21 / 21) |
| Browser journeys | Phase 1 12 / 12, Phase 2 20 / 20, Phase 3 10 / 10, Phase 4 9 / 9, **Phase 5 9 / 9** |

**Reconciliation (the Phase 5 gate):** the fixture has assets in two departments and two currencies (USD, PGK),
an overdue, a due, two verified and two never-verified assets, one reported missing, one damaged asset with an open
request and costs in both currencies, one completed repair awaiting confirmation, and one pending access request.
The test checks every dashboard figure against (a) totals worked out by hand, (b) the asset and maintenance lists
the cards link to, with the same filters, and (c) an independent SQL query for the money totals. The four
verification groups add up to the number of registered assets.

Exports: the Excel file is read back with exceljs (sheet names, header labels, numbers stored as numbers with
`#,##0.00`, dates as dates, per-currency totals, and an asset named `=HYPERLINK(...)` stored as text, not a
formula). The PDF is checked for a valid header and trailer, its text is extracted from the compressed page
streams, it must contain the title, filters, records and one "Page i of N" footer per page, and a short report must
be exactly one page. Empty results export with an explanation. With `REPORT_MAX_ROWS=100`, a 101-row export is
refused with advice to narrow the filters, while the preview still shows the true total.

Phase 5 journey: dashboard shows the five sections and the API's figures (USD 5,500.50 and EUR 900.00 shown
separately, never added) → the "Awaiting label: 1" card opens a list with exactly that asset → department filter →
phone width (390 px) without sideways scrolling → report preview with filters, empty result and date validation →
**Excel downloaded through the app's own download code** and read back → PDF downloaded and Print opened in a new
tab → department staff see only their department; the server refuses an export for another department (403).

**Mutation check:** adding currencies together, removing the department limit from reports, showing costs without
financial access, and the blank-page PDF bug below each made the Phase 5 tests fail; restored code passes.

**Found while testing:** looking at a generated PDF showed (1) a one-page report came out as three pages, because the
page-number footer sat inside the bottom margin and started new pages, and (2) bullets printed as "?". Both fixed and
now covered by tests. The maintenance report also failed on its first run (an unused query parameter) — fixed before
the suite was recorded.

### Phase 6 — 2026-10-31

| Suite | Result |
|---|---|
| `server` tests | **166 / 166 passed** — 15 in `offline-sync.test.ts`; one Phase 2 test updated (a client-chosen asset ID is now refused as "not reserved by you" instead of as an unknown field) |
| Shared tests | 12 / 12 passed |
| Typecheck (app, server), lint, `expo-doctor` | passed (21 / 21) |
| Browser journeys | Phase 1 12 / 12, Phase 2 20 / 20, Phase 3 10 / 10, Phase 4 9 / 9, Phase 5 9 / 9, **Phase 6 4 / 4** |

`offline-sync.test.ts` runs the app's own queue code against the real API, with storage written to a file so a
"restart" is a new queue reading the same file. It covers the gate:
- **Restart survival:** a scan, a damage report and its photo saved offline; the app "killed" mid-send; a new queue
  finds all three waiting and sends them. The device event time is stored, the server's receive time separately.
- **Duplicate prevention:** with every reply lost, nine kinds of action (scan, move, condition, photo, maintenance
  request, edit, registration with a reserved ID, label print, label confirmation) are each sent repeatedly; each is
  recorded exactly once, and the edit causes no false conflict. Two copies sent at the same moment create one record;
  an operation id cannot be reused by someone else.
- **Conflicts surfaced:** an offline edit to an asset changed meanwhile becomes a conflict; the newer value is kept;
  resending does not create a second conflict; staff of the department can apply or discard it; the Asset
  Management Team can see but not decide; other departments cannot see it; decisions are audited.
- **Event times:** a time 10 minutes in the future is refused and not retried; a 10-day-old scan is accepted and
  flagged as late.
- Also: reserved ID blocks (no overlap with online registration, single use, only by the person who reserved them,
  limit of 100 unused per person, fall-back to a server-assigned ID), a damaged photo refused by checksum, actions
  depending on a refused one held back and sent after the fix, server errors retried with growing waits, an expired
  sign-in pausing sending.

Phase 6 journey (web): losing the connection while verifying shows "Cannot reach the server" and records nothing;
back online the same button records it once; a phone's clashing edit is shown side by side on "Waiting to sync" and
applied; a second one is discarded, keeping the current values.

**Mutation check:** a new operation id on each retry, removing repeat protection from label prints, applying offline
edits blindly, and not resuming an interrupted send after a restart each made the Phase 6 tests fail; restored code
passes.

**Found while testing:** a phone that relocated an asset and then edited its notes offline got a false conflict,
because its own relocation had changed the asset's version. Edits now carry the values the phone saw, and only a
change to the same fields counts as a conflict.

### Phase 7 — 2026-10-31 (final acceptance run)

| Suite | Result |
|---|---|
| `server` tests, embedded database | **180 / 180 passed** — new: `reviews.test.ts` 7, `security.test.ts` 5, `backup.test.ts` 2 |
| `server` tests through the production `pg` driver (`npm --prefix server run test:pg-wire`) | **178 passed, 2 skipped** (the embedded-database backup tests; `pg_dump` is not installed) |
| Shared tests | 12 / 12 passed |
| Typecheck (app, server), lint, `expo-doctor` | passed (21 / 21) |
| Browser journeys | **68 / 68 steps**: Phase 1 12, Phase 2 20, Phase 3 10, Phase 4 9, Phase 5 9, Phase 6 4, **Phase 7 4** |

**What `test:pg-wire` proves:** the production database code (`pg` connection pool, wire protocol, parameter and type
handling, transactions) works for every feature, by exposing the embedded database on a local socket. It does not
prove isolation between simultaneous transactions (the socket shares one session) or behaviour specific to a
PostgreSQL server — that still needs a real server.

**Security sweep (`security.test.ts`):** every one of the API's routes is called with no sign-in and with a made-up
token; all answer 401 except the 8 public routes (health checks, the public department list, sign-in, password reset,
access requests), which still work. Unknown websites get no CORS access; security headers present; search text with
SQL fragments returns nothing and leaves the tables intact; a 2 MB request body is refused (413).

**Backup and restore:** automated (`backup.test.ts`: the app signs in on the restored copy, opens the asset,
downloads the photo byte-identical, the audit log is still protected, the next ID continues the sequence; a missing
file is detected) and a manual drill on the development database (`backup-recovery.md` §3).

**Performance at 100,000 assets** (`node server/scripts/perf.ts 100000`, embedded database on this laptop, median of 5):

| Request | Before | After |
|---|---|---|
| Asset list, first page | 1,750 ms | **57 ms** |
| Asset search by text | 212 ms | 404 ms |
| Find by asset code | 11 ms | 10 ms |
| Overdue list | 815 ms | **479 ms** |
| Dashboard, all departments | 929 ms | **650 ms** |
| Dashboard, one department | 220 ms | 150 ms |
| Report preview: asset register / verification | 383 / 744 ms | 380 / 717 ms |
| Excel export, one department (5,000 assets) | 682 ms | 668 ms |

All are under the 1 s target (NFR-4). The embedded database is single-threaded WebAssembly; a PostgreSQL server is
expected to be faster, but this was not measured.

**Mutation check:** letting department staff review records, and recording corrections without their before/after
values, each made the review tests fail; removing the global sign-in rule made the security sweep list the routes
that answered without a sign-in. Restored code passes.

**Found in Phase 7:** the review workflow (brief §9) had never been built; several routes answered unauthenticated
requests with validation errors; the asset list was too slow at 100,000 assets, and requesting a page past the end
reported a total of 0. All fixed.

### Faculties and schools — 2026-11-01 (Expo SDK 58, Windows 11, Node 24.19, Edge headless)

PNGUoT faculty → school / department classification (`007_faculties.sql`), assigned staff member, asset status.

| Check | Result |
|---|---|
| Server tests (embedded database) | **187 / 187** (7 new in `faculties.test.ts`: seeded faculties and schools with their links, Library and SSFC as central units, admin-only faculty changes with audit, faculty saved and kept on edit, new fields, faculty / central / status filters and staff scope, dashboard faculty totals reconciled with SQL and adding up to the overall total, faculty report tables and columns, PDF export) |
| Shared tests | 12 / 12 |
| Typecheck, lint | clean (after the SDK 58 upgrade's React Native 0.88 type changes were fixed) |
| `expo-doctor` | 20 / 20 |
| New browser journey `web-faculties.mjs` | **9 / 9**: faculty first; schools limited to the chosen faculty; school (and rooms) reset when the faculty changes; both lists searchable; registration with faculty, school, building, room, assigned staff member and status; details and edit keep the faculty; list filter and search by assigned staff member; dashboard distribution and value by faculty; report faculty filter and tables; phone width (390 px) with no sideways scrolling |
| Earlier journeys, re-run | phases 1, 3, 5, 6, 7 passed unchanged; phases 2 and 4 needed test updates for reworded text and the new grouping of the departments page, then passed (20 / 20 and 9 / 9) |

### Not yet verified

| Item | Why | Next step |
|---|---|---|
| iOS / Android app on a device | No device or emulator available in this environment | Run `npx expo start`, open in Expo Go, repeat the browser journey steps manually; record results here |
| Production PostgreSQL server | No PostgreSQL server available. The `pg` driver path is now tested against PGlite over the wire protocol (`test:pg-wire`), which does not prove isolation between simultaneous transactions or server-specific settings | Run the suite against a real PostgreSQL test database; run `pg_dump` / `pg_restore` there (`backup-recovery.md`) |
| Email delivery | No SMTP configured | Configure SMTP; test forgot-password end to end |
| HTTPS / proxy headers | No deployment yet | Phase 7 |
| Physical label printing (sheet printer, thermal printer), alignment, phone-camera scanning of printed labels | No printer, label stock or phone available | Follow the procedure in `qr-printing.md`; record printer model, stock and results here |
| iOS / Android printing via `expo-print` | No device | Print a label from Expo Go on each platform |
| Report export on phones (share sheet, print) | No device | Export each report as PDF and Excel from Expo Go; open the Excel file; print the PDF |
| Offline fieldwork on a phone | No device | In Expo Go: sign in online, then airplane mode; verify, relocate, report damage with photos, register an asset and print its label; close and reopen the app; turn the connection back on and check "Waiting to sync" empties and the records appear with the right times |
| Excel files in Microsoft Excel / LibreOffice | Not installed here; files were verified by reading them back with exceljs | Open each export and check formats and totals |

## Coverage map (brief §24) — Phase 1 items

| Brief test | Where |
|---|---|
| Permission decisions (unit) | `authz.test.ts` |
| Authentication and authorisation (integration) | `auth.test.ts`, `users.test.ts`, `access-requests.test.ts` |
| Admin creates a staff account (E2E) | `users.test.ts` (API) |
| Staff requests access and awaits approval (E2E) | `access-requests.test.ts` (API) + browser journey |
| Unauthorised cross-department access | `authz.test.ts`, `users.test.ts` (grants); asset-level checks come in Phase 2 |
| Account deactivation prevents access (E2E) | `users.test.ts` + browser journey |
| Unauthorised API access / invalid or expired tokens | `auth.test.ts` |
| Repeated failed sign-in | `auth.test.ts`, `platform.test.ts` (rate limit) |
| Privilege escalation | `users.test.ts`, `access-requests.test.ts` |
| Input-validation failures | `platform.test.ts` |
| Secrets in logs / audit | `auth.test.ts` (audit contents), log redaction config |
| Unauthorised modification of audit history | `platform.test.ts` |
| Database migration behaviour | `platform.test.ts` |
