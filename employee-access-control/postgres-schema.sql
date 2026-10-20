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
  -- Admin/bootstrap sessions may have no employee identity; employee-backed
  -- sessions (including P2PUF7638) must always identify an employee.
  CHECK (is_admin = TRUE OR employee_id IS NOT NULL)
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

-- Database-level safety net: no SQL/API caller can delete or demote/disable
-- the protected Super Admin identity. Application APIs must still authenticate
-- and audit every change; this trigger is defense-in-depth, not authentication.
CREATE OR REPLACE FUNCTION eac_protect_super_admin_employee()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND UPPER(BTRIM(OLD.employee_id)) = 'P2PUF7638' THEN
    RAISE EXCEPTION 'Protected Super Admin account cannot be deleted';
  END IF;

  IF TG_OP = 'UPDATE' AND UPPER(BTRIM(OLD.employee_id)) = 'P2PUF7638' THEN
    IF UPPER(BTRIM(NEW.employee_id)) <> 'P2PUF7638'
       OR NEW.role <> 'SUPER_ADMIN'
       OR NEW.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'Protected Super Admin identity, role, and status cannot be changed';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND UPPER(BTRIM(NEW.employee_id)) = 'P2PUF7638'
     AND (NEW.role <> 'SUPER_ADMIN' OR NEW.status <> 'ACTIVE') THEN
    RAISE EXCEPTION 'Protected Super Admin must remain SUPER_ADMIN and ACTIVE';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_eac_protect_super_admin_employee ON employees;
CREATE TRIGGER trg_eac_protect_super_admin_employee
BEFORE INSERT OR UPDATE OR DELETE ON employees
FOR EACH ROW EXECUTE FUNCTION eac_protect_super_admin_employee();

-- Super Admin access is intrinsic and must not be reduced through per-resource
-- permission rows. Block all permission-row mutations for this identity.
CREATE OR REPLACE FUNCTION eac_protect_super_admin_permissions()
RETURNS TRIGGER AS $$
DECLARE
  target_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_id := OLD.employee_id;
  ELSE
    target_id := NEW.employee_id;
  END IF;

  IF UPPER(BTRIM(target_id)) = 'P2PUF7638' THEN
    RAISE EXCEPTION 'Per-resource permissions cannot alter the protected Super Admin access';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_eac_protect_super_admin_permissions ON employee_permissions;
CREATE TRIGGER trg_eac_protect_super_admin_permissions
BEFORE INSERT OR UPDATE OR DELETE ON employee_permissions
FOR EACH ROW EXECUTE FUNCTION eac_protect_super_admin_permissions();

COMMIT;
