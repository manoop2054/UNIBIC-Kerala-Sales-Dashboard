'use strict';

// Server-side authorization primitives for the PostgreSQL access-control schema.
// Not mounted into server.js yet. Protected route handlers must create
// req.authorizationContext from trusted server-side data, never request claims.
const ACTION_COLUMNS = Object.freeze({
  view: 'can_view',
  filter: 'can_filter',
  export: 'can_export',
  print: 'can_print'
});

function normalize(value) {
  return String(value == null ? '' : value).trim().toLocaleLowerCase('en-US');
}

function matchesScope(allowed, context) {
  const allowedRegion = normalize(allowed && allowed.region);
  const contextRegion = normalize(context && context.region);
  if (!allowedRegion || !contextRegion || allowedRegion !== contextRegion) return false;
  // Empty Area means all areas in the assigned Region; empty Anchor Zone means
  // all zones in the assigned Area. A zone can never be granted without an Area.
  const allowedArea = normalize(allowed && allowed.area);
  const contextArea = normalize(context && context.area);
  const allowedZone = normalize(allowed && allowed.anchorZone);
  const contextZone = normalize(context && context.anchorZone);
  if (allowedZone && !allowedArea) return false;
  if (allowedArea && (!contextArea || allowedArea !== contextArea)) return false;
  if (allowedZone && (!contextZone || allowedZone !== contextZone)) return false;
  return true;
}

async function authorizeResource(pool, employeeId, resourceKey, action, context) {
  const actionColumn = ACTION_COLUMNS[action];
  if (!actionColumn) return { allowed: false, reason: 'unknown-action' };
  if (!employeeId || !resourceKey || !context) {
    return { allowed: false, reason: 'missing-trusted-context' };
  }

  const employeeResult = await pool.query(
    'SELECT status FROM employees WHERE employee_id = $1 LIMIT 1',
    [employeeId]
  );
  if (!employeeResult.rows[0] || employeeResult.rows[0].status !== 'ACTIVE') {
    return { allowed: false, reason: 'employee-inactive-or-missing' };
  }

  const permissionResult = await pool.query(
    'SELECT can_view, can_filter, can_export, can_print FROM employee_permissions WHERE employee_id = $1 AND resource_key = $2 LIMIT 1',
    [employeeId, resourceKey]
  );
  const permission = permissionResult.rows[0];
  if (!permission) return { allowed: false, reason: 'resource-permission-missing' };
  if (permission[actionColumn] !== true) {
    return { allowed: false, reason: 'action-not-permitted' };
  }

  const scopeResult = await pool.query(
    'SELECT region, area, anchor_zone FROM employee_resource_scopes WHERE employee_id = $1 AND resource_key = $2',
    [employeeId, resourceKey]
  );
  const scopes = scopeResult.rows.map(row => ({
    region: row.region, area: row.area, anchorZone: row.anchor_zone
  }));
  if (!scopes.length) return { allowed: false, reason: 'geographic-scope-missing' };
  if (!scopes.some(scope => matchesScope(scope, context))) {
    return { allowed: false, reason: 'outside-resource-geographic-scope' };
  }
  return { allowed: true, reason: 'allowed' };
}

function createResourceGuard({ pool, resourceKey, action, getTrustedContext }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('PostgreSQL pool required');
  if (!resourceKey || !Object.prototype.hasOwnProperty.call(ACTION_COLUMNS, action)) {
    throw new Error('Valid resourceKey and action are required');
  }
  if (typeof getTrustedContext !== 'function') {
    throw new Error('A trusted server-side context resolver is required');
  }
  return async function resourceGuard(req, res, next) {
    try {
      const user = req.accessUser;
      if (!user || !user.employeeId) {
        return res.status(401).json({ error: 'Employee authentication required.' });
      }

      // The permanent Super Admin has intrinsic access after the upstream
      // session middleware has authenticated the employee and checked ACTIVE
      // status. Do not treat every Admin as a bypass: ordinary Admins still
      // need explicit resource permissions and geographic scope.
      if (
        String(user.employeeId).trim().toUpperCase() === 'P2PUF7638' &&
        String(user.role || '').trim().toUpperCase() === 'SUPER_ADMIN'
      ) {
        return next();
      }

      const context = await getTrustedContext(req);
      const decision = await authorizeResource(pool, user.employeeId, resourceKey, action, context);
      if (!decision.allowed) {
        return res.status(403).json({ error: 'Access denied.', reason: decision.reason });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { ACTION_COLUMNS, normalize, matchesScope, authorizeResource, createResourceGuard };