'use strict';

// Immutable bootstrap identity for the UNIBIC dashboard.
// This policy is a helper only until it is called from authenticated admin API routes.
const SUPER_ADMIN_EMPLOYEE_ID = 'P2PUF7638';
const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';
const SAFE_PROFILE_FIELDS = new Set(['employee_name', 'designation', 'remarks']);

function isSuperAdminEmployee(employeeId) {
  return String(employeeId == null ? '' : employeeId).trim().toUpperCase() === SUPER_ADMIN_EMPLOYEE_ID;
}

function checkEmployeeMutation({ actorEmployeeId, actorIsSuperAdmin = false, targetEmployeeId, changes = {}, deleting = false }) {
  if (!isSuperAdminEmployee(targetEmployeeId)) {
    return { allowed: true, reason: 'not-protected-super-admin' };
  }

  // Fail closed: for the protected identity, only a small explicit profile-field allowlist
  // can ever be edited. Role/status/permission/deletion and unknown fields are rejected.
  const changedKeys = Object.keys(changes);
  const unsafeChange = deleting || changedKeys.some(key => !SAFE_PROFILE_FIELDS.has(key));

  if (unsafeChange) {
    return {
      allowed: false,
      reason: 'protected-super-admin-identity',
      message: 'The protected Super Admin account cannot be deleted, disabled, demoted, or have its access permissions changed.'
    };
  }

  if (!actorIsSuperAdmin || !isSuperAdminEmployee(actorEmployeeId)) {
    return { allowed: false, reason: 'super-admin-only-profile-change' };
  }

  return { allowed: true, reason: 'super-admin-profile-change' };
}

module.exports = {
  SUPER_ADMIN_EMPLOYEE_ID,
  SUPER_ADMIN_ROLE,
  SAFE_PROFILE_FIELDS,
  isSuperAdminEmployee,
  checkEmployeeMutation
};
