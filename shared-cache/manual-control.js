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
let autoSyncTimer = null;
let autoSyncCheck = null;

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
  const response = await fetch(API_BASE + '/projects/' + encodeURIComponent(PROJECT_ID) +
    '/endpoints/' + encodeURIComponent(ENDPOINT_ID), {
      method,
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
}

async function reconcileInterruptedRun() {
  // A Render restart kills the importer child process but leaves its DB row marked
  // RUNNING. Only reconcile when this process has no importer running locally.
  if (refreshProcess || refreshStarting) return;
  const pool = getStatusPool();
  const result = await pool.query(
    "UPDATE public.shared_cache_sync_runs SET status='interrupted', completed_at=NOW(), " +
    "error_message=COALESCE(error_message, 'Render process restarted before the sync completed; start a new sync.'), " +
    "log_lines=COALESCE(log_lines, '[]'::jsonb) || jsonb_build_array('[RECOVERY] Previous sync was interrupted by a service restart; a new sync can be started.') " +
    "WHERE status='running' AND started_at < NOW() - INTERVAL '2 minutes' RETURNING run_id::text"
  );
  if (result.rowCount) {
    console.warn('[NEON MANUAL PUSH] Reconciled interrupted sync run(s): ' + result.rows.map(row => row.run_id).join(', '));
  }
}

async function autoSyncIfOutdated(){
  if(autoSyncCheck)return autoSyncCheck;
  autoSyncCheck=(async()=>{
    await ensureStatusStore();
    const endpoint=await neonRequest('GET');
    if(endpoint.disabled)return{status:'disabled'};
    if(refreshProcess||refreshStarting)return{status:'running'};
    await reconcileInterruptedRun();
    const [release,active]=await Promise.all([getGithubReleaseInfo(),getActiveSnapshot()]);
    const needsSync=Object.keys(ASSETS).some(source=>{
      const asset=release.assets[source];
      const current=active.find(row=>row.source===source);
      if(!current)return true;
      const assetTime=Date.parse(asset.updatedAt||asset.uploadedAt||'');
      const cacheTime=Date.parse(current.completedAt||'');
      const sizeChanged=Number(asset.sizeBytes)>0&&Number(current.sizeBytes)>0&&Number(asset.sizeBytes)!==Number(current.sizeBytes);
      return sizeChanged||(Number.isFinite(assetTime)&&Number.isFinite(cacheTime)&&assetTime>cacheTime);
    });
    if(!needsSync)return{status:'current',release:release.tag};
    const pool=getStatusPool();
    const latest=await pool.query('SELECT status,started_at FROM public.shared_cache_sync_runs ORDER BY started_at DESC LIMIT 1');
    const previous=latest.rows[0];
    if(previous&&previous.status==='failed'&&Date.now()-new Date(previous.started_at).getTime()<15*60*1000){
      return{status:'retry-cooldown',release:release.tag};
    }
    console.log('[NEON AUTO SYNC] Newer GitHub release asset detected; starting safe import.');
    return await startReleaseRefresh('AUTO_GITHUB_CHECK');
  })().finally(()=>{autoSyncCheck=null;});
  return autoSyncCheck;
}

function startAutoSyncMonitor(){
  if(autoSyncTimer)return;
  autoSyncTimer=setInterval(()=>{
    autoSyncIfOutdated().catch(error=>console.error('[NEON AUTO SYNC] Check failed:',error.message));
  },5*60*1000);
  if(autoSyncTimer.unref)autoSyncTimer.unref();
  const initial=setTimeout(()=>{
    autoSyncIfOutdated().catch(error=>console.error('[NEON AUTO SYNC] Initial check failed:',error.message));
  },15000);
  if(initial.unref)initial.unref();
}

async function getDiagnostics() {
  await ensureStatusStore();
  await reconcileInterruptedRun();
  const pool = getStatusPool();
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
  await reconcileInterruptedRun();
  const [release, before] = await Promise.all([getGithubReleaseInfo(), getActiveSnapshot()]);

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const pool = getStatusPool();
  await pool.query(
    'INSERT INTO public.shared_cache_sync_runs(run_id,status,requested_by,started_at,github_release,github_assets,before_active)' +
    ' VALUES($1,\'running\',$2,$3,$4,$5::jsonb,$6::jsonb)',
    [runId, requestedBy || 'SUPER_ADMIN', startedAt, release.tag, JSON.stringify(release.assets), JSON.stringify(before)]
  );
  refreshState = { runId, status: 'running', startedAt, completedAt: null, error: null, release: release.tag, logs: [], progress: { stage: 'starting', sourceRows: 0 } };
  console.log('[NEON MANUAL PUSH] START | runId=' + runId + ' | release=' + release.tag + ' | startedAt=' + startedAt);

  const child = spawn(process.execPath, [script], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  refreshProcess = child;
  refreshStarting = false;
  const logLines = [];
  let finished = false;
  let persistChain = Promise.resolve();
  let currentStage = 'download';
  let lastProgressAt = Date.now();
  let lastProgressRows = 0;
  let forcedError = null;
  let watchdogTimer = null;
  let killTimer = null;
  const recordLine = (label, line) => {
    const entry = '[' + label + '] ' + line;
    logLines.push(entry);
    if (logLines.length > 40) logLines.shift();
    const progress = line.match(/\[GSV IMPORT\] progress sourceRows=(\d+)/);
    if (line.includes('[GSV IMPORT] started')) {
      currentStage = 'GSV';
      lastProgressAt = Date.now();
      lastProgressRows = 0;
    } else if (progress) {
      const rows = Number(progress[1]);
      if (rows > lastProgressRows) {
        lastProgressRows = rows;
        lastProgressAt = Date.now();
        refreshState = { ...refreshState, progress: { stage: 'GSV import', sourceRows: rows } };
      }
    } else if (line.includes('[GSV IMPORT] validated')) {
      currentStage = 'post-GSV';
      refreshState = { ...refreshState, progress: { stage: 'GSV validated', sourceRows: lastProgressRows } };
    } else if (line.includes('[LIVE SOH IMPORT] started')) {
      currentStage = 'LIVE SOH';
      refreshState = { ...refreshState, progress: { stage: 'LIVE SOH import' } };
    }
    refreshState = { ...refreshState, logs: logLines.slice(-40) };
    console.log('[NEON REFRESH][' + label + '] ' + line);
    const snapshot = JSON.stringify(logLines.slice(-40));
    persistChain = persistChain.then(() => pool.query(
      'UPDATE public.shared_cache_sync_runs SET log_lines=$2::jsonb WHERE run_id=$1',
      [runId, snapshot]
    )).catch(error => console.error('[NEON REFRESH] Could not persist progress log:', error.message));
  };
  const pipe = (stream, label) => {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) if (line) recordLine(label, line);
    });
    stream.on('end', () => {
      if (pending) recordLine(label, pending);
    });
  };
  pipe(child.stdout, 'OUT');
  pipe(child.stderr, 'ERR');

  watchdogTimer = setInterval(() => {
    if (!finished && currentStage === 'GSV' && Date.now() - lastProgressAt > 10 * 60 * 1000 && !forcedError) {
      forcedError = 'GSV import stalled: no source-row progress for 10 minutes. The previous Active cache was preserved; the incomplete candidate will be cleaned safely on the next sync.';
      console.error('[NEON REFRESH] ' + forcedError);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!finished && refreshProcess === child) child.kill('SIGKILL');
      }, 15000);
      if (killTimer.unref) killTimer.unref();
    }
  }, 30000);
  if (watchdogTimer.unref) watchdogTimer.unref();

  const finish = async (code, error) => {
    if (finished) return;
    finished = true;
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (killTimer) clearTimeout(killTimer);
    try {
      await persistChain;
      const after = await getActiveSnapshot();
      const success = code === 0 && !forcedError;
      const sourceResults = compareSources(before, after, success ? 0 : 1);
      const status = success ? 'success' : 'failed';
      const message = success ? null : (forcedError || error || 'Importer exited with code ' + code);
      await pool.query(
        'UPDATE public.shared_cache_sync_runs SET status=$2,completed_at=NOW(),after_active=$3::jsonb,source_results=$4::jsonb,log_lines=$5::jsonb,error_message=$6 WHERE run_id=$1',
        [runId, status, JSON.stringify(after), JSON.stringify(sourceResults), JSON.stringify(logLines), message]
      );
      refreshState = { runId, status, startedAt, completedAt: new Date().toISOString(), error: message, release: release.tag, sourceResults, logs: logLines.slice(-40), progress: refreshState.progress || null };
      console.log('[NEON MANUAL PUSH] ' + status.toUpperCase() + ' | runId=' + runId + ' | GSV=' + sourceResults.GSV.status + ' | LIVE_SOH=' + sourceResults.LIVE_SOH.status);
    } catch (persistError) {
      refreshState = { runId, status: 'failed', startedAt, completedAt: new Date().toISOString(), error: 'Sync finished but diagnostics could not be saved: ' + persistError.message, release: release.tag, logs: logLines.slice(-40) };
      console.error('[NEON MANUAL PUSH] DIAGNOSTICS SAVE FAILED |', persistError.message);
    } finally {
      refreshProcess = null;
    }
  };

  child.on('error', error => { finish(1, forcedError || error.message); });
  child.on('close', code => { finish(code, forcedError || (code === 0 ? null : 'Importer exited with code ' + code)); });
  return { ...refreshState };
  } catch (error) {
    refreshStarting = false;
    refreshProcess = null;
    throw error;
  }
}

// Central manual gate for the shared Neon cache endpoint.
// OFF blocks normal database connections; ON permits both dashboards to use Neon.
async function getStatus() {
  const endpoint = await neonRequest('GET');
  let diagnostics = null;
  let diagnosticsError = null;
  if (endpoint.disabled) diagnosticsError = 'Neon endpoint is OFF; cache details will be available after it is enabled.';
  else {
    try { diagnostics = await getDiagnostics(); }
    catch (error) { diagnosticsError = error.message; }
  }
  return {
    enabled: !endpoint.disabled,
    disabled: Boolean(endpoint.disabled),
    computeState: endpoint.current_state || 'unknown',
    endpointId: endpoint.id,
    refresh: { ...refreshState },
    diagnostics,
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
  startAutoSyncMonitor();
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

module.exports = { mount, getStatus, setEnabled, startReleaseRefresh, getDiagnostics };
