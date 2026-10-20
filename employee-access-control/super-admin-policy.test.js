'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SUPER_ADMIN_EMPLOYEE_ID, isSuperAdminEmployee, checkEmployeeMutation } = require('./super-admin-policy');

test('recognizes only the configured Super Admin employee ID', () => {
  assert.equal(isSuperAdminEmployee('P2PUF7638'), true);
  assert.equal(isSuperAdminEmployee(' p2puf7638 '), true);
  assert.equal(isSuperAdminEmployee('1511255'), false);
});

test('another admin cannot delete the protected Super Admin', () => {
  const result = checkEmployeeMutation({
    actorEmployeeId: 'ADMIN002',
    targetEmployeeId: SUPER_ADMIN_EMPLOYEE_ID,
    actorIsSuperAdmin: false,
    deleting: true
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'protected-super-admin-identity');
});

test('another admin cannot disable, demote, or alter permissions of the protected Super Admin', () => {
  for (const changes of [{ status: 'INACTIVE' }, { role: 'EMPLOYEE' }, { permissions: [] }, { allowedTabs: [] }]) {
    const result = checkEmployeeMutation({
      actorEmployeeId: 'ADMIN002',
      targetEmployeeId: SUPER_ADMIN_EMPLOYEE_ID,
      changes
    });
    assert.equal(result.allowed, false);
  }
});

test('protected access fields cannot be changed even through the Super Admin panel', () => {
  const result = checkEmployeeMutation({
    actorEmployeeId: SUPER_ADMIN_EMPLOYEE_ID,
    targetEmployeeId: SUPER_ADMIN_EMPLOYEE_ID,
    actorIsSuperAdmin: true,
    changes: { role: 'EMPLOYEE' }
  });
  assert.equal(result.allowed, false);
});

test('non-protected profile edits are allowed only by Super Admin itself', () => {
  const denied = checkEmployeeMutation({
    actorEmployeeId: 'ADMIN002',
    targetEmployeeId: SUPER_ADMIN_EMPLOYEE_ID,
    changes: { remarks: 'Updated' }
  });
  const allowed = checkEmployeeMutation({
    actorEmployeeId: SUPER_ADMIN_EMPLOYEE_ID,
    targetEmployeeId: SUPER_ADMIN_EMPLOYEE_ID,
    actorIsSuperAdmin: true,
    changes: { remarks: 'Updated' }
  });
  assert.equal(denied.allowed, false);
  assert.equal(allowed.allowed, true);
});
