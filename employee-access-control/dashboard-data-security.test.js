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
