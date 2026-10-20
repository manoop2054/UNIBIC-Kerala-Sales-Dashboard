-- UNIBIC Employee Access Control — Cloudflare D1 schema
-- This schema is not active until the D1 database is created and configured.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employees (
  employee_id TEXT PRIMARY KEY,
  employee_name TEXT NOT NULL,
  email TEXT,
  region TEXT,
  area TEXT,
  anchor_zone TEXT,
  dbr_customer_scope TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  password_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS employee_permissions (
  employee_id TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  can_view INTEGER NOT NULL DEFAULT 0 CHECK (can_view IN (0,1)),
  can_filter INTEGER NOT NULL DEFAULT 0 CHECK (can_filter IN (0,1)),
  can_export INTEGER NOT NULL DEFAULT 0 CHECK (can_export IN (0,1)),
  can_print INTEGER NOT NULL DEFAULT 0 CHECK (can_print IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (employee_id, resource_key),
  FOREIGN KEY (employee_id) REFERENCES employees(employee_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS employee_sessions (
  session_id_hash TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (employee_id) REFERENCES employees(employee_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_employee_sessions_employee ON employee_sessions(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_sessions_expiry ON employee_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_employee_permissions_resource ON employee_permissions(resource_key);

CREATE TABLE IF NOT EXISTS access_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_employee_id TEXT,
  action TEXT NOT NULL,
  target_employee_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Do not insert real employee details or credentials into this source file.
-- Admin identity/secret must be configured as protected runtime secrets, not committed here.
