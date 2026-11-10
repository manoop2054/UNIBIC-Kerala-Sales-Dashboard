'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');

async function main() {
  const url = process.env.SHARED_CACHE_DATABASE_URL;
  if (!url) throw new Error('SHARED_CACHE_DATABASE_URL test secret is required');

  const guardPool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const guard = await guardPool.query('SELECT marker FROM public.shared_cache_test_guard WHERE id=1');
    assert.equal(guard.rows[0]?.marker, 'only-this-test-branch', 'Refusing to test against a database without the isolated test-branch guard');
  } finally {
    await guardPool.end();
  }

  const reader = require('./read-from-neon');
  assert.equal(reader.isConfigured, true, 'Shared cache reader should be configured for this test');
  const gsv = await reader.readMbqGsvAggregate();
  assert.equal(gsv.rows, 123191, 'GSV source row count');
  assert.equal(gsv.matchedRows, 123191, 'GSV matched row count');
  assert.ok(gsv.aggregateRows > 0, 'GSV aggregate must not be empty');
  assert.equal(gsv.dateCoverage.from, '2024-04-02');
  assert.equal(gsv.dateCoverage.to, '2026-11-09');
  assert.ok(gsv.data.some(row => ['ALU', 'PAY', 'TVD'].includes(row.cfa)), 'Expected CFA groups in MBQ aggregate');

  const soh = await reader.readMbqSohRows();
  assert.equal(soh.rows, 13151, 'LIVE SOH row count');
  assert.equal(soh.data.length, 13151, 'LIVE SOH payload length');
  assert.equal(soh.sheet, 'LIVE STOCK REPORT');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unibic-shared-cache-reader-'));
  try {
    const gsvFile = path.join(dir, 'gsv.json');
    const sohFile = path.join(dir, 'soh.json');
    const gsvWritten = await reader.writeActiveDatasetJson('gsv', gsvFile);
    const sohWritten = await reader.writeActiveDatasetJson('soh', sohFile);
    assert.equal(gsvWritten.rows, 123191, 'Command Centre GSV file row count');
    assert.equal(sohWritten.rows, 13151, 'Command Centre SOH file row count');
    for (const file of [gsvFile, sohFile]) {
      const stat = await fs.stat(file);
      assert.ok(stat.size > 100, 'Serialized cache file should contain data');
      const handle = await fs.open(file, 'r');
      try {
        const start = Buffer.alloc(9);
        const end = Buffer.alloc(2);
        await handle.read(start, 0, start.length, 0);
        await handle.read(end, 0, end.length, stat.size - 2);
        assert.equal(start.toString('utf8'), '{"data":[');
        assert.equal(end.toString('utf8'), ']}');
      } finally {
        await handle.close();
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  console.log('Shared Neon reader integration passed:', JSON.stringify({
    gsvRows: gsv.rows,
    gsvAggregateRows: gsv.aggregateRows,
    dateCoverage: gsv.dateCoverage,
    sohRows: soh.rows,
    commandCentreFiles: 'GSV + SOH serialized successfully'
  }));
}

main().catch(error => {
  console.error('Shared Neon reader integration failed:', error.stack || error.message);
  process.exitCode = 1;
});
