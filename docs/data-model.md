# Data model

PostgreSQL. All timestamps are `timestamptz` and stored in UTC; the client displays them in the
institution time zone (system setting `institution_time_zone`). Primary keys are UUIDs (`gen_random_uuid()`)
except the append-only audit log (`bigserial`). Migrations live in `server/migrations/`.

The **Phase** column shows when each table is created. Tables are not created before the phase that uses them.

## Entities

| Table | Purpose | Phase |
|---|---|---|
| `schema_migrations` | Applied migration versions | 1 |
| `faculties` | PNGUoT faculties (code, name, display order, active flag) | 007 |
| `departments` | Owning schools / departments / units (code, name, default currency, active flag, `faculty_id` — NULL = central administrative unit) | 1, 007 |
| `users` | Staff accounts: email, name, Argon2id hash, role, home department, status, lockout counters | 1 |
| `user_scope_grants` | Explicit, audited cross-department exceptions (read or operate), optional expiry | 1 |
| `access_requests` | Self-submitted requests: pending → approved / rejected; links to created user | 1 |
| `sessions` | SHA-256 hash of opaque session token, expiry, revocation reason | 1 |
| `password_reset_tokens` | SHA-256 hash, expiry, single-use `used_at` | 1 |
| `audit_events` | Append-only audit log (UPDATE/DELETE blocked by trigger) | 1 |
| `system_settings` | Key → JSON value (allowed email domains, time zone, policies) | 1 |
| `api_operations` | Processed client `operation_id`s and their stored result (idempotency) | 1 |
| `locations` | Building + room within a department | 2 |
| `asset_categories` | Configurable categories | 2 |
| `assets` | One row per physical asset (see below) | 2 |
| `asset_id_counters` | Safe institutional ID allocation | 2 |
| `asset_id_reservations` | IDs reserved by a phone for offline registration (used / unused, expiry) | 6 |
| `label_templates`, `label_print_events` | Configurable layouts; every print/reprint logged | 2 |
| `asset_reviews` | Post-registration review: approvals, returns for correction (reason, flagged fields), corrections (before/after) — append-only | 7 |
| `asset_field_changes` | Before/after values of material edits | 2 |
| `verification_schedules` | Interval rules by department and/or category | 3 |
| `verification_events` | Physical scans: event time, received time, location, outcome | 3 |
| `movement_events` | Relocations: from/to, reason, event time, received time, flags | 3 |
| `condition_events` | Condition/damage history | 4 |
| `maintenance_requests`, `maintenance_status_history`, `maintenance_costs` | Department-managed repairs | 4 |
| `attachments` | Photos/documents, checksum, owning record, storage key | 4 |
| `notifications` | In-app alerts, de-duplicated by key | 3–5 |
| `sync_conflicts` | Server version + proposed change + resolution | 6 |

## Key rules on `assets` (Phase 2 design)

- `institutional_id` — unique, e.g. `UAT-2026-000123`; **never reused**; separate from
  `manufacturer_barcode` (not unique; many units share it) and `serial_number`.
- `qr_payload` — unique, derived from the institutional ID (`UATS:UAT-2026-000123`), non-secret.
- Separate status columns, never one overloaded status:
  - `registration_status`: `draft` → `awaiting_label` → `registered` (also `retired`, `disposed`).
  - `review_status`: `not_reviewed` | `approved` | `returned_for_correction` | `corrected_awaiting_rereview`.
  - `verification_status` is **derived** from schedules + last successful verification, plus explicit
    `missing_status`: `none` | `reported_missing` | `confirmed_missing`.
  - Maintenance status lives on `maintenance_requests`, not on the asset.
- `current_condition` is a cached copy of the latest `condition_events` row; history is kept there.
- `current_location_id` / `owning_department_id` are cached from the latest accepted `movement_events`.
- Money: `acquisition_cost numeric(14,2)`, `currency char(3)` (ISO 4217) and
  `cost_status`: `recorded` | `verified_zero` | `unknown_exception` (exception needs reason + actor, audited).
  `CHECK`: a cost is present unless `cost_status = 'unknown_exception'`. Totals are always grouped by currency.
- Assets are never physically deleted; retirement/disposal/loss are status changes with audit events.

## Faculties and schools (implemented, `007_faculties.sql`, 2026-11-01)

- `faculties`: the six PNGUoT faculties are seeded (Engineering; Sciences; Natural Resources; Humanities; Built Environment;
  Postgraduate Studies, Research, and Innovation). Code and name are unique.
- `departments.faculty_id` → `faculties`. Schools are departments, so they keep owning assets, locations and access
  rights. The 13 schools are seeded under their faculties, plus a *Postgraduate Studies, Research and Innovation Office*
  under the postgraduate faculty (administrators add its research units). `faculty_id IS NULL` = a central administrative
  unit; *University Library* and *Student Support & Facility Centre* (SSFC) are seeded as central units. Seeding skips codes that already exist.
- An asset's faculty is **not stored on the asset**: it is always its owning school's faculty, so the two can never
  disagree. Moving an asset to another school (Relocate) moves it to that school's faculty; moving a school to another
  faculty moves its assets with it in every report.
- `assets.assigned_to` (optional text, 2–200 characters): the staff member responsible (custodian); they need not have an account.
- `assets.usage_status` ∈ in_use (default) / in_storage / not_in_use / awaiting_disposal — separate from registration,
  condition, missing and archive status.

## Phase 7 constraints (implemented, `006_asset_review.sql`)

- `assets.review_status` ∈ not_reviewed / approved / returned_for_correction / corrected_awaiting_rereview — separate
  from `registration_status`; only registered assets are reviewed; review never changes the ID or QR payload.
- `asset_reviews`: action ∈ approved / returned / corrections_submitted; a return needs a reason (≥ 5 characters);
  `fields` = fields flagged by the reviewer; `changes` = before/after of what the department corrected (taken from the
  audit log since the return). A trigger blocks UPDATE and DELETE (append-only).

## Phase 6 constraints (implemented, `005_offline_sync.sql`)

- `asset_id_reservations`: one row per reserved ID (format-checked primary key), who reserved it, on which device,
  expiry, and which asset used it (unique) — use time and asset are recorded together. Numbers come from the same
  yearly counter as online registration, so the two never overlap; unused numbers leave gaps (never reused).
- `sync_conflicts`: one per operation id; the server version must be newer than the edit's base version; proposed
  and server values stored as JSON; open / applied / discarded, with who decided and when.

## Phase 5 (no new tables)

Dashboards and reports read existing tables and the `asset_verification` view; nothing is stored except an
`audit_events` row (`report.export`) per export.

## Phase 4 constraints (implemented, `004_condition_maintenance.sql`)

- `condition_events`: append-only history of condition changes (source: condition_update, damage_report,
  maintenance_confirmation); a damage report requires a description. `assets.condition` is a cache of the newest event.
- `maintenance_requests`: status ∈ submitted / under_review / approved / in_progress / awaiting_parts /
  awaiting_external / completed / rejected / cancelled, with DB checks: completed ⇒ outcome, work performed, completer;
  rejected/cancelled ⇒ reason; condition confirmation only after completion. `requires_approval` is copied from the
  department when the request is created. `version` for optimistic locking.
- `maintenance_status_history`: every status change, who and when.
- `maintenance_costs`: amount > 0 with its own ISO currency; totals are computed per currency.
- `attachments`: owner (request or condition event), asset, department, cleaned file name, sniffed content type,
  size, SHA-256, random storage key.

## Phase 3 constraints (implemented, `003_verification_movement.sql`)

- `verification_events` and `movement_events` are append-only history; each stores `event_time` (when it happened,
  from the device) and `received_at` (when the server accepted it), and an optional unique `operation_id`.
- Assets cache the latest sighting (`last_verified_*`), updated only if the new event is newer.
- A move updates the asset's current location and department only if it is newer than the latest recorded move.
- `missing_status` ∈ none / reported_missing / confirmed_missing, kept separate from verification status.
- Verification status is **derived** by the `asset_verification` view, never stored: base date = last verification
  (or registration); due date = base + interval; "due" inside the warning window; "overdue" after the due date.
- `verification_schedules`: one active rule per department/category combination (partial unique index);
  `due_window_days < interval_days`.
- `asset_flags`: open / resolved; resolving requires a note; kinds: location_discrepancy, cross_department_move,
  reported_missing, found_after_missing, late_event.

## Phase 2 constraints (implemented, `002_assets.sql`)

- `assets.institutional_id` UNIQUE + format CHECK; `qr_payload` UNIQUE and CHECK `= 'UATS:' || institutional_id`.
- IDs come from `asset_id_counters` (one row per year, incremented atomically with `INSERT … ON CONFLICT DO UPDATE … RETURNING`). Numbers are never reused; archived assets keep theirs.
- `serial_number` NOT NULL but **not** unique (different manufacturers can repeat serials); duplicates are flagged by the API and confirmed by staff (audited).
- `manufacturer_barcode` indexed, never unique.
- `cost_matches_status` CHECK: `recorded` ⇒ cost > 0; `verified_zero` ⇒ cost = 0; `unknown_exception` ⇒ cost NULL and reason ≥ 5 chars.
- `acquisition_cost numeric(14,2)` + `currency char(3)`; the API handles money as decimal strings, never floats.
- `registration_status` ∈ draft (reserved for offline, Phase 6) / awaiting_label / registered; `registered_has_actor` CHECK.
- Archiving sets `archived_at/by/reason` (`archive_complete` CHECK); there is no physical delete endpoint.
- `version` increments on every change; edits must send the version they started from (optimistic locking).
- `locations` unique per department on (lower(building), lower(room)); `asset_categories` unique on lower(name).
- `label_print_events`: every print/reprint; reprints require a reason (CHECK).
- Settings added: `asset_id_prefix` (default `UAT`), `label_template`.

Deferred to later phases: review/correction tables, condition history (Phase 4), movement history (Phase 3).
Until then, department, location and condition of a **registered** asset cannot be edited (API returns
`USE_WORKFLOW`), so no history is silently overwritten.

## Phase 1 constraints (implemented)

- `users.email` stored lower-case, unique.
- `users.role` ∈ {`SYSTEM_ADMIN`, `ASSET_MANAGER`, `DEPARTMENT_STAFF`}; `CHECK` requires a department for `DEPARTMENT_STAFF`.
- `users.status` ∈ {`active`, `deactivated`}. Pending people exist only in `access_requests` and so cannot hold sessions.
- `access_requests.status` ∈ {`pending`, `approved`, `rejected`}; a partial unique index allows only one pending request per email.
- `audit_events`: trigger rejects UPDATE and DELETE.
- Tokens (session, reset) are stored only as SHA-256 hashes.

## Status definitions

| Concept | Values | Meaning |
|---|---|---|
| Account | active / deactivated | Deactivated accounts cannot sign in; all sessions revoked. |
| Access request | pending / approved / rejected | Only approved requests create accounts. |
| Registration | draft / awaiting_label / registered / retired / disposed | `registered` only after label attachment + scan confirmed. |
| Review | not_reviewed / approved / returned_for_correction / corrected_awaiting_rereview | Independent of registration. |
| Verification (derived) | not_yet_verified / verified / due / overdue | Never implies missing. |
| Missing | none / reported_missing / confirmed_missing | Set only by explicit, authorised action. |
