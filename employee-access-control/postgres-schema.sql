-- PostgreSQL schema for UNIBIC Employee Access Control.
-- Apply only to a dedicated persistent PostgreSQL database after review.
-- This file contains no real employees, passwords, or secrets.

BEGIN;

CREATE TABLE IF NOT EXISTS employees (
  employee_id TEXT PRIMARY KEY,
  employee_name TEXT NOT NULL,
  designation TEXT,
  role TEXT NOT NULL DEFAULT 'EMPLOYEE',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employee_permissions (
  employee_id TEXT NOT NULL REFERENCES employees(employee_id) ON DELETE CASCADE,
  resource_key TEXT NOT NULL,
  can_view BOOLEAN NOT NULL DEFAULT FALSE,
  can_filter BOOLEAN NOT NULL DEFAULT FALSE,
  can_export BOOLEAN NOT NULL DEFAULT FALSE,
  can_print BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (employee_id, resource_key)
);

CREATE TABLE IF NOT EXISTS employee_resource_scopes (
  employee_id TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  region TEXT NOT NULL,
  area TEXT NOT NULL,
  anchor_zone TEXT NOT NULL,
  PRIMARY KEY (employee_id, resource_key, region, area, anchor_zone),
  FOREIGN KEY (employee_id, resource_key)
    REFERENCES employee_permissions(employee_id, resource_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS employee_sessions (
  session_id_hash CHAR(64) PRIMARY KEY,
  employee_id TEXT REFERENCES employees(employee_id) ON DELETE CASCADE,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((is_admin = TRUE AND employee_id IS NULL) OR
         (is_admin = FALSE AND employee_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_eac_sessions_employee ON employee_sessions(employee_id);
CREATE INDEX IF NOT EXISTS idx_eac_sessions_expiry ON employee_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_eac_permission_resource ON employee_permissions(resource_key);
CREATE INDEX IF NOT EXISTS idx_eac_scope_lookup
  ON employee_resource_scopes(employee_id, resource_key, region, area, anchor_zone);

CREATE TABLE IF NOT EXISTS access_audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_employee_id TEXT REFERENCES employees(employee_id) ON DELETE SET NULL,
  actor_is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  action TEXT NOT NULL,
  target_employee_id TEXT,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
