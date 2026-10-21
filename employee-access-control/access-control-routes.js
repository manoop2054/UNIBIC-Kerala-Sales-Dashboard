'use strict';

const { authenticateCredentials, resolveSession, revokeSession, extractSessionToken,
  sessionCookie, clearSessionCookie, hashPassword } = require('./session-auth');
const { saveEmployee, normalizeEmployee, SUPER_ADMIN_ID } = require('./employee-admin-service');
const { validateEmployeeMaster } = require('./employee-master-import-validation');

function mountAccessControlRoutes(app, { getPool, initializeDatabase, getDatabaseStatus }) {
  const loginAttempts = new Map();

  async function ensureReady(res) {
    try {
      await initializeDatabase();
      const status = getDatabaseStatus();
      if (!status.ready) {
        res.status(503).json({ error: 'Employee Access Control database is not ready.' });
        return null;
      }
      const pool = getPool();
      if (!pool) {
        res.status(503).json({ error: 'Employee Access Control database is not configured.' });
        return null;
      }
      return pool;
    } catch (_) {
      res.status(503).json({ error: 'Employee Access Control database is not ready.' });
      return null;
    }
  }

  async function requireSession(req, res, next) {
    const pool = await ensureReady(res);
    if (!pool) return;
    const token = extractSessionToken(req.headers.cookie);
    try {
      const user = await resolveSession(pool, token);
      if (!user) return res.status(401).json({ error: 'A valid employee session is required.' });
      req.accessUser = user;
      req.accessSessionToken = token;
      return next();
    } catch (_) {
      return res.status(503).json({ error: 'Unable to verify employee session.' });
    }
  }

  function requireAdmin(req, res, next) {
    if (!req.accessUser || !['ADMIN', 'SUPER_ADMIN'].includes(String(req.accessUser.role).toUpperCase())) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    return next();
  }

  function auditActor(req) {
    return { employeeId: req.accessUser.employeeId, role: req.accessUser.role };
  }

  app.get('/api/access-control/status', (_req, res) => {
    const status = getDatabaseStatus();
    res.json({ configured: Boolean(status.configured), ready: Boolean(status.ready) });
  });

  app.post('/api/access-control/login', async (req, res) => {
    const ip = String(req.ip || req.socket.remoteAddress || 'unknown').slice(0, 100);
    const now = Date.now();
    let entry = loginAttempts.get(ip);
    if (!entry || now - entry.start >= 10 * 60 * 1000) {
      entry = { start: now, count: 0 };
      loginAttempts.set(ip, entry);
    }
    if (entry.count >= 10) return res.status(429).json({ error: 'Too many login attempts. Try again in 10 minutes.' });
    entry.count++;
    const pool = await ensureReady(res);
    if (!pool) return;
    try {
      const result = await authenticateCredentials(pool, req.body?.employee_id, req.body?.password);
      if (!result) return res.status(401).json({ error: 'Employee ID or password is incorrect, or the account is inactive.' });
      loginAttempts.delete(ip);
      res.setHeader('Set-Cookie', sessionCookie(result.token));
      return res.json({ success: true, user: result.user });
    } catch (_) {
      return res.status(503).json({ error: 'Unable to complete login securely.' });
    }
  });

  app.post('/api/access-control/logout', async (req, res) => {
    const pool = await ensureReady(res);
    if (!pool) return;
    const token = extractSessionToken(req.headers.cookie);
    try {
      await revokeSession(pool, token);
      res.setHeader('Set-Cookie', clearSessionCookie());
      return res.json({ success: true });
    } catch (_) {
      res.setHeader('Set-Cookie', clearSessionCookie());
      return res.status(503).json({ error: 'Unable to revoke the session. Please retry.' });
    }
  });

  app.get('/api/access-control/me', requireSession, async (req, res) => {
    const { employeeId, employeeName, designation, role } = req.accessUser;
    const pool = await ensureReady(res);
    if (!pool) return;
    try {
      if (String(role).toUpperCase() === 'SUPER_ADMIN' && employeeId.toUpperCase() === SUPER_ADMIN_ID) {
        return res.json({
          success: true,
          user: { employeeId, employeeName, designation, role },
          permissions: Object.keys(require('./resource-catalog').RESOURCES).map(resourceKey => ({
            resourceKey, canView: true, canFilter: true, canExport: true, canPrint: true,
            scopes: [{ region: '*', area: '*', anchorZone: '*' }]
          }))
        });
      }
      const result = await pool.query(
        `SELECT p.resource_key, p.can_view, p.can_filter, p.can_export, p.can_print,
                COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
                  'region', s.region, 'area', s.area, 'anchorZone', s.anchor_zone
                )) FILTER (WHERE s.region IS NOT NULL), '[]'::jsonb) AS scopes
         FROM employee_permissions p
         LEFT JOIN employee_resource_scopes s
           ON s.employee_id = p.employee_id AND s.resource_key = p.resource_key
         WHERE p.employee_id = $1
         GROUP BY p.employee_id, p.resource_key, p.can_view, p.can_filter, p.can_export, p.can_print
         ORDER BY p.resource_key`,
        [employeeId]
      );
      const permissions = result.rows.map(row => ({
        resourceKey: row.resource_key, canView: row.can_view, canFilter: row.can_filter,
        canExport: row.can_export, canPrint: row.can_print, scopes: row.scopes
      }));
      return res.json({ success: true, user: { employeeId, employeeName, designation, role }, permissions });
    } catch (_) {
      return res.status(500).json({ error: 'Unable to load employee permissions.' });
    }
  });

  app.get('/api/access-control/employees', requireSession, requireAdmin, async (req, res) => {
    const pool = await ensureReady(res);
    if (!pool) return;
    try {
      const result = await pool.query(
        `SELECT e.employee_id, e.employee_name, e.designation, e.role, e.status,
                e.created_at, e.updated_at,
                COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
                  'resourceKey', p.resource_key, 'canView', p.can_view,
                  'canFilter', p.can_filter, 'canExport', p.can_export, 'canPrint', p.can_print
                )) FILTER (WHERE p.resource_key IS NOT NULL), '[]'::jsonb) AS permissions,
                COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
                  'resourceKey', s.resource_key, 'region', s.region, 'area', s.area, 'anchorZone', s.anchor_zone
                )) FILTER (WHERE s.resource_key IS NOT NULL), '[]'::jsonb) AS scopes
         FROM employees e
         LEFT JOIN employee_permissions p ON p.employee_id = e.employee_id
         LEFT JOIN employee_resource_scopes s ON s.employee_id = e.employee_id AND s.resource_key = p.resource_key
         GROUP BY e.employee_id ORDER BY e.employee_name`
      );
      res.json({ success: true, employees: result.rows });
    } catch (_) {
      res.status(500).json({ error: 'Unable to load Employee Master.' });
    }
  });

  app.post('/api/access-control/employees', requireSession, requireAdmin, async (req, res) => {
    const pool = await ensureReady(res);
    if (!pool) return;
    try {
      const inputId = String(req.body?.employee_id || '').trim().toUpperCase();
      if (inputId === SUPER_ADMIN_ID) return res.status(403).json({ error: 'The protected Super Admin account cannot be edited through Employee Master.' });
      const result = await saveEmployee(pool, req.body || {}, auditActor(req));
      res.status(result.created ? 201 : 200).json({ success: true, employee: result });
    } catch (error) {
      const status = /Authenticated Admin|Only Super Admin|protected Super Admin|SUPER_ADMIN role is reserved|Only the protected/.test(error.message) ? 403 : 400;
      res.status(status).json({ error: error.message || 'Employee could not be saved.' });
    }
  });

  app.post('/api/access-control/employees/:employeeId/password', requireSession, requireAdmin, async (req, res) => {
    const targetId = String(req.params.employeeId || '').trim().toUpperCase();
    const actorId = String(req.accessUser.employeeId).trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,64}$/.test(targetId)) return res.status(400).json({ error: 'Invalid Employee ID.' });
    if (targetId === SUPER_ADMIN_ID) return res.status(403).json({ error: 'The protected Super Admin password cannot be reset through Employee Master.' });
    if (targetId === actorId) return res.status(400).json({ error: 'Use the account password-change workflow to change your own password.' });
    const pool = await ensureReady(res);
    if (!pool) return;
    let passwordHash;
    try {
      passwordHash = await hashPassword(req.body?.password);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query('SELECT employee_id, role FROM employees WHERE employee_id = $1 FOR UPDATE', [targetId]);
      if (!target.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Employee not found.' });
      }
      if (String(req.accessUser.role).toUpperCase() !== 'SUPER_ADMIN' &&
          ['ADMIN', 'SUPER_ADMIN'].includes(String(target.rows[0].role).toUpperCase())) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Only Super Admin may reset an Admin password.' });
      }
      await client.query('UPDATE employees SET password_hash = $1, updated_at = NOW() WHERE employee_id = $2', [passwordHash, targetId]);
      await client.query('UPDATE employee_sessions SET revoked_at = NOW() WHERE employee_id = $1 AND revoked_at IS NULL', [targetId]);
      await client.query(
        `INSERT INTO access_audit_log (actor_employee_id, actor_is_admin, action, target_employee_id, details_json)
         VALUES ($1, TRUE, 'EMPLOYEE_PASSWORD_RESET', $2, '{}'::jsonb)`,
        [actorId, targetId]
      );
      await client.query('COMMIT');
      return res.json({ success: true, employeeId: targetId, sessionsRevoked: true });
    } catch (_) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return res.status(500).json({ error: 'Password reset failed; no changes were saved.' });
    } finally {
      client.release();
    }
  });

  app.put('/api/access-control/employees/:employeeId/permissions', requireSession, requireAdmin, async (req, res) => {
    const targetId = String(req.params.employeeId || '').trim().toUpperCase();
    const actorId = String(req.accessUser.employeeId).trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,64}$/.test(targetId)) return res.status(400).json({ error: 'Invalid Employee ID.' });
    if (targetId === SUPER_ADMIN_ID) return res.status(403).json({ error: 'The protected Super Admin access cannot be modified.' });
    const permissions = req.body?.permissions;
    if (!Array.isArray(permissions) || !permissions.length || permissions.length > 100) {
      return res.status(400).json({ error: 'Provide 1–100 resource permission rows.' });
    }
    const seenResources = new Set();
    const normalized = [];
    for (const item of permissions) {
      const resourceKey = String(item?.resourceKey || '').trim();
      const region = String(item?.region || '').trim();
      const area = String(item?.area || '').trim();
      const anchorZone = String(item?.anchorZone || '').trim();
      if (!/^[a-z][a-z0-9._:-]{0,119}$/.test(resourceKey) || seenResources.has(resourceKey)) {
        return res.status(400).json({ error: 'Resource keys must be unique and use lowercase letters, digits, dot, underscore, colon or hyphen.' });
      }
      if (!region || region.length > 120 || area.length > 120 || anchorZone.length > 120 || (anchorZone && !area)) {
        return res.status(400).json({ error: 'Each permission needs a Region; Anchor Zone requires an Area.' });
      }
      const flags = ['canView', 'canFilter', 'canExport', 'canPrint'];
      if (flags.some(key => typeof item[key] !== 'boolean')) {
        return res.status(400).json({ error: 'Every permission row must specify boolean View, Filter, Export and Print flags.' });
      }
      if (!item.canView && (item.canFilter || item.canExport || item.canPrint)) {
        return res.status(400).json({ error: 'Filter, Export and Print cannot be granted when View is disabled.' });
      }
      seenResources.add(resourceKey);
      normalized.push({ resourceKey, region, area, anchorZone, canView: item.canView, canFilter: item.canFilter, canExport: item.canExport, canPrint: item.canPrint });
    }
    const pool = await ensureReady(res);
    if (!pool) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query('SELECT employee_id, role FROM employees WHERE employee_id = $1 FOR UPDATE', [targetId]);
      if (!target.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Employee not found.' });
      }
      if (String(req.accessUser.role).toUpperCase() !== 'SUPER_ADMIN' &&
          ['ADMIN', 'SUPER_ADMIN'].includes(String(target.rows[0].role).toUpperCase())) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Only Super Admin may change permissions for an Admin.' });
      }
      await client.query('DELETE FROM employee_permissions WHERE employee_id = $1', [targetId]);
      for (const permission of normalized) {
        await client.query(
          `INSERT INTO employee_permissions
           (employee_id, resource_key, can_view, can_filter, can_export, can_print)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [targetId, permission.resourceKey, permission.canView, permission.canFilter, permission.canExport, permission.canPrint]
        );
        await client.query(
          `INSERT INTO employee_resource_scopes (employee_id, resource_key, region, area, anchor_zone)
           VALUES ($1,$2,$3,$4,$5)`,
          [targetId, permission.resourceKey, permission.region, permission.area, permission.anchorZone]
        );
      }
      await client.query(
        `INSERT INTO access_audit_log (actor_employee_id, actor_is_admin, action, target_employee_id, details_json)
         VALUES ($1, TRUE, 'EMPLOYEE_PERMISSIONS_UPDATED', $2, $3::jsonb)`,
        [actorId, targetId, JSON.stringify({ resources: normalized.length })]
      );
      await client.query('COMMIT');
      return res.json({ success: true, employeeId: targetId, resourcesUpdated: normalized.length });
    } catch (_) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return res.status(500).json({ error: 'Permission update failed; no changes were saved.' });
    } finally {
      client.release();
    }
  });

  app.post('/api/access-control/employees/import', requireSession, requireAdmin, async (req, res) => {
    if (String(req.accessUser.role).toUpperCase() !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Only the protected Super Admin can import the Employee Master.' });
    }
    const pool = await ensureReady(res);
    if (!pool) return;
    const headers = req.body?.headers;
    const rows = req.body?.rows;
    if (!Array.isArray(headers) || !Array.isArray(rows) || rows.length > 5000) {
      return res.status(400).json({ error: 'Provide headers and rows arrays; maximum 5,000 rows per import.' });
    }
    const validation = validateEmployeeMaster(headers, rows, { actorEmployeeId: req.accessUser.employeeId });
    if (!validation.ok) return res.status(400).json({ success: false, validation });
    if (validation.rows.some(row => row.employeeId.toUpperCase() === SUPER_ADMIN_ID)) {
      return res.status(400).json({ error: 'Do not import the protected Super Admin row; manage employee access without changing that account.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const imported = [];
      for (const row of validation.rows) {
        const employeeInput = {
          employee_id: row.employeeId,
          employee_name: row.employeeName,
          designation: row.designation,
          role: row.role,
          status: row.status,
          region: row.region,
          area: row.area,
          anchor_zone: row.anchorZone || '',
          dbr_id: row.dbrId,
          dbr_name: row.dbrName,
          allowed_tabs: row.allowedTabs.split(';').map(value => value.trim()).filter(Boolean),
          effective_from: row.effectiveFrom,
          effective_to: row.effectiveTo,
          remarks: row.remarks
        };
        const employee = normalizeEmployee(employeeInput, auditActor(req));
        const existing = await client.query('SELECT employee_id FROM employees WHERE employee_id = $1 FOR UPDATE', [employee.employeeId]);
        await client.query(
          `INSERT INTO employees (employee_id, employee_name, designation, role, status, updated_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (employee_id) DO UPDATE SET employee_name=EXCLUDED.employee_name,
             designation=EXCLUDED.designation, role=EXCLUDED.role, status=EXCLUDED.status, updated_at=NOW()`,
          [employee.employeeId, employee.employeeName, employee.designation, employee.role, employee.status]
        );
        await client.query('DELETE FROM employee_permissions WHERE employee_id = $1', [employee.employeeId]);
        for (const resourceKey of employee.allowedTabs) {
          await client.query(
            `INSERT INTO employee_permissions (employee_id, resource_key, can_view, can_filter, can_export, can_print)
             VALUES ($1,$2,TRUE,TRUE,FALSE,FALSE)`,
            [employee.employeeId, resourceKey]
          );
          await client.query(
            `INSERT INTO employee_resource_scopes (employee_id, resource_key, region, area, anchor_zone)
             VALUES ($1,$2,$3,$4,$5)`,
            [employee.employeeId, resourceKey, employee.region, employee.area, employee.anchorZone]
          );
        }
        if (employee.status === 'INACTIVE') {
          await client.query('UPDATE employee_sessions SET revoked_at = NOW() WHERE employee_id = $1 AND revoked_at IS NULL', [employee.employeeId]);
        }
        await client.query(
          `INSERT INTO access_audit_log (actor_employee_id, actor_is_admin, action, target_employee_id, details_json)
           VALUES ($1, TRUE, $2, $3, $4::jsonb)`,
          [req.accessUser.employeeId, existing.rows.length ? 'EMPLOYEE_IMPORTED_UPDATED' : 'EMPLOYEE_IMPORTED_CREATED',
            employee.employeeId, JSON.stringify({ role: employee.role, status: employee.status, allowedTabs: employee.allowedTabs })]
        );
        imported.push({ employeeId: employee.employeeId, status: employee.status, created: !existing.rows.length });
      }
      await client.query('COMMIT');
      res.json({ success: true, imported: imported.length, employees: imported, warnings: validation.warnings });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      res.status(400).json({ error: 'Employee Master import was rolled back. ' + (error.message || 'Validation or database error.') });
    } finally {
      client.release();
    }
  });
}

module.exports = { mountAccessControlRoutes };
