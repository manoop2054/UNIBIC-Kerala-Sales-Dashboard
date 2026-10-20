'use strict';

// Pure authorization decision helper. Not wired into the live server yet.
// Call only with employee/session/permission/scope data loaded from trusted storage.
// Never pass permission claims from the browser as authoritative values.

const ACTION_COLUMNS = Object.freeze({
  view: 'can_view',
  filter: 'can_filter',
  export: 'can_export',
  print: 'can_print'
});

function norm(value) {
  return String(value == null ? '' : value).trim().toLocaleLowerCase('en-US');
}

function scopeMatches(scope, context) {
  if (!scope || !context) return false;
  // Fail closed: all three scope dimensions must be present on both sides.
  const required = ['region', 'area', 'anchorZone'];
  return required.every((key) => norm(scope[key]) !== '' &&
    norm(context[key]) !== '' && norm(scope[key]) === norm(context[key]));
}

/**
 * @returns {{allowed:boolean, reason:string}}
 * employee: { status: 'ACTIVE'|'INACTIVE' }
 * permission: { resource_key, can_view, can_filter, can_export, can_print }
 * scopes: array of { region, area, anchorZone } assigned to THIS resource only
 * context: { region, area, anchorZone } for the data row/query
 */
function authorizeResource({ employee, resourceKey, action, permission, scopes, context }) {
  if (!employee || String(employee.status || '').toUpperCase() !== 'ACTIVE') {
    return { allowed: false, reason: 'employee-inactive-or-missing' };
  }
  const actionColumn = ACTION_COLUMNS[action];
  if (!actionColumn) return { allowed: false, reason: 'unknown-action' };
  if (!permission || permission.resource_key !== resourceKey) {
    return { allowed: false, reason: 'resource-permission-missing' };
  }
  if (Number(permission[actionColumn]) !== 1) {
    return { allowed: false, reason: 'action-not-permitted' };
  }
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return { allowed: false, reason: 'geographic-scope-missing' };
  }
  if (!scopes.some((scope) => scopeMatches(scope, context))) {
    return { allowed: false, reason: 'outside-resource-geographic-scope' };
  }
  return { allowed: true, reason: 'allowed' };
}

module.exports = { ACTION_COLUMNS, scopeMatches, authorizeResource };
