'use strict';

const { authenticateCredentials, resolveSession, revokeSession, extractSessionToken,
  sessionCookie, clearSessionCookie } = require('./session-auth');
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
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 100);
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

  app.get('/api/access-control/me', requireSession, (req, res) => {
    const { employeeId, employeeName, designation, role } = req.accessUser;
    res.json({ success: true, user: { employeeId, employeeName, designation, role } });
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
          anchor_zone: row.anchorZone || row.area,
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
