'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schema = fs.readFileSync(path.join(__dirname, 'postgres-schema.sql'), 'utf8');

test('PostgreSQL schema protects the permanent Super Admin employee identity', () => {
  assert.match(schema, /eac_protect_super_admin_employee/i);
  assert.match(schema, /Protected Super Admin account cannot be deleted/i);
  assert.match(schema, /NEW\.role\s*<>\s*'SUPER_ADMIN'/i);
  assert.match(schema, /NEW\.status\s*<>\s*'ACTIVE'/i);
});

test('PostgreSQL schema prevents per-resource permission edits for Super Admin', () => {
  assert.match(schema, /eac_protect_super_admin_permissions/i);
  assert.match(schema, /Per-resource permissions cannot alter the protected Super Admin access/i);
  assert.match(schema, /BEFORE INSERT OR UPDATE OR DELETE ON employee_permissions/i);
});

test('employee-backed Super Admin sessions can retain their employee identity', () => {
  assert.match(schema, /CHECK\s*\(is_admin\s*=\s*TRUE OR employee_id IS NOT NULL\)/i);
});
