'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesScope, authorizeResource } = require('./postgres-authorization');

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

test('fails closed if any geography level is missing', () => {
  assert.equal(matchesScope({ region: 'SOUTH-KL', area: 'Kochi', anchorZone: '' }, context), false);
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