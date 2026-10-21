'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesScope, authorizeResource, createResourceGuard } = require('./postgres-authorization');

function fakePool({ status = 'ACTIVE', permission = { can_view: true, can_filter: true, can_export: false, can_print: false }, scopes = [{ region: 'SOUTH-KL', area: 'Kochi', anchor_zone: 'ZONE-A' }] } = {}) {
  return {
    async query(sql) {
      if (sql.includes('SELECT status FROM employees')) return { rows: status ? [{ status }] : [] };
      if (sql.includes('SELECT can_view')) return { rows: permission ? [permission] : [] };
      if (sql.includes('SELECT region, area, anchor_zone')) return { rows: scopes };
      throw new Error('Unexpected SQL in test: ' + sql);
    }
  };
}

const context = { region: 'south-kl', area: 'kochi', anchorZone: 'zone-a' };

test('matches all three geography levels case-insensitively', () => {
  assert.equal(matchesScope({ region: 'SOUTH-KL', area: 'Kochi', anchorZone: 'ZONE-A' }, context), true);
});

test('supports Region-wide, Area-wide, and exact Anchor Zone scopes', () => {
  assert.equal(matchesScope({ region: 'SOUTH-KL', area: '', anchorZone: '' }, context), true);
  assert.equal(matchesScope({ region: 'SOUTH-KL', area: 'Kochi', anchorZone: '' }, context), true);
  assert.equal(matchesScope({ region: 'SOUTH-KL', area: 'Kochi', anchorZone: 'ZONE-A' }, context), true);
  assert.equal(matchesScope({ region: 'SOUTH-KL', area: 'Kottayam', anchorZone: '' }, context), false);
  assert.equal(matchesScope({ region: 'SOUTH-KL', area: '', anchorZone: 'ZONE-A' }, context), false);
  assert.equal(matchesScope({ region: '', area: '', anchorZone: '' }, context), false);
});

test('allows only a granted action for matching resource and scope', async () => {
  const result = await authorizeResource(fakePool(), 'EMP001', 'tab.sales-analysis', 'view', context);
  assert.deepEqual(result, { allowed: true, reason: 'allowed' });
});

test('blocks inactive employees', async () => {
  const result = await authorizeResource(fakePool({ status: 'INACTIVE' }), 'EMP001', 'tab.sales-analysis', 'view', context);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'employee-inactive-or-missing');
});

test('blocks actions not explicitly granted', async () => {
  const result = await authorizeResource(fakePool(), 'EMP001', 'tab.sales-analysis', 'export', context);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'action-not-permitted');
});

test('blocks missing permissions and missing scopes', async () => {
  const noPermission = await authorizeResource(fakePool({ permission: null }), 'EMP001', 'tab.sales-analysis', 'view', context);
  const noScope = await authorizeResource(fakePool({ scopes: [] }), 'EMP001', 'tab.sales-analysis', 'view', context);
  assert.equal(noPermission.reason, 'resource-permission-missing');
  assert.equal(noScope.reason, 'geographic-scope-missing');
});

test('blocks a different Anchor Zone', async () => {
  const result = await authorizeResource(fakePool(), 'EMP001', 'tab.sales-analysis', 'view', { ...context, anchorZone: 'ZONE-B' });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'outside-resource-geographic-scope');
});

test('blocks an unknown action', async () => {
  const result = await authorizeResource(fakePool(), 'EMP001', 'tab.sales-analysis', 'delete', context);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'unknown-action');
});

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('resource guard permits the protected Super Admin after upstream authentication', async () => {
  const guard = createResourceGuard({
    pool: fakePool(),
    resourceKey: 'tab.sales-analysis',
    action: 'view',
    getTrustedContext: async () => { throw new Error('Super Admin should not need a restricted geographic scope'); }
  });
  const req = { accessUser: { employeeId: 'p2puf7638', role: 'SUPER_ADMIN' } };
  const res = responseRecorder();
  let nextCalled = false;
  await guard(req, res, error => { if (error) throw error; nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test('resource guard does not let an ordinary Admin bypass explicit permissions', async () => {
  const guard = createResourceGuard({
    pool: fakePool({ permission: { can_view: false, can_filter: true, can_export: false, can_print: false } }),
    resourceKey: 'tab.sales-analysis',
    action: 'view',
    getTrustedContext: async () => context
  });
  const req = { accessUser: { employeeId: 'ADMIN001', role: 'ADMIN', isAdmin: true } };
  const res = responseRecorder();
  let nextCalled = false;
  await guard(req, res, error => { if (error) throw error; nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.reason, 'action-not-permitted');
});

test('resource guard rejects missing authentication', async () => {
  const guard = createResourceGuard({
    pool: fakePool(),
    resourceKey: 'tab.sales-analysis',
    action: 'view',
    getTrustedContext: async () => context
  });
  const res = responseRecorder();
  await guard({ accessUser: null }, res, () => assert.fail('next must not run'));
  assert.equal(res.statusCode, 401);
});
