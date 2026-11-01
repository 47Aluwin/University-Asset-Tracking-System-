-- Phase 4: condition history, damage reports, department-managed maintenance, attachments.
-- There is no central maintenance team: every request belongs to, and is managed by, the asset's department.

-- Optional approval step per department (off by default).
ALTER TABLE departments ADD COLUMN maintenance_requires_approval boolean NOT NULL DEFAULT false;

-- Every change of an asset's condition. assets.condition holds the current value (a cache of the latest event).
CREATE TABLE condition_events (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id               uuid NOT NULL REFERENCES assets(id),
  department_id          uuid NOT NULL REFERENCES departments(id),
  recorded_by            uuid NOT NULL REFERENCES users(id),
  event_time             timestamptz NOT NULL,
  received_at            timestamptz NOT NULL DEFAULT now(),
  previous_condition     text NOT NULL CHECK (previous_condition IN ('excellent','good','fair','damaged','unusable')),
  new_condition          text NOT NULL CHECK (new_condition IN ('excellent','good','fair','damaged','unusable')),
  source                 text NOT NULL CHECK (source IN ('condition_update', 'damage_report', 'maintenance_confirmation')),
  damage_description     text,
  notes                  text,
  maintenance_request_id uuid,  -- FK added below (tables reference each other)
  operation_id           uuid UNIQUE,
  CONSTRAINT damage_has_description CHECK (source <> 'damage_report' OR length(trim(coalesce(damage_description, ''))) >= 5)
);
CREATE INDEX condition_events_asset_idx ON condition_events (asset_id, event_time DESC);

-- Maintenance and repair requests, managed by the owning department.
CREATE TABLE maintenance_requests (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference              text NOT NULL UNIQUE,               -- e.g. MR-2026-00012, for people to quote
  asset_id               uuid NOT NULL REFERENCES assets(id),
  department_id          uuid NOT NULL REFERENCES departments(id),
  reported_by            uuid NOT NULL REFERENCES users(id),
  reported_at            timestamptz NOT NULL,                -- event time (when the problem was reported)
  received_at            timestamptz NOT NULL DEFAULT now(),
  problem                text NOT NULL CHECK (length(trim(problem)) >= 5),
  condition_at_report    text NOT NULL CHECK (condition_at_report IN ('excellent','good','fair','damaged','unusable')),
  priority               text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status                 text NOT NULL DEFAULT 'submitted' CHECK (status IN
                           ('submitted','under_review','approved','in_progress','awaiting_parts','awaiting_external',
                            'completed','rejected','cancelled')),
  requires_approval      boolean NOT NULL,                    -- department policy at the time of the request
  approved_by            uuid REFERENCES users(id),
  approved_at            timestamptz,
  provider_type          text CHECK (provider_type IN ('internal','external')),
  provider_name          text,
  provider_contact       text,
  work_performed         text,
  outcome                text CHECK (outcome IN ('repaired','partially_repaired','not_repairable','no_fault_found','replaced_part')),
  completed_at           timestamptz,
  completed_by           uuid REFERENCES users(id),
  closing_reason         text,                                -- rejection or cancellation reason
  resulting_condition    text CHECK (resulting_condition IN ('excellent','good','fair','damaged','unusable')),
  condition_confirmed_by uuid REFERENCES users(id),
  condition_confirmed_at timestamptz,
  version                integer NOT NULL DEFAULT 1,
  operation_id           uuid UNIQUE,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- A request cannot be closed without saying how it ended.
  CONSTRAINT completed_has_outcome CHECK (status <> 'completed'
    OR (outcome IS NOT NULL AND length(trim(coalesce(work_performed, ''))) >= 5 AND completed_at IS NOT NULL AND completed_by IS NOT NULL)),
  CONSTRAINT closed_has_reason CHECK (status NOT IN ('rejected','cancelled') OR length(trim(coalesce(closing_reason, ''))) >= 3),
  CONSTRAINT approval_recorded CHECK (approved_at IS NULL OR approved_by IS NOT NULL),
  CONSTRAINT confirmation_after_completion CHECK (condition_confirmed_at IS NULL OR (status = 'completed' AND resulting_condition IS NOT NULL))
);
CREATE INDEX maintenance_requests_open_idx ON maintenance_requests (department_id, status)
  WHERE status NOT IN ('completed','rejected','cancelled');
CREATE INDEX maintenance_requests_asset_idx ON maintenance_requests (asset_id, reported_at DESC);

ALTER TABLE condition_events
  ADD CONSTRAINT condition_events_request_fk FOREIGN KEY (maintenance_request_id) REFERENCES maintenance_requests(id);

CREATE TABLE maintenance_status_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES maintenance_requests(id),
  from_status text,
  to_status   text NOT NULL,
  changed_by  uuid NOT NULL REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now(),
  note        text
);
CREATE INDEX maintenance_status_history_request_idx ON maintenance_status_history (request_id, changed_at);

-- Cost lines, each with its own currency. Totals are only ever summed per currency.
CREATE TABLE maintenance_costs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES maintenance_requests(id),
  kind        text NOT NULL CHECK (kind IN ('parts','labour','external_service','other')),
  description text NOT NULL CHECK (length(trim(description)) >= 2),
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  currency    char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  invoice_ref text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX maintenance_costs_request_idx ON maintenance_costs (request_id);

-- Uploaded photos and documents. Files live outside the database under an unguessable storage key;
-- access is always checked against the owning asset's department.
CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type    text NOT NULL CHECK (owner_type IN ('maintenance_request', 'condition_event')),
  owner_id      uuid NOT NULL,
  asset_id      uuid NOT NULL REFERENCES assets(id),
  department_id uuid NOT NULL REFERENCES departments(id),
  file_name     text NOT NULL,
  content_type  text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes    integer NOT NULL CHECK (size_bytes > 0),
  sha256        char(64) NOT NULL,
  storage_key   text NOT NULL UNIQUE,
  uploaded_by   uuid NOT NULL REFERENCES users(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_owner_idx ON attachments (owner_type, owner_id);

-- Request numbers per year, allocated atomically like asset IDs.
CREATE TABLE maintenance_counters (
  year       integer PRIMARY KEY,
  last_value integer NOT NULL
);
