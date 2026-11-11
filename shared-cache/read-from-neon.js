'use strict';

// Read-only access to the shared Neon cache. This module never writes to Neon.
// If SHARED_CACHE_DATABASE_URL is absent or Neon is unavailable, callers must
// continue through their existing GitHub/local-cache loaders.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const connectionString = process.env.SHARED_CACHE_DATABASE_URL;
const pool = connectionString ? new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 3500,
  idleTimeoutMillis: 10000,
  query_timeout: 60000,
  statement_timeout: 60000
}) : null;

if (pool) pool.on('error', error => console.warn('[shared-cache] idle connection error:', error.message));

async function activeDataset(client, kind) {
  const isGsv = kind === 'gsv';
  const pointer = isGsv ? 'active_gsv_refresh_id' : 'active_live_soh_refresh_id';
  const source = isGsv ? 'GSV' : 'LIVE_SOH';
  const result = await client.query(
    `SELECT p.${pointer} AS refresh_id, p.updated_at, l.row_count, l.refresh_status
       FROM public.cache_active_datasets p
       JOIN public.data_refresh_log l ON l.id = p.${pointer}
      WHERE p.singleton = TRUE AND l.source_name = $1 AND l.refresh_status = 'active'`,
    [source]
  );
  if (!result.rowCount || !result.rows[0].refresh_id) throw new Error('No active ' + source + ' shared-cache dataset');
  return result.rows[0];
}

function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    const onError = error => { stream.removeListener('drain', onDrain); reject(error); };
    const onDrain = () => { stream.removeListener('error', onError); resolve(); };
    if (stream.write(chunk)) resolve();
    else { stream.once('drain', onDrain); stream.once('error', onError); }
  });
}

async function getActiveDatasetVersion(kind) {
  if (!pool) throw new Error('SHARED_CACHE_DATABASE_URL is not configured');
  const client = await pool.connect();
  try {
    const meta = await activeDataset(client, kind);
    return { refreshId: meta.refresh_id, updatedAt: meta.updated_at, rows: Number(meta.row_count || 0) };
  } finally { client.release(); }
}

async function writeActiveDatasetJson(kind, filePath, transform) {
  if (!pool) throw new Error('SHARED_CACHE_DATABASE_URL is not configured');
  const table = kind === 'gsv' ? 'gsv_sales' : 'live_stock';
  const client = await pool.connect();
  const temp = filePath + '.neon.tmp';
  let stream;
  try {
    const meta = await activeDataset(client, kind);
    const expected = Number(meta.row_count || 0);
    if (!Number.isSafeInteger(expected) || expected < 1) throw new Error('Active shared-cache row count is invalid');
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    stream = fs.createWriteStream(temp, { encoding: 'utf8' });
    await writeChunk(stream, '{"data":[');
    let last = 0, count = 0, first = true;
    while (true) {
      const result = await client.query(
        `SELECT source_row_number, raw_data FROM public.${table}
          WHERE refresh_id = $1 AND source_row_number > $2
          ORDER BY source_row_number LIMIT 5000`,
        [meta.refresh_id, last]
      );
      if (!result.rowCount) break;
      const chunks = [];
      for (const row of result.rows) {
        last = Number(row.source_row_number);
        const value = transform ? transform(row.raw_data || {}) : (row.raw_data || {});
        chunks.push((first ? '' : ',') + JSON.stringify(value));
        first = false;
        count++;
      }
      await writeChunk(stream, chunks.join(''));
      if (count > expected) throw new Error('Shared-cache returned more rows than its active refresh log');
    }
    if (count !== expected) throw new Error('Shared-cache row validation failed: expected ' + expected + ', received ' + count);
    await writeChunk(stream, ']}');
    await new Promise((resolve, reject) => stream.end(error => error ? reject(error) : resolve()));
    stream = null;
    await fs.promises.rename(temp, filePath);
    return { rows: count, loadedAt: meta.updated_at, refreshId: meta.refresh_id, source: 'neon' };
  } catch (error) {
    if (stream) stream.destroy();
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function readActiveRows(kind) {
  if (!pool) throw new Error('SHARED_CACHE_DATABASE_URL is not configured');
  const table = kind === 'gsv' ? 'gsv_sales' : 'live_stock';
  const client = await pool.connect();
  try {
    const meta = await activeDataset(client, kind);
    const expected = Number(meta.row_count || 0);
    const rows = [];
    let last = 0;
    while (true) {
      const result = await client.query(
        `SELECT source_row_number, raw_data FROM public.${table}
          WHERE refresh_id = $1 AND source_row_number > $2
          ORDER BY source_row_number LIMIT 5000`,
        [meta.refresh_id, last]
      );
      if (!result.rowCount) break;
      for (const row of result.rows) {
        last = Number(row.source_row_number);
        rows.push(row.raw_data || {});
      }
      if (rows.length > expected) throw new Error('Shared-cache returned more rows than its active refresh log');
    }
    if (rows.length !== expected) throw new Error('Shared-cache row validation failed: expected ' + expected + ', received ' + rows.length);
    return { data: rows, rows: rows.length, loadedAt: meta.updated_at, refreshId: meta.refresh_id };
  } finally {
    client.release();
  }
}

async function readMbqGsvAggregate() {
  if (!pool) throw new Error('SHARED_CACHE_DATABASE_URL is not configured');
  const client = await pool.connect();
  try {
    const meta = await activeDataset(client, 'gsv');
    // Preferred path: the importer materializes this exact aggregation when
    // a GSV refresh is activated, avoiding a full 123k-row GROUP BY at startup.
    let result = null;
    try {
      result = await client.query(
        `SELECT item_id AS "itemId",
                posting_date::text AS date,
                month,
                cfa,
                ship_to_code AS "dbrCode",
                ship_to_name AS "dbrName",
                quantity,
                amount,
                amount_available AS "amountAvailable",
                row_count AS rows
           FROM public.gsv_mbq_aggregate
          WHERE refresh_id = $1
          ORDER BY item_id, posting_date, cfa, ship_to_code`,
        [meta.refresh_id]
      );
    } catch (error) {
      // Older cache schemas may not have the precomputed table yet. Keep the
      // existing live aggregation as a safe compatibility fallback.
      if (error.code !== '42P01') throw error;
    }
    if (!result || !result.rowCount) {
      result = await client.query(
        `SELECT item_id AS "itemId",
                posting_date::text AS date,
                to_char(posting_date, 'YYYY-MM') AS month,
                CASE
                  WHEN location_code ~* '\\mALU\\M' THEN 'ALU'
                  WHEN location_code ~* '\\mPAY\\M' THEN 'PAY'
                  WHEN location_code ~* '\\mTVD\\M' THEN 'TVD'
                  ELSE 'ALL'
                END AS cfa,
                COALESCE(ship_to_code, '') AS "dbrCode",
                COALESCE(MAX(ship_to_name), '') AS "dbrName",
                SUM(COALESCE(quantity_in_cbo, 0))::numeric AS quantity,
                SUM(COALESCE(amount_to_customer, 0))::numeric AS amount,
                BOOL_OR(amount_to_customer IS NOT NULL) AS "amountAvailable",
                COUNT(*)::integer AS rows
           FROM public.gsv_sales
          WHERE refresh_id = $1
            AND item_id IS NOT NULL AND posting_date IS NOT NULL AND quantity_in_cbo IS NOT NULL
          GROUP BY item_id, posting_date,
                   CASE
                     WHEN location_code ~* '\\mALU\\M' THEN 'ALU'
                     WHEN location_code ~* '\\mPAY\\M' THEN 'PAY'
                     WHEN location_code ~* '\\mTVD\\M' THEN 'TVD'
                     ELSE 'ALL'
                   END,
                   COALESCE(ship_to_code, '')
          ORDER BY item_id, posting_date, cfa, "dbrCode"`,
        [meta.refresh_id]
      );
    }
    const data = result.rows.map(row => ({
      ...row,
      quantity: Number(row.quantity || 0),
      amount: Number(row.amount || 0),
      amountAvailable: Boolean(row.amountAvailable),
      rows: Number(row.rows || 0)
    }));
    return {
      success: true,
      schemaVersion: 4,
      data,
      rows: Number(meta.row_count || 0),
      matchedRows: data.reduce((sum, row) => sum + row.rows, 0),
      aggregateRows: data.length,
      refreshId: meta.refresh_id,
      loadedAt: meta.updated_at,
      dateCoverage: { from: data.length ? data.reduce((min, row) => row.date < min ? row.date : min, data[0].date) : null,
                      to: data.length ? data.reduce((max, row) => row.date > max ? row.date : max, data[0].date) : null },
      source: 'neon-shared-cache'
    };
  } finally {
    client.release();
  }
}

async function readMbqSohRows() {
  const result = await readActiveRows('soh');
  return { ...result, sheet: 'LIVE STOCK REPORT' };
}

module.exports = {
  isConfigured: Boolean(pool),
  writeActiveDatasetJson,
  getActiveDatasetVersion,
  readActiveRows,
  readMbqGsvAggregate,
  readMbqSohRows
};
