'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeResource } = require('./authorization-core');

const employee = { status: 'ACTIVE' };
const permission = {
  resource_key: 'tab.sales-analysis',
  can_view: 1,
  can_filter: 1,
  can_export: 0,
  can_print: 0
};
const scopes = [{ region: 'North', area: 'Area A', anchorZone: 'Zone A1' }];
const context = { region: 'north', area: 'area a', anchorZone: 'zone a1' };

test('allows view for matching resource and exact geographic scope (case-insensitive)', () => {
  assert.equal(authorizeResource({ employee, resourceKey: 'tab.sales-analysis', action: 'view', permission, scopes, context }).allowed, true);
});

test('blocks scope from leaking to a different tab', () => {
  assert.equal(authorizeResource({ employee, resourceKey: 'tab.executive', action: 'view', permission, scopes, context }).allowed, false);
});

test('blocks an unassigned Area or Anchor Zone', () => {
  assert.equal(authorizeResource({ employee, resourceKey: 'tab.sales-analysis', action: 'view', permission, scopes, context: { ...context, anchorZone: 'Zone A2' } }).allowed, false);
});

test('blocks export when export permission is disabled', () => {
  assert.equal(authorizeResource({ employee, resourceKey: 'tab.sales-analysis', action: 'export', permission, scopes, context }).allowed, false);
});

test('blocks inactive employees', () => {
  assert.equal(authorizeResource({ employee: { status: 'INACTIVE' }, resourceKey: 'tab.sales-analysis', action: 'view', permission, scopes, context }).allowed, false);
});

test('fails closed when geographic scope is missing', () => {
  assert.equal(authorizeResource({ employee, resourceKey: 'tab.sales-analysis', action: 'view', permission, scopes: [], context }).allowed, false);
});
