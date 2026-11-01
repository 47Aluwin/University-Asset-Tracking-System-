-- Phase 2: categories, locations, assets, institutional ID allocation, label printing.

CREATE TABLE asset_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 100),
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX asset_categories_name_uq ON asset_categories (lower(name));

-- A place within a department: building + room.
CREATE TABLE locations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES departments(id),
  building      text NOT NULL CHECK (length(trim(building)) BETWEEN 1 AND 100),
  room          text NOT NULL CHECK (length(trim(room)) BETWEEN 1 AND 100),
  description   text,
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX locations_dept_building_room_uq ON locations (department_id, lower(building), lower(room));

-- One row per year; incremented atomically when an ID is allocated. Numbers are never reused.
CREATE TABLE asset_id_counters (
  year       integer PRIMARY KEY CHECK (year BETWEEN 2000 AND 2200),
  last_value integer NOT NULL CHECK (last_value >= 0)
);

CREATE TABLE assets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institutional_id      text NOT NULL UNIQUE CHECK (institutional_id ~ '^[A-Z]{2,6}-[0-9]{4}-[0-9]{6,}$'),
  qr_payload            text NOT NULL UNIQUE,
  name                  text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 200),
  description           text,
  category_id           uuid NOT NULL REFERENCES asset_categories(id),
  manufacturer          text,
  model                 text,
  serial_number         text NOT NULL CHECK (length(trim(serial_number)) BETWEEN 1 AND 100),
  manufacturer_barcode  text,               -- shared by identical models; never unique
  owning_department_id  uuid NOT NULL REFERENCES departments(id),
  location_id           uuid NOT NULL REFERENCES locations(id),
  acquisition_date      date NOT NULL CHECK (acquisition_date >= DATE '1900-01-01'),
  acquisition_method    text NOT NULL CHECK (acquisition_method IN ('purchase','donation','transfer','other')),
  acquisition_cost      numeric(14,2),
  currency              char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  cost_status           text NOT NULL CHECK (cost_status IN ('recorded','verified_zero','unknown_exception')),
  cost_exception_reason text,
  supplier              text,
  purchase_order_ref    text,
  warranty_expiry       date,
  notes                 text,
  condition             text NOT NULL CHECK (condition IN ('excellent','good','fair','damaged','unusable')),
  registration_status   text NOT NULL CHECK (registration_status IN ('draft','awaiting_label','registered')),
  registered_at         timestamptz,
  registered_by         uuid REFERENCES users(id),
  version               integer NOT NULL DEFAULT 1,
  created_by            uuid NOT NULL REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES users(id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- "Deleting" an asset archives it; history is never physically removed.
  archived_at           timestamptz,
  archived_by           uuid REFERENCES users(id),
  archive_reason        text,

  CONSTRAINT cost_matches_status CHECK (
       (cost_status = 'recorded'          AND acquisition_cost > 0)
    OR (cost_status = 'verified_zero'     AND acquisition_cost = 0)
    OR (cost_status = 'unknown_exception' AND acquisition_cost IS NULL
                                          AND length(trim(coalesce(cost_exception_reason, ''))) >= 5)),
  CONSTRAINT registered_has_actor CHECK (
    registration_status <> 'registered' OR (registered_at IS NOT NULL AND registered_by IS NOT NULL)),
  CONSTRAINT archive_complete CHECK (
    archived_at IS NULL OR (archived_by IS NOT NULL AND length(trim(coalesce(archive_reason, ''))) >= 3)),
  CONSTRAINT qr_matches_id CHECK (qr_payload = 'UATS:' || institutional_id)
);
CREATE INDEX assets_dept_status_idx ON assets (owning_department_id, registration_status) WHERE archived_at IS NULL;
CREATE INDEX assets_serial_idx ON assets (lower(serial_number));
CREATE INDEX assets_barcode_idx ON assets (manufacturer_barcode) WHERE manufacturer_barcode IS NOT NULL;
CREATE INDEX assets_category_idx ON assets (category_id);
CREATE INDEX assets_location_idx ON assets (location_id);
CREATE INDEX assets_created_idx ON assets (created_at DESC);

-- Every print or reprint. Printing never creates or changes the asset's identity.
CREATE TABLE label_print_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id   uuid NOT NULL REFERENCES assets(id),
  printed_by uuid NOT NULL REFERENCES users(id),
  printed_at timestamptz NOT NULL DEFAULT now(),
  copies     integer NOT NULL CHECK (copies BETWEEN 1 AND 50),
  layout     text NOT NULL CHECK (layout IN ('sheet','single')),
  is_reprint boolean NOT NULL,
  reason     text,
  CONSTRAINT reprint_reason CHECK (NOT is_reprint OR length(trim(coalesce(reason, ''))) >= 3)
);
CREATE INDEX label_print_events_asset_idx ON label_print_events (asset_id, printed_at DESC);

INSERT INTO system_settings (key, value) VALUES
  ('asset_id_prefix', '"UAT"'::jsonb),
  ('label_template', '{
     "layout": "sheet", "pageWidthMm": 210, "pageHeightMm": 297, "columns": 3, "rows": 7,
     "labelWidthMm": 63.5, "labelHeightMm": 38.1, "marginTopMm": 15.15, "marginLeftMm": 7.25,
     "gapXMm": 2.5, "gapYMm": 0, "qrSizeMm": 30, "paddingMm": 2,
     "showName": true, "showDepartment": true, "footerText": ""
   }'::jsonb);
