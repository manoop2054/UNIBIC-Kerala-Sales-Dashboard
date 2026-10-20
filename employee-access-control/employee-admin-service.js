'use strict';

// Transactional employee-admin operations. This module is intentionally not
// exposed as an HTTP route until server-side session authentication is mounted.
const SUPER_ADMIN_ID = 'P2PUF7638';
const ROLES = new Set(['EMPLOYEE', 'ADMIN', 'SUPER_ADMIN', 'REGIONAL_MANAGER', 'AREA_MANAGER', 'ANCHOR_ZONE_MANAGER']);
const STATUSES = new Set(['ACTIVE', 'INACTIVE']);

function clean(value, field, max = 200) {
  const result = String(value == null ? '' : value).trim();
  if (!result && field) throw new Error(field + ' is required');
  if (result.length > max) throw new Error(field + ' is too long');
  return result;
}

function normalizeEmployee(input, actor) {
  if (!input || typeof input !== 'object') throw new Error('Employee payload is required');
  if (!actor || !actor.employeeId || !['ADMIN', 'SUPER_ADMIN'].includes(actor.role)) {
    throw new Error('Authenticated Admin or Super Admin required');
  }
  const employeeId = clean(input.employee_id, 'Employee ID', 64).toUpperCase();
  const employeeName = clean(input.employee_name, 'Employee Name', 200);
  const designation = clean(input.designation || 'Employee', 'Designation', 100);
  let role = String(input.role || 'EMPLOYEE').trim().toUpperCase();
  const status = String(input.status || 'ACTIVE').trim().toUpperCase();
  if (!ROLES.has(role)) throw new Error('Invalid role');
  if (!STATUSES.has(status)) throw new Error('Invalid status');
  if (role === 'SUPER_ADMIN' && employeeId !== SUPER_ADMIN_ID) {
    throw new Error('SUPER_ADMIN role is reserved for P2PUF7638');
  }
  if (role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') {
    throw new Error('Only the protected Super Admin may assign SUPER_ADMIN to the protected account');
  }
  if (role === 'ADMIN' && actor.role !== 'SUPER_ADMIN') {
    throw new Error('Only Super Admin may grant ADMIN role');
  }
  if (employeeId === SUPER_ADMIN_ID) {
    if (actor.role !== 'SUPER_ADMIN') throw new Error('Only Super Admin may manage the protected Super Admin account');
    role = 'SUPER_ADMIN';
    if (status !== 'ACTIVE') throw new Error('Protected Super Admin must remain ACTIVE');
  } else if (role === 'SUPER_ADMIN') {
    throw new Error('SUPER_ADMIN role is reserved for P2PUF7638');
  }

  const region = clean(input.region, 'Region', 120);
  const area = clean(input.area, 'Area', 120);
  const anchorZone = clean(input.anchor_zone, 'Anchor Zone', 120);
  const allowedTabs = Array.isArray(input.allowed_tabs)
    ? [...new Set(input.allowed_tabs.map(v => clean(v, 'Allowed tab', 120)))]
    : [];
  if (!allowedTabs.length) throw new Error('At least one allowed tab is required');
  const effectiveFrom = input.effective_from ? clean(input.effective_from, 'Effective From', 10) : null;
  const effectiveTo = input.effective_to ? clean(input.effective_to, 'Effective To', 10) : null;
  if (effectiveFrom && effectiveTo && effectiveFrom > effectiveTo) {
    throw new Error('Effective To must be on or after Effective From');
  }
  return {
    employeeId, employeeName, designation, role, status, region, area, anchorZone,
    dbrId: clean(input.dbr_id || '', null, 80),
    dbrName: clean(input.dbr_name || '', null, 200),
    allowedTabs,
    effectiveFrom, effectiveTo,
    remarks: clean(input.remarks || '', null, 1000)
  };
}

async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function saveEmployee(pool, input, actor) {
  const employee = normalizeEmployee(input, actor);
  const actorId = String(actor.employeeId).trim().toUpperCase();
  if (employee.employeeId === SUPER_ADMIN_ID && actorId !== SUPER_ADMIN_ID) {
    throw new Error('Protected Super Admin cannot be edited by another account');
  }
  return withTransaction(pool, async client => {
    const existing = await client.query(
      'SELECT employee_id, role, status FROM employees WHERE employee_id = $1 FOR UPDATE',
      [employee.employeeId]
    );
    if (employee.employeeId === SUPER_ADMIN_ID && !existing.rows.length) {
      throw new Error('Protected Super Admin must be bootstrapped through the reviewed setup process');
    }
    await client.query(
      `INSERT INTO employees (employee_id, employee_name, designation, role, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (employee_id) DO UPDATE SET
         employee_name=EXCLUDED.employee_name, designation=EXCLUDED.designation,
         role=EXCLUDED.role, status=EXCLUDED.status, updated_at=NOW()`,
      [employee.employeeId, employee.employeeName, employee.designation, employee.role, employee.status]
    );

    await client.query('DELETE FROM employee_permissions WHERE employee_id = $1', [employee.employeeId]);
    for (const resourceKey of employee.allowedTabs) {
      await client.query(
        `INSERT INTO employee_permissions
         (employee_id, resource_key, can_view, can_filter, can_export, can_print)
         VALUES ($1,$2,TRUE,TRUE,FALSE,FALSE)`,
        [employee.employeeId, resourceKey]
      );
      await client.query(
        `INSERT INTO employee_resource_scopes
         (employee_id, resource_key, region, area, anchor_zone)
         VALUES ($1,$2,$3,$4,$5)`,
        [employee.employeeId, resourceKey, employee.region, employee.area, employee.anchorZone]
      );
    }
    await client.query(
      `INSERT INTO access_audit_log
       (actor_employee_id, actor_is_admin, action, target_employee_id, details_json)
       VALUES ($1, TRUE, $2, $3, $4::jsonb)`,
      [actorId, existing.rows.length ? 'EMPLOYEE_UPDATED' : 'EMPLOYEE_CREATED',
       employee.employeeId, JSON.stringify({ role: employee.role, status: employee.status, allowedTabs: employee.allowedTabs })]
    );
    if (employee.status === 'INACTIVE') {
      await client.query(
        'UPDATE employee_sessions SET revoked_at = NOW() WHERE employee_id = $1 AND revoked_at IS NULL',
        [employee.employeeId]
      );
    }
    return { employeeId: employee.employeeId, created: existing.rows.length === 0, status: employee.status };
  });
}

module.exports = { SUPER_ADMIN_ID, normalizeEmployee, saveEmployee, withTransaction };
