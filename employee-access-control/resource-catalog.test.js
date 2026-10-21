'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeResourceKey, normalizeResourceList } = require('./resource-catalog');

test('maps employee-facing tab labels to canonical dashboard resource IDs', () => {
  assert.equal(normalizeResourceKey('Executive Dashboard'), 'tab.executive');
  assert.equal(normalizeResourceKey('Target vs Achievement'), 'tab.target');
  assert.equal(normalizeResourceKey('Sales Analysis'), 'tab.sales');
  assert.equal(normalizeResourceKey('Item Intelligence'), 'tab.item');
  assert.equal(normalizeResourceKey('DCR From Leap'), 'tab.dbr');
  assert.equal(normalizeResourceKey('Invoice / Customer'), 'tab.invoice');
  assert.equal(normalizeResourceKey('LIVE SOH'), 'tab.soh');
  assert.equal(normalizeResourceKey('Report Center'), 'tab.reports');
  assert.equal(normalizeResourceKey('Admin Center'), 'tab.admincenter');
  assert.equal(normalizeResourceKey('Monthly Upload'), 'tab.upload');
  assert.equal(normalizeResourceKey('Target Management'), 'tab.targetworking');
});

test('deduplicates aliases and rejects labels that could accidentally grant all access', () => {
  assert.deepEqual(normalizeResourceList(['Sales Analysis', 'sales', 'Report Center']), ['tab.sales', 'tab.reports']);
  assert.throws(() => normalizeResourceKey('All Access'), /Unknown dashboard resource/);
  assert.throws(() => normalizeResourceKey('Unlisted Report'), /Unknown dashboard resource/);
  assert.throws(() => normalizeResourceList([]), /At least one allowed dashboard resource/);
});
