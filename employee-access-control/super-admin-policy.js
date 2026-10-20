'use strict';

// Immutable bootstrap identity for the UNIBIC dashboard.
// This policy is a helper only until it is called from authenticated admin API routes.
const SUPER_ADMIN_EMPLOYEE_ID = 'P2PUF7638';
const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';
const PROTECTED_SUPER_ADMIN_FIELDS = Object.freeze([
  'role',
  'status',
  'permissions',
  'allowedTabs',
  'delete'
]);

function isSuperAdminEmployee(employeeId) {
  return String(employeeId == null ? '' : employeeId).trim().toUpperCase() === SUPER_ADMIN_EMPLOYEE_ID;
}

function checkEmployeeMutation({ actorEmployeeId, actorIsSuperAdmin = false, targetEmployeeId, changes = {}, deleting = false }) {
  if (!isSuperAdminEmployee(targetEmployeeId)) {
    return { allowed: true, reason: 'not-protected-super-admin' };
  }

  const protectedChange = deleting ||
    Object.keys(changes).some(key => PROTECTED_SUPER_ADMIN_FIELDS.includes(key));

  if (protectedChange) {
    return {
      allowed: false,
      reason: 'protected-super-admin-identity',
      message: 'The protected Super Admin account cannot be deleted, disabled, demoted, or have its access permissions changed.'
    };
  }

  // Profile-only changes are permitted only to the Super Admin itself.
  if (!actorIsSuperAdmin || !isSuperAdminEmployee(actorEmployeeId)) {
    return { allowed: false, reason: 'super-admin-only-profile-change' };
  }

  return { allowed: true, reason: 'super-admin-profile-change' };
}

module.exports = {
  SUPER_ADMIN_EMPLOYEE_ID,
  SUPER_ADMIN_ROLE,
  PROTECTED_SUPER_ADMIN_FIELDS,
  isSuperAdminEmployee,
  checkEmployeeMutation
};
