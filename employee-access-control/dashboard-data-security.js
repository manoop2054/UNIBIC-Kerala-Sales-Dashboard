'use strict';

const { extractSessionToken, resolveSession } = require('./session-auth');

function normalize(value) {
  return String(value == null ? '' : value).trim().toLocaleLowerCase('en-US');
}

function firstValue(row, names) {
  for (const name of names) {
    if (row && row[name] != null && String(row[name]).trim() !== '') return String(row[name]).trim();
  }
  const keys = Object.keys(row || {});
  for (const name of names) {
    const target = normalize(name).replace(/[^a-z0-9]/g, '');
    const key = keys.find(candidate => normalize(candidate).replace(/[^a-z0-9]/g, '') === target);
    if (key && row[key] != null && String(row[key]).trim() !== '') return String(row[key]).trim();
  }
  return '';
}

function rowMatchesScopes(row, scopes) {
  if ((scopes || []).some(scope => !Array.isArray(scope) && normalize(scope.region) === '*' && normalize(scope.area) === '*' && normalize(scope.anchorZone) === '*')) return true;
  if (Array.isArray(scopes) && scopes.length && Array.isArray(scopes[0])) {
    return scopes.every(group => group.length > 0 && rowMatchesScopes(row, group));
  }
  const region = firstValue(row, ['REGION', 'Region', 'region', 'Region Name']);
  const area = firstValue(row, ['Area', 'Area Name', 'AreaCode', 'Area Code']);
  const zone = firstValue(row, ['AnchorZoneName', 'Anchor Zone Name', 'ANCHOR ZONENAME', 'Anchor Zone', 'AnchorZone']);
  if (!region) return false;
  return (scopes || []).some(scope => {
    if (normalize(scope.region) === '*' && normalize(scope.area) === '*' && normalize(scope.anchorZone) === '*') return true;
    if (!scope.region || normalize(scope.region) !== normalize(region)) return false;
    if (scope.area && normalize(scope.area) !== normalize(area)) return false;
    if (scope.anchorZone && normalize(scope.anchorZone) !== normalize(zone)) return false;
    return true;
  });
}

function createDashboardSessionGuard({ getPool, initializeDatabase, getDatabaseStatus, dataKind = 'gsv' }) {
  return async function dashboardSessionGuard(req, res, next) {
    try {
      await initializeDatabase();
      const status = getDatabaseStatus();
      const pool = getPool();
      if (!status.ready || !pool) return res.status(503).json({ error: 'Employee Access Control database is not ready.' });
      const token = extractSessionToken(req.headers.cookie);
      const user = await resolveSession(pool, token);
      if (!user) return res.status(401).json({ error: 'A valid employee login is required.' });
      req.accessUser = user;
      req.dataKind = dataKind;
      if (user.employeeId.toUpperCase() === 'P2PUF7638' && user.role.toUpperCase() === 'SUPER_ADMIN') {
        req.dataScopes = [{ region: '*', area: '*', anchorZone: '*' }];
        req.allWarehouses = true;
        req.allowedWarehouses = [];
        req.isProtectedSuperAdmin = true;
        return next();
      }

      // LIVE SOH is granted explicitly per employee and restricted by CFA/Warehouse.
      if (dataKind === 'soh') {
        const access = await pool.query(
          "SELECT a.enabled, a.all_warehouses, COALESCE(array_agg(w.warehouse) FILTER (WHERE w.warehouse IS NOT NULL), ARRAY[]::text[]) AS warehouses, COALESCE(p.can_view, FALSE) AS tab_allowed FROM employees e LEFT JOIN employee_soh_access a ON a.employee_id=e.employee_id LEFT JOIN employee_soh_warehouses w ON w.employee_id=a.employee_id LEFT JOIN employee_permissions p ON p.employee_id=e.employee_id AND p.resource_key='tab.soh' WHERE e.employee_id=$1 AND e.status='ACTIVE' GROUP BY a.enabled,a.all_warehouses,p.can_view",
          [user.employeeId]
        );
        const row = access.rows[0];
        if (!row || row.enabled !== true || row.tab_allowed !== true) return res.status(403).json({ error: 'LIVE SOH access has not been enabled for this employee by an Admin.' });
        const warehouses = Array.isArray(row.warehouses) ? row.warehouses : [];
        if (row.all_warehouses !== true && warehouses.length === 0) return res.status(403).json({ error: 'No CFA/Warehouse has been assigned for LIVE SOH access.' });
        req.dataScopes = [];
        req.allWarehouses = row.all_warehouses === true;
        req.allowedWarehouses = warehouses.map(value => normalize(value));
        req.isProtectedSuperAdmin = false;
        return next();
      }
      const resourceSets = {
        gsv: ['tab.executive','tab.sales','tab.item','tab.dbr','tab.invoice','tab.alerts','tab.reports','report.gsv','report.dbr-wise','report.area-wise','report.zone-wise','report.anchor-zone-wise','report.customer-wise','report.discount-returns','report.export-all'],
        soh: ['tab.soh','tab.reports','report.live-soh-cfa-wise','report.stock'],
        chat: ['tab.executive','tab.target','tab.sales','tab.item','tab.dbr','tab.invoice','tab.soh','tab.alerts','tab.reports','tab.targetworking','report.gsv','report.target-achievement','report.dbr-wise','report.area-wise','report.zone-wise','report.anchor-zone-wise','report.customer-wise','report.live-soh-cfa-wise','report.discount-returns','report.stock','report.export-all']
      };
      const allowedResources = resourceSets[dataKind] || resourceSets.chat;
      const result = await pool.query(
        `SELECT p.resource_key, s.region, s.area, s.anchor_zone
         FROM employee_permissions p
         LEFT JOIN employee_resource_scopes s
           ON s.employee_id = p.employee_id AND s.resource_key = p.resource_key
         WHERE p.employee_id = $1 AND p.can_view = TRUE AND p.resource_key = ANY($2::text[])
         ORDER BY p.resource_key`,
        [user.employeeId, allowedResources]
      );
      const grouped = new Map();
      for (const row of result.rows) {
        if (!grouped.has(row.resource_key)) grouped.set(row.resource_key, []);
        if (row.region != null) grouped.get(row.resource_key).push({ region: row.region, area: row.area, anchorZone: row.anchor_zone });
      }
      const scopeGroups = [...grouped.values()];
      if (!scopeGroups.length || scopeGroups.some(group => !group.length)) {
        return res.status(403).json({ error: 'No active data-view permission with a valid geographic scope is assigned for this dataset.' });
      }
      req.dataScopes = scopeGroups;
      req.isProtectedSuperAdmin = false;
      return next();
    } catch (_) {
      return res.status(503).json({ error: 'Unable to verify dashboard access.' });
    }
  };
}

// Stream the cached JSON one row at a time so filtering does not parse the full
// 100+ MB sales dataset into memory on the small Render instance.
async function sendScopedJsonCache(req, res, file) {
  const fs = require('node:fs');
  const { once } = require('node:events');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.write('{"data":[');
  let emitted = 0;
  let totalRows = 0;
  let inDataArray = false;
  let objectDepth = 0;
  let inString = false;
  let escaped = false;
  let objectBuffer = '';
  const emit = async row => {
    totalRows++;
    if (req.dataKind === 'soh') {
      if (!req.allWarehouses) {
        const warehouse = normalize(firstValue(row, ['WAREHOUSE','Warehouse','CFA','CFA / WAREHOUSE','CFA/Warehouse','Location','Location Name']));
        if (!warehouse || !(req.allowedWarehouses || []).includes(warehouse)) return;
      }
    } else if (!rowMatchesScopes(row, req.dataScopes)) return;
    if (emitted++) res.write(',');
    if (!res.write(JSON.stringify(row))) await once(res, 'drain');
  };
  try {
    for await (const chunk of fs.createReadStream(file, { encoding: 'utf8' })) {
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (!inDataArray) {
          if (ch === '[') inDataArray = true;
          continue;
        }
        if (objectDepth === 0) {
          if (ch === ']') {
            inDataArray = false;
            break;
          }
          if (ch === '{') {
            objectDepth = 1;
            objectBuffer = '{';
            inString = false;
            escaped = false;
          }
          continue;
        }
        objectBuffer += ch;
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === String.fromCharCode(92)) escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') objectDepth++;
        else if (ch === '}') {
          objectDepth--;
          if (objectDepth === 0) {
            let row;
            try { row = JSON.parse(objectBuffer); } catch (_) { throw new Error('Cached row JSON is invalid'); }
            await emit(row);
            objectBuffer = '';
          }
        }
      }
      if (res.destroyed) return;
    }
    if (objectDepth !== 0 || !inDataArray) {
      // The normal cached format closes the data array after all objects.
      // inDataArray is false after the closing bracket has been seen.
      if (objectDepth !== 0) throw new Error('Cached JSON ended in an incomplete row');
    }
    if (emitted === 0 && totalRows > 0) {
      res.end('],"accessLimited":true,"message":"No rows match the assigned geographic scope. The source may not include verifiable Region, Area and Anchor Zone fields."}');
    } else {
      res.end(']}');
    }
  } catch (_) {
    if (!res.headersSent) return res.status(500).json({ error: 'Unable to filter cached dashboard data.' });
    res.destroy();
  }
}

module.exports = { normalize, firstValue, rowMatchesScopes, createDashboardSessionGuard, sendScopedJsonCache };
