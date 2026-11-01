-- Phase 1: departments, users, access requests, sessions, password reset, scope grants,
-- audit log, settings, idempotency records.

CREATE TABLE departments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{2,12}$'),
  name             text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 200),
  default_currency char(3) NOT NULL CHECK (default_currency ~ '^[A-Z]{3}$'),
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL UNIQUE CHECK (email = lower(email) AND position('@' in email) > 1),
  full_name          text NOT NULL CHECK (length(trim(full_name)) BETWEEN 2 AND 200),
  password_hash      text,                      -- NULL until the user sets a password via setup link
  role               text NOT NULL CHECK (role IN ('SYSTEM_ADMIN','ASSET_MANAGER','DEPARTMENT_STAFF')),
  department_id      uuid REFERENCES departments(id),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deactivated')),
  failed_login_count integer NOT NULL DEFAULT 0,
  lockout_count      integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  password_changed_at timestamptz,
  last_login_at      timestamptz,
  deactivated_at     timestamptz,
  deactivation_reason text,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_requires_department CHECK (role <> 'DEPARTMENT_STAFF' OR department_id IS NOT NULL)
);
CREATE INDEX users_department_idx ON users(department_id);
CREATE INDEX users_role_status_idx ON users(role, status);

CREATE TABLE user_scope_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  department_id uuid NOT NULL REFERENCES departments(id),
  access_level  text NOT NULL CHECK (access_level IN ('read','operate')),
  reason        text NOT NULL CHECK (length(trim(reason)) >= 5),
  granted_by    uuid NOT NULL REFERENCES users(id),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users(id)
);
CREATE INDEX user_scope_grants_user_idx ON user_scope_grants(user_id) WHERE revoked_at IS NULL;

CREATE TABLE access_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name         text NOT NULL CHECK (length(trim(full_name)) BETWEEN 2 AND 200),
  email             text NOT NULL CHECK (email = lower(email)),
  department_id     uuid NOT NULL REFERENCES departments(id),
  requested_role    text NOT NULL CHECK (requested_role IN ('ASSET_MANAGER','DEPARTMENT_STAFF')),
  justification     text NOT NULL CHECK (length(trim(justification)) BETWEEN 5 AND 2000),
  password_hash     text NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by       uuid REFERENCES users(id),
  reviewed_at       timestamptz,
  decision_note     text,
  approved_user_id  uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT decision_complete CHECK (status = 'pending' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CONSTRAINT rejection_reason CHECK (status <> 'rejected' OR length(trim(coalesce(decision_note,''))) >= 3)
);
CREATE UNIQUE INDEX access_requests_one_pending_per_email ON access_requests(email) WHERE status = 'pending';
CREATE INDEX access_requests_status_idx ON access_requests(status, created_at);

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  token_hash      text NOT NULL UNIQUE,
  client_type     text NOT NULL CHECK (client_type IN ('web','mobile')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  idle_timeout_s  integer NOT NULL,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoke_reason   text,
  user_agent      text,
  ip              text
);
CREATE INDEX sessions_user_active_idx ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  token_hash  text NOT NULL UNIQUE,
  purpose     text NOT NULL CHECK (purpose IN ('reset','setup')),
  created_by  uuid REFERENCES users(id),     -- NULL = self-service
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  invalidated_at timestamptz
);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens(user_id);

CREATE TABLE audit_events (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users(id),
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  department_id uuid REFERENCES departments(id),
  outcome       text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','denied','failure')),
  before_data   jsonb,
  after_data    jsonb,
  context       jsonb,
  ip            text
);
CREATE INDEX audit_events_entity_idx ON audit_events(entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_events_actor_idx ON audit_events(actor_user_id, occurred_at DESC);
CREATE INDEX audit_events_time_idx ON audit_events(occurred_at DESC);

CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END $$;
CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();

CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
INSERT INTO system_settings (key, value) VALUES
  ('allowed_email_domains', '[]'::jsonb),
  ('institution_time_zone', '"UTC"'::jsonb),
  ('allow_unknown_cost', 'true'::jsonb);

-- Idempotency: every client-generated operation id is processed at most once.
CREATE TABLE api_operations (
  operation_id  uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id),
  operation     text NOT NULL,
  status_code   integer NOT NULL,
  response      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
