'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', 'UNIBIC_Kerala_Sales_Command_Center_FINAL_PATCHED.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const start = html.lastIndexOf('async function loadLiveData(){');
const end = html.indexOf('\n/* Reload once DOM is ready */', start);
if (start < 0 || end < 0) throw new Error('Could not locate the active dashboard data loader.');
const loaderSource = html.slice(start, end).trim();

function response(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return payload; }
  };
}

async function runLoader(responses) {
  const statusUpdates = [];
  let refreshCount = 0;
  const context = {
    fetch: async url => {
      if (!(url in responses)) throw new Error('Unexpected URL: ' + url);
      return responses[url];
    },
    payloadRows: payload => Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload?.rows) ? payload.rows : [])),
    norm: row => ({ ...row, normalized: true }),
    setStatus: value => statusUpdates.push(value),
    refreshAllDataViews: () => { refreshCount++; },
    console,
    window: {},
    gsvRows: [],
    activeRows: [],
    soh: [],
    filteredSOH: [],
    lastElement: { textContent: '' },
    $: id => id === 'last' ? context.lastElement : null
  };
  await vm.runInNewContext(loaderSource + '\nloadLiveData();', context);
  return { context, statusUpdates, refreshCount };
}

test('GSV denial does not block an employee who has LIVE SOH permission', async () => {
  const { context, statusUpdates, refreshCount } = await runLoader({
    '/api/gsv': response(403, { error: 'No GSV permission' }),
    '/api/live-soh': response(200, { data: [{ ITEMID: 'A1', WAREHOUSE: 'CFA 1' }] })
  });
  assert.equal(context.gsvRows.length, 0);
  assert.equal(context.soh.length, 1);
  assert.equal(context.soh[0].ITEMID, 'A1');
  assert.equal(refreshCount, 1);
  assert.equal(statusUpdates.at(-1), 'Connected (limited access)');
});

test('LIVE SOH denial does not block an employee who has GSV permission', async () => {
  const { context, statusUpdates, refreshCount } = await runLoader({
    '/api/gsv': response(200, { data: [{ Region: 'North' }] }),
    '/api/live-soh': response(403, { error: 'No SOH permission' })
  });
  assert.equal(context.gsvRows.length, 1);
  assert.equal(context.soh.length, 0);
  assert.equal(refreshCount, 1);
  assert.equal(statusUpdates.at(-1), 'Connected (limited access)');
});

test('two dataset-specific permission denials do not stop separately permitted tabs from refreshing', async () => {
  const { context, statusUpdates, refreshCount } = await runLoader({
    '/api/gsv': response(403, { error: 'No GSV permission' }),
    '/api/live-soh': response(403, { error: 'No SOH permission' })
  });
  assert.equal(context.gsvRows.length, 0);
  assert.equal(context.soh.length, 0);
  assert.equal(refreshCount, 1);
  assert.equal(statusUpdates.at(-1), 'Connected (limited access)');
});

test('a server error is reported as a partial data issue rather than a permission denial', async () => {
  const { context, statusUpdates, refreshCount } = await runLoader({
    '/api/gsv': response(500, { error: 'GSV failed' }),
    '/api/live-soh': response(200, { data: [{ ITEMID: 'A1' }] })
  });
  assert.equal(context.gsvRows.length, 0);
  assert.equal(context.soh.length, 1);
  assert.equal(refreshCount, 1);
  assert.equal(statusUpdates.at(-1), 'Connected (partial data)');
});
