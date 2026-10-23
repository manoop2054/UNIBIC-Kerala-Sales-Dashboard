'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rowMatchesScopes, firstValue } = require('./dashboard-data-security');

test('filters rows to the assigned Region, Area and Anchor Zone', () => {
  const scopes = [{ region: 'North', area: 'Kozhikode', anchorZone: 'Zone A' }];
  assert.equal(rowMatchesScopes({ Region: 'North', Area: 'Kozhikode', AnchorZoneName: 'Zone A' }, scopes), true);
  assert.equal(rowMatchesScopes({ Region: 'North', Area: 'Kozhikode', AnchorZoneName: 'Zone B' }, scopes), false);
  assert.equal(rowMatchesScopes({ Region: 'North', Area: 'Kannur', AnchorZoneName: 'Zone A' }, scopes), false);
  assert.equal(rowMatchesScopes({ Region: 'South', Area: 'Kozhikode', AnchorZoneName: 'Zone A' }, scopes), false);
});

test('supports broader Region and Area scopes while remaining fail-closed on missing geography', () => {
  assert.equal(rowMatchesScopes({ REGION: 'North', Area: 'Kozhikode' }, [{ region: 'North', area: '', anchorZone: '' }]), true);
  assert.equal(rowMatchesScopes({ REGION: 'North', Area: 'Kozhikode' }, [{ region: 'North', area: 'Kozhikode', anchorZone: '' }]), true);
  assert.equal(rowMatchesScopes({ ITEMID: 'A123', WAREHOUSE: 'CFA 1' }, [{ region: 'North', area: '', anchorZone: '' }]), false);
  assert.equal(rowMatchesScopes({ Region: 'North', Area: 'Kozhikode' }, [{ region: 'North', area: 'Kollam', anchorZone: '' }]), false);
});

test('Super Admin wildcard scope can read rows regardless of geography columns', () => {
  assert.equal(rowMatchesScopes({ ITEMID: 'A123', WAREHOUSE: 'CFA 1' }, [{ region: '*', area: '*', anchorZone: '*' }]), true);
});

test('geography field lookup is case and separator insensitive', () => {
  assert.equal(firstValue({ 'ANCHOR ZONENAME': 'Zone A' }, ['AnchorZoneName']), 'Zone A');
});

test('intersects geography scopes across resources so one permission cannot widen another', () => {
  const resourceScopes = [
    [{ region: 'North', area: '', anchorZone: '' }],
    [{ region: 'North', area: 'Kozhikode', anchorZone: '' }]
  ];
  assert.equal(rowMatchesScopes({ Region: 'North', Area: 'Kozhikode' }, resourceScopes), true);
  assert.equal(rowMatchesScopes({ Region: 'North', Area: 'Kannur' }, resourceScopes), false);
  assert.equal(rowMatchesScopes({ Region: 'South', Area: 'Kollam' }, resourceScopes), false);
});

const { createDashboardSessionGuard } = require('./dashboard-data-security');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('dashboard API guard rejects requests without an authenticated employee session', async () => {
  const guard = createDashboardSessionGuard({
    getPool: () => ({ query: async () => ({ rows: [] }) }),
    initializeDatabase: async () => {},
    getDatabaseStatus: () => ({ ready: true }),
    dataKind: 'gsv'
  });
  const res = responseRecorder();
  await guard({ headers: {} }, res, () => { throw new Error('next must not run'); });
  assert.equal(res.statusCode, 401);
});

test('non-Super-Admin LIVE SOH access follows explicit CFA-wise view permission without geographic scopes', async () => {
  const pool = {
    query: async sql => {
      if (sql.includes('FROM employee_sessions')) {
        return { rows: [{ session_id_hash: 'hash', employee_id: 'EMP001', employee_name: 'Test Employee', designation: 'Executive', role: 'ADMIN' }] };
      }
      if (sql.includes('FROM employee_permissions') && sql.includes('LIMIT 1')) {
        return { rows: [{ resource_key: 'tab.soh' }] };
      }
      throw new Error('Unexpected SQL in SOH permission test');
    }
  };
  const guard = createDashboardSessionGuard({
    getPool: () => pool,
    initializeDatabase: async () => {},
    getDatabaseStatus: () => ({ ready: true }),
    dataKind: 'soh'
  });
  const req = { headers: { cookie: 'eac_session=' + 'D'.repeat(43) } };
  const res = responseRecorder();
  let continued = false;
  await guard(req, res, () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(req.isSohPermissionOnly, true);
  assert.deepEqual(req.dataScopes, []);
});

test('LIVE SOH remains denied when the CFA-wise view permission is off', async () => {
  const pool = {
    query: async sql => {
      if (sql.includes('FROM employee_sessions')) {
        return { rows: [{ session_id_hash: 'hash', employee_id: 'EMP001', employee_name: 'Test Employee', designation: 'Executive', role: 'ADMIN' }] };
      }
      if (sql.includes('FROM employee_permissions') && sql.includes('LIMIT 1')) return { rows: [] };
      throw new Error('Unexpected SQL in SOH denial test');
    }
  };
  const guard = createDashboardSessionGuard({
    getPool: () => pool,
    initializeDatabase: async () => {},
    getDatabaseStatus: () => ({ ready: true }),
    dataKind: 'soh'
  });
  const res = responseRecorder();
  await guard({ headers: { cookie: 'eac_session=' + 'D'.repeat(43) } }, res, () => { throw new Error('next must not run'); });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /LIVE SOH view permission has not been assigned/);
});

test('dashboard API guard builds per-resource scope groups for authenticated employees', async () => {
  const pool = {
    query: async sql => {
      if (sql.includes('FROM employee_sessions')) {
        return { rows: [{ session_id_hash: 'hash', employee_id: 'EMP001', employee_name: 'Test Employee', designation: 'Executive', role: 'EMPLOYEE' }] };
      }
      if (sql.includes('FROM employee_permissions p')) {
        return { rows: [
          { resource_key: 'tab.sales', region: 'North', area: '', anchor_zone: '' },
          { resource_key: 'tab.reports', region: 'North', area: 'Kozhikode', anchor_zone: '' }
        ] };
      }
      throw new Error('Unexpected SQL in test');
    }
  };
  const guard = createDashboardSessionGuard({
    getPool: () => pool,
    initializeDatabase: async () => {},
    getDatabaseStatus: () => ({ ready: true }),
    dataKind: 'gsv'
  });
  const req = { headers: { cookie: 'eac_session=' + 'A'.repeat(43) } };
  const res = responseRecorder();
  let continued = false;
  await guard(req, res, () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(req.dataScopes.length, 2);
  assert.equal(rowMatchesScopes({ Region: 'North', Area: 'Kozhikode' }, req.dataScopes), true);
  assert.equal(rowMatchesScopes({ Region: 'North', Area: 'Kannur' }, req.dataScopes), false);
});

test('dashboard API guard fails closed when an employee has no matching resource scopes', async () => {
  const pool = {
    query: async sql => {
      if (sql.includes('FROM employee_sessions')) {
        return { rows: [{ session_id_hash: 'hash', employee_id: 'EMP001', employee_name: 'Test Employee', designation: 'Executive', role: 'EMPLOYEE' }] };
      }
      if (sql.includes('FROM employee_permissions p')) return { rows: [] };
      throw new Error('Unexpected SQL in test');
    }
  };
  const guard = createDashboardSessionGuard({
    getPool: () => pool,
    initializeDatabase: async () => {},
    getDatabaseStatus: () => ({ ready: true }),
    dataKind: 'gsv'
  });
  const res = responseRecorder();
  await guard({ headers: { cookie: 'eac_session=' + 'B'.repeat(43) } }, res, () => { throw new Error('next must not run'); });
  assert.equal(res.statusCode, 403);
});

test('protected Super Admin session bypasses geographic filtering only after authentication', async () => {
  const pool = {
    query: async sql => {
      if (sql.includes('FROM employee_sessions')) {
        return { rows: [{ session_id_hash: 'hash', employee_id: 'P2PUF7638', employee_name: 'Manoob', designation: 'Super Admin', role: 'SUPER_ADMIN' }] };
      }
      throw new Error('Super Admin should not query ordinary resource scopes');
    }
  };
  const guard = createDashboardSessionGuard({
    getPool: () => pool,
    initializeDatabase: async () => {},
    getDatabaseStatus: () => ({ ready: true }),
    dataKind: 'gsv'
  });
  const req = { headers: { cookie: 'eac_session=' + 'C'.repeat(43) } };
  const res = responseRecorder();
  let continued = false;
  await guard(req, res, () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(req.isProtectedSuperAdmin, true);
  assert.equal(rowMatchesScopes({ ITEMID: 'A123' }, req.dataScopes), true);
});
