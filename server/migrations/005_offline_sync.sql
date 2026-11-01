-- Phase 6: offline fieldwork and synchronisation.

-- Institutional IDs reserved by a device while online, so assets can be registered and labelled offline
-- with their final ID. Numbers come from the same yearly counter as online registration and are never reused;
-- reserved numbers that are never used leave gaps in the sequence (expected and documented).
CREATE TABLE asset_id_reservations (
  institutional_id text PRIMARY KEY CHECK (institutional_id ~ '^[A-Z]{2,6}-[0-9]{4}-[0-9]{6,}$'),
  user_id          uuid NOT NULL REFERENCES users(id),
  device_id        text NOT NULL CHECK (length(trim(device_id)) BETWEEN 1 AND 100),
  reserved_at      timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,   -- the app stops handing out IDs after this; a label printed before it still syncs
  used_by_asset_id uuid UNIQUE REFERENCES assets(id),
  used_at          timestamptz,
  CONSTRAINT use_recorded CHECK ((used_by_asset_id IS NULL) = (used_at IS NULL))
);
CREATE INDEX asset_id_reservations_unused_idx ON asset_id_reservations (user_id) WHERE used_by_asset_id IS NULL;

-- An offline edit that reached the server after someone else had changed the same asset. Nothing is
-- overwritten: both versions are kept until someone allowed to edit the asset decides.
CREATE TABLE sync_conflicts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id    uuid NOT NULL UNIQUE,
  entity_type     text NOT NULL CHECK (entity_type IN ('asset')),
  entity_id       uuid NOT NULL REFERENCES assets(id),
  department_id   uuid NOT NULL REFERENCES departments(id),
  submitted_by    uuid NOT NULL REFERENCES users(id),
  received_at     timestamptz NOT NULL DEFAULT now(),
  base_version    integer NOT NULL,
  server_version  integer NOT NULL CHECK (server_version > base_version),
  proposed        jsonb NOT NULL,   -- the fields the device tried to change, with their new values
  server_values   jsonb NOT NULL,   -- the same fields as the server had them when the edit arrived
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'discarded')),
  resolved_by     uuid REFERENCES users(id),
  resolved_at     timestamptz,
  resolution_note text,
  CONSTRAINT resolution_recorded CHECK (status = 'open' OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX sync_conflicts_open_idx ON sync_conflicts (department_id) WHERE status = 'open';
