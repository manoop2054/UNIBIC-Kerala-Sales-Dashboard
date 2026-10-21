'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountAccessControlRoutes, filterSharedDatasetPayload } = require('./access-control-routes');

test('mounts login, session, employee, password, permission and import APIs without public bootstrap', () => {
  const routes = [];
  const app = {
    get: (path, ...handlers) => routes.push({ method: 'GET', path, handlers }),
    post: (path, ...handlers) => routes.push({ method: 'POST', path, handlers }),
    put: (path, ...handlers) => routes.push({ method: 'PUT', path, handlers })
  };
  mountAccessControlRoutes(app, {
    getPool: () => null,
    initializeDatabase: async () => ({ configured: false, ready: false }),
    getDatabaseStatus: () => ({ configured: false, ready: false })
  });
  const keys = routes.map(route => route.method + ' ' + route.path);
  for (const expected of [
    'GET /api/access-control/status',
    'POST /api/access-control/login',
    'POST /api/access-control/logout',
    'GET /api/access-control/me',
    'GET /api/access-control/employees',
    'GET /api/access-control/audit-log',
    'POST /api/access-control/employees',
    'POST /api/access-control/employees/import',
    'POST /api/access-control/employees/import-file',
    'POST /api/access-control/employees/:employeeId/password',
    'PUT /api/access-control/employees/:employeeId/permissions'
  ]) assert.ok(keys.includes(expected), 'missing route: ' + expected);
  assert.equal(keys.some(key => key.includes('/bootstrap')), false);
});

test('the authenticated Super Admin receives canonical unrestricted resource permissions', async () => {
  const routes = [];
  const app = {
    get: (path, ...handlers) => routes.push({ method: 'GET', path, handlers }),
    post: (path, ...handlers) => routes.push({ method: 'POST', path, handlers }),
    put: (path, ...handlers) => routes.push({ method: 'PUT', path, handlers })
  };
  mountAccessControlRoutes(app, {
    getPool: () => ({ query: async () => ({ rows: [] }) }),
    initializeDatabase: async () => ({ configured: true, ready: true }),
    getDatabaseStatus: () => ({ configured: true, ready: true })
  });
  const route = routes.find(item => item.method === 'GET' && item.path === '/api/access-control/me');
  let payload;
  await route.handlers[1]({
    accessUser: { employeeId: 'P2PUF7638', employeeName: 'Manoob', designation: 'Super Admin', role: 'SUPER_ADMIN' }
  }, { json(value) { payload = value; return this; }, status() { return this; } });
  assert.equal(payload.success, true);
  assert.ok(payload.permissions.some(permission => permission.resourceKey === 'tab.reports' && permission.canExport));
  assert.ok(payload.permissions.every(permission => permission.canView && permission.canFilter && permission.canExport && permission.canPrint));
});

test('Employee Master and permission mutation routes require session and admin middleware', () => {
  const routes = [];
  const app = {
    get: (path, ...handlers) => routes.push({ method: 'GET', path, handlers }),
    post: (path, ...handlers) => routes.push({ method: 'POST', path, handlers }),
    put: (path, ...handlers) => routes.push({ method: 'PUT', path, handlers })
  };
  mountAccessControlRoutes(app, {
    getPool: () => null,
    initializeDatabase: async () => ({ configured: false, ready: false }),
    getDatabaseStatus: () => ({ configured: false, ready: false })
  });
  const protectedPaths = [
    'GET /api/access-control/employees',
    'POST /api/access-control/employees',
    'POST /api/access-control/employees/import',
    'POST /api/access-control/employees/:employeeId/password',
    'PUT /api/access-control/employees/:employeeId/permissions'
  ];
  for (const key of protectedPaths) {
    const [method, path] = key.split(' ');
    const route = routes.find(item => item.method === method && item.path === path);
    assert.ok(route && route.handlers.length >= 3, key + ' must include session and role middleware');
  }
});


test('shared Target/Claims payloads are filtered to assigned geographic scope', () => {
  const payload = {
    ok: true, uploaded: true,
    data: { headers: ['Region', 'Area', 'Anchor Zone', 'Value'], rows: [
      ['North', 'Kozhikode', 'Zone A', 10],
      ['North', 'Kannur', 'Zone B', 20],
      ['South', 'Kollam', 'Zone C', 30]
    ] }
  };
  const result = filterSharedDatasetPayload(payload, [{ region: 'North', area: 'Kozhikode', anchorZone: 'Zone A' }]);
  assert.equal(result.data.rows.length, 1);
  assert.equal(result.data.rows[0][3], 10);
  assert.equal(result.data.accessLimited, true);
  assert.equal(result.data.rowCount, 1);
});

test('shared dataset filtering fails closed when geography is missing or response shape is unsupported', () => {
  const noGeography = filterSharedDatasetPayload({
    ok: true, uploaded: true, data: { rows: [{ ITEMID: 'A1', WAREHOUSE: 'CFA 1' }] }
  }, [{ region: 'North', area: '', anchorZone: '' }]);
  assert.equal(noGeography.data.rows.length, 0);
  assert.equal(noGeography.data.accessLimited, true);

  const unsupported = filterSharedDatasetPayload({ ok: true, uploaded: true, data: { records: [{ Region: 'North' }] } },
    [{ region: 'North', area: '', anchorZone: '' }]);
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error, /access denied/i);
});
