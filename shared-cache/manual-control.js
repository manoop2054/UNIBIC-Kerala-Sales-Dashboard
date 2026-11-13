'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');

let refreshProcess = null;
let refreshStarting = false;
let refreshState = { status: 'idle', startedAt: null, completedAt: null, error: null };
let statusPool = null;
let statusSchemaReady = null;
let releaseCache = { expiresAt: 0, value: null };

// Keep the endpoint switch check lightweight for dashboard data loaders.
// The old getStatus() path also queried Neon diagnostics and GitHub metadata,
// which could block every GSV/SOH load while Neon was waking up.
let endpointStateCache = { expiresAt: 0, value: null, pending: null };
let diagnosticsCache = { expiresAt: 0, value: null, error: null, pending: null };
const ENDPOINT_STATE_TTL_MS = 15000;
const ENDPOINT_STATE_STALE_MS = 5 * 60 * 1000;
const NEON_CONTROL_TIMEOUT_MS = 6000;
const DIAGNOSTICS_TTL_MS = 60000;

async function getEndpointState(force = false) {
  if (!force && endpointStateCache.value && endpointStateCache.expiresAt > Date.now()) return endpointStateCache.value;
  if (!force && endpointStateCache.pending) return endpointStateCache.pending;
  endpointStateCache.pending = neonRequest('GET').then(endpoint => {
    endpointStateCache.value = endpoint;
    endpointStateCache.expiresAt = Date.now() + ENDPOINT_STATE_TTL_MS;
    return endpoint;
  }).catch(error => {
    console.warn('[NEON CONTROL] Endpoint state unavailable; retaining safe read-through fallback:', error.message);
    if (endpointStateCache.value && Date.now() <= endpointStateCache.expiresAt + ENDPOINT_STATE_STALE_MS) {
      return endpointStateCache.value;
    }
    // Read-only data loaders may still try Neon; if it is OFF/unreachable they
    // fall back to the existing GitHub loader. Control writes always require a
    // fresh successful Neon API response.
    return { id: ENDPOINT_ID, disabled: false, current_state: 'unknown', controlFallback: true };
  }).finally(() => { endpointStateCache.pending = null; });
  return endpointStateCache.pending;
}

function refreshDiagnosticsInBackground() {
  if (diagnosticsCache.pending || (diagnosticsCache.value && diagnosticsCache.expiresAt > Date.now())) return;
  diagnosticsCache.pending = getDiagnostics().then(value => {
    diagnosticsCache.value = value;
    diagnosticsCache.error = null;
    diagnosticsCache.expiresAt = Date.now() + DIAGNOSTICS_TTL_MS;
  }).catch(error => {
    diagnosticsCache.error = error.message || String(error);
    diagnosticsCache.expiresAt = Date.now() + 5000;
  }).finally(() => { diagnosticsCache.pending = null; });
}

const PROJECT_ID = process.env.SHARED_CACHE_PROJECT_ID || 'snowy-sky-65564833';
const ENDPOINT_ID = process.env.SHARED_CACHE_ENDPOINT_ID || 'ep-rapid-dust-a1197lo4';
const API_BASE = 'https://console.neon.tech/api/v2';
const REPO = 'manoop2054/UNIBIC-Kerala-Sales-Dashboard';
const ASSETS = {
  GSV: 'KL.LIVE.GSV.LINK-MANOOB.xlsx',
  LIVE_SOH: 'LIVE.STOCK.xlsb'
};

function getStatusPool() {
  if (!process.env.SHARED_CACHE_DATABASE_URL) {
    const error = new Error('SHARED_CACHE_DATABASE_URL is missing; sync diagnostics cannot connect to Neon.');
    error.status = 503;
    throw error;
  }
  if (!statusPool) {
    statusPool = new Pool({
      connectionString: process.env.SHARED_CACHE_DATABASE_URL,
      ssl: process.env.SHARED_CACHE_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: 2,
      connectionTimeoutMillis: 15000,
      statement_timeout: 30000
    });
  }
  return statusPool;
}

async function ensureStatusStore() {
  if (!statusSchemaReady) {
    statusSchemaReady = (async () => {
      const pool = getStatusPool();
      await pool.query(
        'CREATE TABLE IF NOT EXISTS public.shared_cache_sync_runs (' +
        'run_id uuid PRIMARY KEY, status text NOT NULL, requested_by text NOT NULL DEFAULT \'SUPER_ADMIN\',' +
        'started_at timestamptz NOT NULL DEFAULT NOW(), completed_at timestamptz,' +
        'github_release text, github_assets jsonb NOT NULL DEFAULT \'{}\'::jsonb,' +
        'before_active jsonb NOT NULL DEFAULT \'[]\'::jsonb, after_active jsonb NOT NULL DEFAULT \'[]\'::jsonb,' +
        'source_results jsonb NOT NULL DEFAULT \'{}\'::jsonb, log_lines jsonb NOT NULL DEFAULT \'[]\'::jsonb,' +
        'error_message text)'
      );
      await pool.query('CREATE INDEX IF NOT EXISTS shared_cache_sync_runs_started_idx ON public.shared_cache_sync_runs(started_at DESC)');
    })().catch(error => {
      statusSchemaReady = null;
      throw error;
    });
  }
  return statusSchemaReady;
}

async function getGithubReleaseInfo() {
  if (releaseCache.expiresAt > Date.now() && releaseCache.value) return releaseCache.value;
  const headers = { 'User-Agent': 'UNIBIC-Manual-Neon-Sync', 'Accept': 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  const response = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(payload.assets)) {
    throw new Error('Unable to read latest GitHub release metadata (HTTP ' + response.status + ').');
  }
  const assets = {};
  for (const [key, name] of Object.entries(ASSETS)) {
    const asset = payload.assets.find(item => item.name === name);
    if (!asset) throw new Error('Latest GitHub release ' + (payload.tag_name || '') + ' is missing ' + name + '.');
    assets[key] = {
      name: asset.name,
      uploadedAt: asset.created_at || null,
      updatedAt: asset.updated_at || null,
      sizeBytes: Number(asset.size) || 0,
      downloadUrl: asset.browser_download_url || null
    };
  }
  const value = { tag: payload.tag_name || '', publishedAt: payload.published_at || null, assets };
  releaseCache = { expiresAt: Date.now() + 30000, value };
  return value;
}

async function getActiveSnapshot() {
  const pool = getStatusPool();
  const result = await pool.query(
    'WITH active AS (' +
    ' SELECT \'GSV\'::text AS source_name, active_gsv_refresh_id AS id FROM public.cache_active_datasets WHERE singleton=TRUE' +
    ' UNION ALL SELECT \'LIVE_SOH\'::text, active_live_soh_refresh_id FROM public.cache_active_datasets WHERE singleton=TRUE' +
    ') SELECT a.source_name, d.id::text AS refresh_id, d.refresh_status, d.row_count,' +
    ' d.started_at, d.completed_at, d.asset_name, d.file_checksum, d.file_bytes, d.validation_summary' +
    ' FROM active a LEFT JOIN public.data_refresh_log d ON d.id=a.id WHERE a.id IS NOT NULL ORDER BY a.source_name'
  );
  return result.rows.map(row => ({
    source: row.source_name,
    refreshId: row.refresh_id,
    status: row.refresh_status,
    rows: Number(row.row_count) || 0,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    asset: row.asset_name,
    checksum: row.file_checksum,
    sizeBytes: Number(row.file_bytes) || 0,
    validation: row.validation_summary
  }));
}

function compareSources(before, after, exitCode) {
  const result = {};
  for (const source of ['GSV', 'LIVE_SOH']) {
    const oldRow = (before || []).find(item => item.source === source);
    const newRow = (after || []).find(item => item.source === source);
    if (exitCode !== 0) {
      result[source] = { status: 'FAILED — OLD CACHE RETAINED', oldRefreshId: oldRow && oldRow.refreshId || null, activeRefreshId: newRow && newRow.refreshId || null };
    } else if (oldRow && newRow && oldRow.refreshId === newRow.refreshId) {
      result[source] = { status: 'ALREADY CURRENT — NO NEW IMPORT NEEDED', oldRefreshId: oldRow.refreshId, activeRefreshId: newRow.refreshId };
    } else {
      result[source] = { status: 'UPDATED — NEW CACHE ACTIVE', oldRefreshId: oldRow && oldRow.refreshId || null, activeRefreshId: newRow && newRow.refreshId || null };
    }
    if (newRow) {
      result[source].rows = newRow.rows;
      result[source].cacheUpdatedAt = newRow.completedAt;
      result[source].asset = newRow.asset;
      result[source].checksum = newRow.checksum;
    }
  }
  return result;
}

async function neonRequest(method, body) {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) {
    const error = new Error('Neon control is not configured. Add NEON_API_KEY to this Render service.');
    error.status = 503;
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NEON_CONTROL_TIMEOUT_MS);
  try {
    const response = await fetch(API_BASE + '/projects/' + encodeURIComponent(PROJECT_ID) +
      '/endpoints/' + encodeURIComponent(ENDPOINT_ID), {
        method,
        signal: controller.signal,
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.endpoint) {
      const error = new Error('Neon control API request failed (HTTP ' + response.status + ').');
      error.status = response.status >= 400 && response.status < 500 ? 502 : 503;
      throw error;
    }
    return payload.endpoint;
  } catch (cause) {
    const error = new Error(cause && cause.name === 'AbortError'
      ? 'Neon control API timed out after ' + NEON_CONTROL_TIMEOUT_MS + ' ms.'
      : (cause.message || 'Neon control API request failed.'));
    error.status = 503;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function reconcileInterruptedRun(pool) {
  if (refreshProcess || refreshStarting) return;
  const result = await pool.query(
    "UPDATE public.shared_cache_sync_runs SET status='interrupted', completed_at=NOW(), " +
    "error_message=COALESCE(error_message,'Render process ended before importer completion; active cache was retained.'), " +
    "log_lines=COALESCE(log_lines,'[]'::jsonb) || jsonb_build_array('Interrupted run recovered automatically after service restart; active cache retained.') " +
    "WHERE status='running' AND started_at < NOW() - INTERVAL '3 minutes' RETURNING run_id::text"
  );
  if (result.rowCount) {
    console.warn('[NEON MANUAL PUSH] Recovered ' + result.rowCount + ' stale RUNNING run(s) as INTERRUPTED; active cache unchanged.');
  }
}

async function getDiagnostics() {
  await ensureStatusStore();
  const pool = getStatusPool();
  await reconcileInterruptedRun(pool);
  const [release, active, latest] = await Promise.all([
    getGithubReleaseInfo(),
    getActiveSnapshot(),
    pool.query('SELECT run_id::text, status, requested_by, started_at, completed_at, github_release, github_assets, before_active, after_active, source_results, log_lines, error_message FROM public.shared_cache_sync_runs ORDER BY started_at DESC LIMIT 1')
  ]);
  const row = latest.rows[0];
  return {
    github: release,
    activeDatasets: active,
    latestRun: row ? {
      runId: row.run_id,
      status: row.status,
      requestedBy: row.requested_by,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      release: row.github_release,
      githubAssets: row.github_assets,
      before: row.before_active,
      after: row.after_active,
      sourceResults: row.source_results,
      logs: row.log_lines,
      error: row.error_message
    } : null
  };
}

async function startReleaseRefresh(requestedBy) {
  if (refreshProcess || refreshStarting) return { ...refreshState, status: 'running' };
  refreshStarting = true;
  try {
  const script = path.join(__dirname, 'import-release-to-neon.js');
  if (!process.env.SHARED_CACHE_DATABASE_URL) throw new Error('SHARED_CACHE_DATABASE_URL is missing; GitHub-to-Neon sync cannot start.');
  if (!fs.existsSync(script)) throw new Error('GitHub-to-Neon importer is missing from this Render release.');

  const endpoint = await neonRequest('GET');
  if (endpoint.disabled) await neonRequest('PATCH', { endpoint: { disabled: false } });
  await ensureStatusStore();
  const [release, before] = await Promise.all([getGithubReleaseInfo(), getActiveSnapshot()]);

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const pool = getStatusPool();
  await reconcileInterruptedRun(pool);
  await pool.query(
    'INSERT INTO public.shared_cache_sync_runs(run_id,status,requested_by,started_at,github_release,github_assets,before_active)' +
    ' VALUES($1,\'running\',$2,$3,$4,$5::jsonb,$6::jsonb)',
    [runId, requestedBy || 'SUPER_ADMIN', startedAt, release.tag, JSON.stringify(release.assets), JSON.stringify(before)]
  );
  refreshState = { runId, status: 'running', startedAt, completedAt: null, error: null, release: release.tag };
  console.log('[NEON MANUAL PUSH] START | runId=' + runId + ' | release=' + release.tag + ' | startedAt=' + startedAt);

  const child = spawn(process.execPath, [script], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  refreshProcess = child;
  refreshStarting = false;
  const logLines = [];
  let finished = false;
  const pipe = (stream, label) => {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        const entry = '[' + label + '] ' + line;
        logLines.push(entry);
        if (logLines.length > 40) logLines.shift();
        console.log('[NEON REFRESH][' + label + '] ' + line);
      }
    });
    stream.on('end', () => {
      if (pending) {
        const entry = '[' + label + '] ' + pending;
        logLines.push(entry);
        if (logLines.length > 40) logLines.shift();
        console.log('[NEON REFRESH][' + label + '] ' + pending);
      }
    });
  };
  pipe(child.stdout, 'OUT');
  pipe(child.stderr, 'ERR');

  const finish = async (code, error) => {
    if (finished) return;
    finished = true;
    try {
      const after = await getActiveSnapshot();
      const sourceResults = compareSources(before, after, code);
      const status = code === 0 ? 'success' : 'failed';
      const message = code === 0 ? null : (error || 'Importer exited with code ' + code);
      await pool.query(
        'UPDATE public.shared_cache_sync_runs SET status=$2,completed_at=NOW(),after_active=$3::jsonb,source_results=$4::jsonb,log_lines=$5::jsonb,error_message=$6 WHERE run_id=$1',
        [runId, status, JSON.stringify(after), JSON.stringify(sourceResults), JSON.stringify(logLines), message]
      );
      refreshState = { runId, status, startedAt, completedAt: new Date().toISOString(), error: message, release: release.tag, sourceResults };
      console.log('[NEON MANUAL PUSH] ' + status.toUpperCase() + ' | runId=' + runId + ' | GSV=' + sourceResults.GSV.status + ' | LIVE_SOH=' + sourceResults.LIVE_SOH.status);
    } catch (persistError) {
      refreshState = { runId, status: 'failed', startedAt, completedAt: new Date().toISOString(), error: 'Sync finished but diagnostics could not be saved: ' + persistError.message, release: release.tag };
      console.error('[NEON MANUAL PUSH] DIAGNOSTICS SAVE FAILED |', persistError.message);
    } finally {
      refreshProcess = null;
    }
  };

  child.on('error', error => { finish(1, error.message); });
  child.on('close', code => { finish(code, code === 0 ? null : 'Importer exited with code ' + code); });
  return { ...refreshState };
  } catch (error) {
    refreshStarting = false;
    refreshProcess = null;
    throw error;
  }
}

// Central manual gate for the shared Neon cache endpoint.
// OFF blocks normal database connections; ON permits both dashboards to use Neon.
async function getEnabled() {
  const endpoint = await getEndpointState();
  // During a Neon control-plane outage, allow the read-only DB attempt. The
  // existing loader catches connection failure and uses GitHub as fallback.
  return !endpoint.disabled;
}

async function getStatus() {
  const endpoint = await getEndpointState();
  if (!endpoint.disabled) refreshDiagnosticsInBackground();
  const diagnosticsError = endpoint.disabled
    ? 'Neon endpoint is OFF; cache details will be available after it is enabled.'
    : (diagnosticsCache.error || (!diagnosticsCache.value ? 'Cache diagnostics are loading.' : null));
  return {
    enabled: !endpoint.disabled,
    disabled: Boolean(endpoint.disabled),
    computeState: endpoint.current_state || 'unknown',
    endpointId: endpoint.id,
    controlFallback: Boolean(endpoint.controlFallback),
    controlWarning: endpoint.controlFallback ? 'Neon control API is temporarily unavailable; dashboard data uses read-only fallback.' : null,
    refresh: { ...refreshState },
    diagnostics: endpoint.disabled ? null : diagnosticsCache.value,
    diagnosticsError
  };
}

async function setEnabled(enabled, requestedBy) {
  if (typeof enabled !== 'boolean') {
    const error = new Error('A boolean enabled value is required.');
    error.status = 400;
    throw error;
  }
  const endpoint = await neonRequest('PATCH', { endpoint: { disabled: !enabled } });
  endpointStateCache = { expiresAt: Date.now() + ENDPOINT_STATE_TTL_MS, value: endpoint, pending: null };
  diagnosticsCache = { expiresAt: 0, value: null, error: null, pending: null };
  const refresh = enabled ? await startReleaseRefresh(requestedBy) : { ...refreshState };
  if (!enabled) console.log('[NEON CACHE] OFF | GitHub mode will be used by dashboard loaders.');
  return {
    enabled: !endpoint.disabled,
    disabled: Boolean(endpoint.disabled),
    computeState: endpoint.current_state || 'unknown',
    endpointId: endpoint.id,
    refresh
  };
}

function mount(app, options) {
  const middleware = options.middleware ? (Array.isArray(options.middleware) ? options.middleware : [options.middleware]) : [];
  const authorize = options.authorize || (async () => false);
  async function allowed(req, res) {
    const result = await authorize(req, res);
    return Boolean(result);
  }
  app.get('/api/shared-cache/control', ...middleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!(await allowed(req, res))) {
        if (!res.headersSent) res.status(403).json({ success: false, error: 'Protected Super Admin access required.' });
        return;
      }
      res.json({ success: true, ...(await getStatus()) });
    } catch (error) {
      res.status(error.status || 503).json({ success: false, error: error.message || 'Unable to read shared cache status.' });
    }
  });
  app.post('/api/shared-cache/control', ...middleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!(await allowed(req, res))) {
        if (!res.headersSent) res.status(403).json({ success: false, error: 'Protected Super Admin access required.' });
        return;
      }
      const status = await setEnabled(req.body && req.body.enabled, 'SUPER_ADMIN');
      res.json({ success: true, ...status });
    } catch (error) {
      res.status(error.status || 503).json({ success: false, error: error.message || 'Unable to update shared cache control.' });
    }
  });
  app.post('/api/shared-cache/push', ...middleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!(await allowed(req, res))) {
        if (!res.headersSent) res.status(403).json({ success: false, error: 'Protected Super Admin access required.' });
        return;
      }
      const refresh = await startReleaseRefresh('SUPER_ADMIN');
      res.status(refresh.status === 'running' ? 202 : 200).json({ success: true, refresh });
    } catch (error) {
      res.status(error.status || 503).json({ success: false, error: error.message || 'Unable to start GitHub-to-Neon sync.' });
    }
  });
}

module.exports = { mount, getStatus, getEnabled, setEnabled, startReleaseRefresh, getDiagnostics };
