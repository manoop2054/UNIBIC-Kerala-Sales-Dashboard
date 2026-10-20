'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { REQUIRED_HEADERS, validateEmployeeMaster } = require('./employee-master-import-validation');

const headers = [...REQUIRED_HEADERS, 'Anchor_Zone', 'DBR_ID', 'DBR_Name', 'Effective_From', 'Effective_To', 'Remarks'];
const row = (overrides = {}) => ({
  Employee_ID: '1511770',
  Employee_Name: 'ANOOP K K',
  Designation: 'Executive',
  Role: 'Executive',
  Region: 'SOUTH KL',
  Area: 'KOCHI',
  Anchor_Zone: '',
  DBR_ID: '',
  DBR_Name: '',
  Allowed_Tabs: 'Executive Dashboard;Report Center',
  Status: 'ACTIVE',
  Effective_From: '',
  Effective_To: '',
  Remarks: 'Permanent Employee',
  ...overrides
});

test('requires the master columns needed for safe import', () => {
  const result = validateEmployeeMaster(['Employee_ID', 'Employee_Name'], [row()]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /Missing required headers/);
});

test('normalizes regular employees with least privilege when Role is a designation', () => {
  const result = validateEmployeeMaster(headers, [row()]);
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].role, 'EMPLOYEE');
  assert.equal(result.rows[0].designation, 'Executive');
  assert.equal(result.rows[0].status, 'ACTIVE');
  assert.ok(result.warnings.some(w => /mapped to EMPLOYEE/.test(w.message)));
});

test('forces the protected Manoob employee ID to SUPER_ADMIN and ACTIVE', () => {
  const result = validateEmployeeMaster(headers, [row({
    Employee_ID: 'P2PUF7638',
    Employee_Name: 'Manoob',
    Role: 'Executive',
    Status: 'INACTIVE'
  })], { actorEmployeeId: 'P2PUF7638' });
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].role, 'SUPER_ADMIN');
  assert.equal(result.rows[0].status, 'ACTIVE');
  assert.equal(result.rows[0].protectedSuperAdmin, true);
});

test('rejects duplicate employee IDs without accepting the duplicate row', () => {
  const result = validateEmployeeMaster(headers, [row(), row({ Employee_Name: 'Duplicate' })]);
  assert.equal(result.ok, false);
  assert.equal(result.rows.length, 1);
  assert.match(result.errors[0].message, /Duplicate Employee_ID/);
});

test('rejects incomplete blank rows and invalid status values', () => {
  const blank = Object.fromEntries(headers.map(h => [h, '']));
  const invalidStatus = row({ Employee_ID: 'EMP002', Status: 'PENDING' });
  const result = validateEmployeeMaster(headers, [blank, invalidStatus]);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
});

test('does not treat All Access as a permission grant', () => {
  const result = validateEmployeeMaster(headers, [row({ Allowed_Tabs: 'All Access' })]);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(w => /resource permissions must be granted separately/.test(w.message)));
});

test('rejects an end date before the effective start date', () => {
  const result = validateEmployeeMaster(headers, [row({
    Effective_From: '2026-10-20',
    Effective_To: '2026-10-01'
  })]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /must not be earlier/);
});


test('blocks an ordinary admin from importing a row with ADMIN role', () => {
  const result = validateEmployeeMaster(headers, [row({ Employee_ID: 'ADMIN003', Role: 'ADMIN' })], { actorEmployeeId: 'ADMIN002' });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /Only the authenticated Super Admin/);
});

test('blocks a non-Super Admin from importing the protected Super Admin identity', () => {
  const result = validateEmployeeMaster(headers, [row({ Employee_ID: 'P2PUF7638', Employee_Name: 'Manoob' })], { actorEmployeeId: 'ADMIN002' });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /protected Super Admin record/);
});
