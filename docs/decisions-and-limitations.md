# Decisions, assumptions, and known limitations

Each item says what was decided by default and whether the university needs to confirm it.
**Confirm** = needs an institutional decision before production. Defaults can be changed in settings or code.

## Unresolved decisions (defaults applied)

| # | Decision | Default applied | Confirm? |
|---|---|---|---|
| D1 | Hosting | Managed cloud PostgreSQL (see `hosting-comparison.md`) | **Confirm** |
| D2 | Institutional ID format | `UAT-<YYYY>-<6-digit sequence>`; year = registration year; department not embedded (assets move between departments) | Confirm prefix |
| D3 | QR payload | `UATS:<institutional ID>` — non-secret, no URL, no personal data | No |
| D4 | Donated assets with unknown cost | `cost_status = unknown_exception` with mandatory reason; audited; reported separately, never shown as 0. Setting `allow_unknown_cost` (default on) | **Confirm policy** |
| D5 | Currencies | ISO 4217 code per asset; department default currency; no conversion; totals per currency | Confirm list |
| D6 | Time zone | UTC storage; display zone setting `institution_time_zone` (default `UTC` until set) | **Confirm zone** |
| D7 | Allowed email domains for access requests | Setting `allowed_email_domains` (empty = any domain accepted, admin still approves) | **Confirm domain** |
| D8 | Verification due rule | `due_date = last successful verification (or registration date) + interval`; "Due" from `due_window_days` (default 14) before; "Overdue" after due date | Confirm intervals |
| D9 | Failed/duplicate scans | Only scans by an authorised user of a registered asset count; a repeat scan of the same asset by the same user within 10 minutes is recorded once | No |
| D10 | Maintenance approval | Off by default; each department may turn on an "Approved" step | Per department |
| D11 | Password policy | ≥ 12 characters, not equal to email; Argon2id | No |
| D12 | Lockout | 5 failed attempts → 15 min lock, doubling per further lock up to 24 h; per-IP rate limit on sign-in | No |
| D13 | Session lifetime | 12 h idle / 7 days absolute (browser); 30 days absolute (mobile, needed for offline fieldwork) | Confirm |
| D14 | Asset Managers doing fieldwork | Not by default; via audited scope grant | Confirm |
| D15 | Web token storage | `sessionStorage` (cleared when tab closes) + strict CSP; HttpOnly cookies are a future hardening option | No |
| D16 | "Delete asset" | Archive (soft delete) only; staff archive own unregistered records; admins archive registered assets and restore | Confirm |
| D17 | Who types the asset ID | Nobody: server assigns it on save (prevents duplicates and typing errors) | No |
| D18 | Label confirmation before camera scanning exists | Staff type the ID from the attached label; recorded as `method: manual`. Camera scanning added in Phase 3 | No |
| D19 | Editing location/department/condition after registration | Blocked until relocation (Phase 3) and condition history (Phase 4) exist, so history is not overwritten | No |
| D20 | Default label stock | A4, 3 × 7 labels 63.5 × 38.1 mm; 50 × 30 mm label-printer preset | **Confirm stock** |
| D21 | Schedules | None by default (nothing is due until an admin adds one). Most specific active rule wins: department + category, department, category, institution-wide | **Confirm intervals** |
| D22 | Double-scan window / late events | Same person, asset and place within 10 minutes = one verification, unless the asset was moved or marked missing in between; events reported > 7 days late are flagged | No |
| D23 | Cross-department relocation | Allowed only with movement permission in both departments, a reason is required, ownership moves with the asset, and the move is flagged for review | Confirm |
| D24 | Missing | Staff report; only the Asset Management Team or admins confirm or clear; scanning the asset marks it found and flags it | No |
| D25 | Web QR decoding | **Fixed 2026-10-29.** The decoder (`zxing_reader.wasm`) is served by the app itself from `public/zxing/` (`src/lib/barcode-setup.web.ts`), not downloaded from a CDN. After upgrading expo-camera run `npm run sync:zxing`; a shared test fails if the copy drifts | No |
| D27 | Maintenance approval | Off by default; an admin can require it per department. Approver must not be the reporter. Applies only to requests created after the change | Per department |
| D28 | Attachments | Photos (JPEG/PNG/WebP) and PDFs, up to 5 MB (`MAX_UPLOAD_MB`), checked by content; up to 5 photos per report in the app; stored in `UPLOAD_DIR` | Confirm limits |
| D29 | Who confirms condition after repair | Any member of the owning department with maintenance permission, as a separate step after completion | Confirm |
| D30 | Asset value on the dashboard | Sum of recorded acquisition costs of all non-archived records (including those awaiting a label), per currency; verified-zero and unknown-cost assets counted, not valued | **Confirm** |
| D31 | Verification report date filter | Filters on the due date (to plan checks); asset register and department reports filter on acquisition date; maintenance on the reported date | Confirm |
| D32 | Export size limit | `REPORT_MAX_ROWS` = 20,000 rows per table; larger exports are refused with advice to narrow filters | Confirm |
| D33 | Report formats | PDF (A4 landscape) and Excel (.xlsx); printing via the PDF. No CSV | No |
| D34 | Offline scope | Phones only: verify, relocate, condition / damage with photos, maintenance requests, registration with label, edits. Approvals, costs, reviews and administration stay online. Web is online-only | Confirm |
| D35 | Offline ID blocks | 20 IDs per phone, topped up below 5; 30-day expiry; at most 100 unused per person | Confirm |
| D37 | Review after approval | Edits to an approved record do not send it back for review (avoids routine bottlenecks); all edits stay in the history | Confirm |
| D38 | Recovery objectives | Recovery time 4 hours; recovery point 24 hours (daily backup), or minutes with the managed database's point-in-time recovery | **Confirm** |
| D39 | Faculty structure | Six faculties and their schools seeded from the university's list; schools are departments linked to a faculty; units outside the faculties (Library, SSFC) are "Central administration". Faculty is derived from the school, never stored separately | Confirm |
| D40 | Seeded unit names | Central units: University Library; Student Support & Facility Centre (SSFC). The postgraduate faculty starts with one office unit — its research centres are added by administrators; seeded schools default to PGK | **Confirm** |
| D41 | Asset status and custodian | "Asset status" = In use / In storage / Not in use / Awaiting disposal; "Assigned staff member" is free text (the person may have no account). Asset ID is still assigned by the system, never typed | Confirm |
| D42 | Help assistant | Help-only (no access to records), answered through the server by the AI service in `ASSISTANT_PROVIDER`: **Google Gemini** (`gemini-3.5-flash-lite`, free tier) by default, or Claude (`claude-haiku-5-5`, needs prepaid credit). Off until that service's key is set; its home-screen tile is hidden while off; online only. On Gemini's free tier Google may use prompts to improve its products — acceptable only because the assistant never receives records, but production should use a paid tier or an approved provider | **Confirm** (provider, data-processing approval) |
| D36 | Offline edit conflicts | A conflict only when a changed field was changed by someone else; decided by the asset's department (or an administrator) | Confirm |
| D26 | Web build / routes | Single-page web build (hosting must rewrite all paths to `index.html`); app screens at `/inventory/...` because `/assets/*` is reserved by Expo | No |

## External services not available in this environment

| Service | Status | Next step |
|---|---|---|
| Product lookup by barcode | No provider configured. Candidates: GS1 (authoritative, membership-based access), UPCitemdb (commercial API, rate-limited), Open Food/Products Facts (consumer goods, poor coverage of lab/IT equipment). None verified. | University to choose and license a provider; implement adapter in `server/src/integrations/product-lookup.ts`. |
| Email (SMTP) | Not configured. Dev: reset links printed to server console. Prod without SMTP: admins issue reset links. | Provide SMTP credentials via env vars. |
| Production PostgreSQL | Not provisioned. | See `deployment.md`. |
| Object storage | Not provisioned; dev uses local disk. | Provision S3-compatible bucket. |
| Physical devices / printers | Not available to the developer. Device and printer results are **unverified** until tested. | Follow test procedures in `testing.md` / `qr-printing.md`. |

## Known limitations

- Expo Go cannot be used for production; production mobile builds require EAS Build and signing credentials.
- The browser build cannot reliably scan barcodes on all browsers; manual entry is provided.
- Dedicated thermal-printer SDKs are not integrated; printing goes through the OS print system.
- Still open from the brief's Phase 2: product lookup by barcode (no provider chosen) and a date picker (dates are
  typed as YYYY-MM-DD). Camera scanning was added in Phase 3 and the review/correction workflow in Phase 7.
- Two people registering the same serial number at the same instant may both pass the duplicate check
  (serials are deliberately not unique in the database); such pairs are visible by searching the serial.

## Visual theme

Colours follow the university website (www.pnguot.ac.pg, read 2026-10-28): maroon `#4E0530` header bars,
crimson `#A51C30` headings and main buttons, navy `#293352` secondary buttons, Roboto font on web.
Defined in `src/constants/theme.ts`. The university's logo and name are **not** used, so the app is not
presented as an official university product; adding them needs the university's permission. Printed QR
labels stay black on white for reliable scanning.

## Phase 4 limitations

- PDFs attached to a request open from the browser version; phones list them but cannot download private files yet.
- The app picks photos at 60% quality to keep them small but does not resize them; very large camera images are
  refused by the 5 MB limit with a clear message.
- If a photo upload fails after a report is saved, the report is kept and the screen says which photos failed;
  they can be added again from the request page. (Offline photo queueing is Phase 6.)
- A file is written to storage before its database row; a failure between the two can leave an unreferenced file
  (harmless, not served). A clean-up job is a Phase 7 item.

## Phase 5 limitations

- PDFs use the built-in Helvetica font, which covers Western European characters only; other characters print as
  "?" (Excel files are not affected). Embedding a Unicode font is a small change if needed.
- Exports are built in memory and are limited by `REPORT_MAX_ROWS`; streaming very large exports is not implemented.
- Dashboard figures are calculated on each request (no caching). Performance at 100k assets is a Phase 7 check.
- Changes made offline on a phone appear only after they synchronise (Phase 6); the dashboard says this.

## Phase 6 limitations

- Not yet tried on a real phone (none available here). The queue is tested against the real API; device storage,
  airplane mode, camera and printing offline need a manual check (procedure in `testing.md`).
- Phones keep up to 1,000 of the person's assets for offline lookup; others can be opened only online.
- Phones do not yet send a SHA-256 checksum with photos; uploads are still type- and size-checked by the server.
- Maintenance status changes, costs, approvals and reviews are online-only.

## Phase 7 limitations

- Production hosting, a real PostgreSQL server, phones, label printers and SMTP were not available; the related checks
  are listed in `acceptance.md` under "Needed before production approval".
- Expo SDK 57 carries dependency advisories that need the SDK 58 upgrade (`security.md`).
- Performance was measured on the embedded database on a laptop, not on the production server.
