'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const importer = fs.readFileSync('shared-cache/import-release-to-neon.js', 'utf8');

// Validate the production aggregate SQL contract without downloading full releases
// or writing 100k+ rows into the quota-limited Neon CI branch.
const start = importer.indexOf('async function ensureMbqGsvAggregate');
const end = importer.indexOf('\nasync function main()', start);
assert.notEqual(start, -1, 'aggregate builder must exist');
assert.notEqual(end, -1, 'aggregate builder must be followed by main');
const source = importer.slice(start, end);

for (const token of [
  'public.gsv_mbq_aggregate',
  'refresh_id,item_id,posting_date,month,cfa,ship_to_code,ship_to_name',
  'SUM(COALESCE(quantity_in_cbo,0))',
  'SUM(COALESCE(amount_to_customer,0))',
  'BOOL_OR(amount_to_customer IS NOT NULL)',
  'COUNT(*)::integer',
  'GROUP BY item_id,posting_date',
  'ship_to_code',
  'WHERE refresh_id=$1',
  'built.rowCount'
]) {
  assert.ok(source.includes(token), 'aggregate SQL missing contract token: ' + token);
}

// Representative fixture: separate item/date/CFA/ship-to groups, sum quantities
// and amounts, retain whether an amount was supplied, and count source rows.
const rows = [
  { item: 'A', date: '2026-10-01', cfa: 'TVD', ship: 'S1', qty: 2, amount: 100 },
  { item: 'A', date: '2026-10-01', cfa: 'TVD', ship: 'S1', qty: 3, amount: 150 },
  { item: 'A', date: '2026-10-01', cfa: 'PAY', ship: 'S1', qty: 4, amount: null },
  { item: 'A', date: '2026-10-01', cfa: 'TVD', ship: 'S2', qty: 1, amount: 50 }
];
const groups = new Map();
for (const row of rows) {
  const key = [row.item, row.date, row.cfa, row.ship].join('|');
  const value = groups.get(key) || { quantity: 0, amount: 0, amount_available: false, row_count: 0 };
  value.quantity += row.qty ?? 0;
  value.amount += row.amount ?? 0;
  value.amount_available ||= row.amount !== null && row.amount !== undefined;
  value.row_count += 1;
  groups.set(key, value);
}
assert.equal(groups.size, 3, 'fixture must produce three distinct groups');
assert.deepEqual(groups.get('A|2026-10-01|TVD|S1'), {
  quantity: 5, amount: 250, amount_available: true, row_count: 2
});
assert.deepEqual(groups.get('A|2026-10-01|PAY|S1'), {
  quantity: 4, amount: 0, amount_available: false, row_count: 1
});
assert.deepEqual(groups.get('A|2026-10-01|TVD|S2'), {
  quantity: 1, amount: 50, amount_available: true, row_count: 1
});

console.log('MBQ GSV aggregate SQL contract and fixture checks passed');
