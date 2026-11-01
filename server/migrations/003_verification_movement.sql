-- Phase 3: physical verification, recurring schedules, missing status, relocation history, review flags.

-- Recurring verification rules. NULL department / category = "any". The most specific active rule wins:
-- department + category, then department only, then category only, then the institution-wide rule.
CREATE TABLE verification_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id   uuid REFERENCES departments(id),
  category_id     uuid REFERENCES asset_categories(id),
  interval_days   integer NOT NULL CHECK (interval_days BETWEEN 1 AND 3660),
  due_window_days integer NOT NULL DEFAULT 14 CHECK (due_window_days BETWEEN 0 AND 365),
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT window_shorter_than_interval CHECK (due_window_days < interval_days)
);
-- Only one active rule per (department, category) combination.
CREATE UNIQUE INDEX verification_schedules_scope_uq
  ON verification_schedules (coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
                             coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_active;

-- A physical sighting of an asset by an authorised person. event_time = when it happened (device clock,
-- may be earlier than received_at for offline scans); received_at = when the server accepted it.
CREATE TABLE verification_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id             uuid NOT NULL REFERENCES assets(id),
  verified_by          uuid NOT NULL REFERENCES users(id),
  event_time           timestamptz NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  department_id        uuid NOT NULL REFERENCES departments(id),  -- owning department at the time
  expected_location_id uuid NOT NULL REFERENCES locations(id),    -- recorded location at the time
  observed_location_id uuid NOT NULL REFERENCES locations(id),    -- where it was actually seen
  outcome              text NOT NULL CHECK (outcome IN ('verified', 'location_discrepancy')),
  method               text NOT NULL CHECK (method IN ('scan', 'manual')),
  notes                text,
  operation_id         uuid UNIQUE
);
CREATE INDEX verification_events_asset_idx ON verification_events (asset_id, event_time DESC);

-- Relocations. Kept separate from verification: a move is not proof the asset was seen.
CREATE TABLE movement_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id           uuid NOT NULL REFERENCES assets(id),
  moved_by           uuid NOT NULL REFERENCES users(id),
  event_time         timestamptz NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  from_department_id uuid NOT NULL REFERENCES departments(id),
  from_location_id   uuid NOT NULL REFERENCES locations(id),
  to_department_id   uuid NOT NULL REFERENCES departments(id),
  to_location_id     uuid NOT NULL REFERENCES locations(id),
  reason             text,
  source             text NOT NULL DEFAULT 'relocation' CHECK (source IN ('relocation', 'verification')),
  operation_id       uuid UNIQUE,
  CONSTRAINT actually_moves CHECK (from_location_id <> to_location_id)
);
CREATE INDEX movement_events_asset_idx ON movement_events (asset_id, event_time DESC);

-- Things that need a person to look at them (Asset Management Team / administrators).
CREATE TABLE asset_flags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id        uuid NOT NULL REFERENCES assets(id),
  department_id   uuid NOT NULL REFERENCES departments(id),
  kind            text NOT NULL CHECK (kind IN ('location_discrepancy', 'cross_department_move', 'reported_missing',
                                                'found_after_missing', 'late_event')),
  source_type     text NOT NULL CHECK (source_type IN ('verification', 'movement', 'missing_report')),
  source_id       uuid,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_by     uuid REFERENCES users(id),
  resolved_at     timestamptz,
  resolution_note text,
  CONSTRAINT resolution_complete CHECK (status = 'open' OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL
                                                           AND length(trim(coalesce(resolution_note, ''))) >= 3))
);
CREATE INDEX asset_flags_open_idx ON asset_flags (department_id, created_at DESC) WHERE status = 'open';
CREATE INDEX asset_flags_asset_idx ON asset_flags (asset_id);

-- Cached "latest successful verification" and missing status on the asset (history stays in the event tables).
ALTER TABLE assets
  ADD COLUMN last_verified_at          timestamptz,
  ADD COLUMN last_verified_by          uuid REFERENCES users(id),
  ADD COLUMN last_verified_location_id uuid REFERENCES locations(id),
  ADD COLUMN last_verification_id      uuid REFERENCES verification_events(id),
  ADD COLUMN missing_status            text NOT NULL DEFAULT 'none'
                                       CHECK (missing_status IN ('none', 'reported_missing', 'confirmed_missing')),
  ADD COLUMN missing_reported_at       timestamptz,
  ADD COLUMN missing_reported_by       uuid REFERENCES users(id),
  ADD COLUMN missing_reason            text,
  ADD COLUMN missing_confirmed_at      timestamptz,
  ADD COLUMN missing_confirmed_by      uuid REFERENCES users(id);
CREATE INDEX assets_missing_idx ON assets (missing_status) WHERE missing_status <> 'none';

-- Verification status, derived — never stored, so schedule changes apply immediately without
-- rewriting history. Dates are calendar dates in the institution time zone.
--   base date = last successful verification, or registration date if never verified
--   due date  = base date + interval
--   overdue   = today is after the due date   ·   due = within the due window before it
-- Overdue never means missing: missing is a separate, explicitly recorded status.
CREATE VIEW asset_verification AS
SELECT
  a.id AS asset_id,
  s.id AS schedule_id,
  s.interval_days,
  s.due_window_days,
  CASE WHEN s.id IS NULL OR a.registration_status <> 'registered' THEN NULL
       ELSE base.d + s.interval_days END AS due_date,
  CASE
    WHEN a.registration_status <> 'registered' THEN 'not_applicable'
    WHEN s.id IS NULL THEN CASE WHEN a.last_verified_at IS NULL THEN 'not_yet_verified' ELSE 'verified' END
    WHEN today.d > base.d + s.interval_days THEN 'overdue'
    WHEN today.d >= base.d + s.interval_days - s.due_window_days THEN 'due'
    WHEN a.last_verified_at IS NULL THEN 'not_yet_verified'
    ELSE 'verified'
  END AS verification_status,
  CASE WHEN s.id IS NOT NULL AND a.registration_status = 'registered' AND today.d > base.d + s.interval_days
       THEN today.d - (base.d + s.interval_days) END AS overdue_days
FROM assets a
CROSS JOIN LATERAL (
  SELECT coalesce((SELECT value #>> '{}' FROM system_settings WHERE key = 'institution_time_zone'), 'UTC') AS tz
) z
CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE z.tz)::date AS d) today
CROSS JOIN LATERAL (SELECT (coalesce(a.last_verified_at, a.registered_at, a.created_at) AT TIME ZONE z.tz)::date AS d) base
LEFT JOIN LATERAL (
  SELECT vs.* FROM verification_schedules vs
   WHERE vs.is_active
     AND (vs.department_id IS NULL OR vs.department_id = a.owning_department_id)
     AND (vs.category_id IS NULL OR vs.category_id = a.category_id)
   ORDER BY (vs.department_id IS NOT NULL AND vs.category_id IS NOT NULL) DESC,
            (vs.department_id IS NOT NULL) DESC,
            (vs.category_id IS NOT NULL) DESC
   LIMIT 1
) s ON true;
