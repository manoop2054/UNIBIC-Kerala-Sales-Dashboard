'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
let refreshProcess = null;
let refreshState = { status: 'idle', startedAt: null, completedAt: null, error: null };

function startReleaseRefresh() {
  if (refreshProcess) return { ...refreshState, status: 'running' };
  const script = path.join(__dirname, 'import-release-to-neon.js');
  if (!process.env.SHARED_CACHE_DATABASE_URL) throw new Error('SHARED_CACHE_DATABASE_URL is missing; Neon was enabled but automatic refresh cannot start.');
  if (!fs.existsSync(script)) throw new Error('GitHub-to-Neon importer is missing from this Render release.');
  refreshState = { status: 'running', startedAt: new Date().toISOString(), completedAt: null, error: null };
  console.log('[NEON REFRESH] START | source=GitHub latest release | startedAt=' + refreshState.startedAt);
  const child = spawn(process.execPath, [script], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  refreshProcess = child;
  const pipe = (stream, label) => {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      pending += chunk;
      const lines = pending.split(/\r?\n/); pending = lines.pop() || '';
      for (const line of lines) if (line) console.log('[NEON REFRESH][' + label + '] ' + line);
    });
    stream.on('end', () => { if (pending) console.log('[NEON REFRESH][' + label + '] ' + pending); });
  };
  pipe(child.stdout, 'OUT'); pipe(child.stderr, 'ERR');
  child.on('error', error => {
    refreshState = { ...refreshState, status: 'failed', completedAt: new Date().toISOString(), error: error.message };
    refreshProcess = null;
    console.error('[NEON REFRESH] FAILED |', error.message);
  });
  child.on('close', code => {
    refreshState = { ...refreshState, status: code === 0 ? 'success' : 'failed', completedAt: new Date().toISOString(), error: code === 0 ? null : 'Importer exited with code ' + code };
    refreshProcess = null;
    console.log('[NEON REFRESH] ' + (code === 0 ? 'SUCCESS' : 'FAILED') + ' | completedAt=' + refreshState.completedAt + ' | exitCode=' + code);
  });
  return { ...refreshState };
}


// Central manual gate for the shared Neon cache endpoint.
// "OFF" sets endpoint.disabled=true, which blocks normal DB connections from
// waking the compute. "ON" clears that restriction; the first DB query may wake it.
const PROJECT_ID = process.env.SHARED_CACHE_PROJECT_ID || 'snowy-sky-65564833';
const ENDPOINT_ID = process.env.SHARED_CACHE_ENDPOINT_ID || 'ep-rapid-dust-a1197lo4';
const API_BASE = 'https://console.neon.tech/api/v2';

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

async function getStatus() {
  const endpoint = await neonRequest('GET');
  return {
    enabled: !endpoint.disabled,
    disabled: Boolean(endpoint.disabled),
    computeState: endpoint.current_state || 'unknown',
    endpointId: endpoint.id,
    refresh: { ...refreshState }
  };
}

async function setEnabled(enabled) {
  if (typeof enabled !== 'boolean') {
    const error = new Error('A boolean enabled value is required.');
    error.status = 400;
    throw error;
  }
  const endpoint = await neonRequest('PATCH', { endpoint: { disabled: !enabled } });
  const refresh = enabled ? startReleaseRefresh() : { ...refreshState };
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
  app.get('/api/shared-cache/control', ...middleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!(await authorize(req, res))) {
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
      if (!(await authorize(req, res))) {
        if (!res.headersSent) res.status(403).json({ success: false, error: 'Protected Super Admin access required.' });
        return;
      }
      const status = await setEnabled(req.body && req.body.enabled);
      res.json({ success: true, ...status });
    } catch (error) {
      res.status(error.status || 503).json({ success: false, error: error.message || 'Unable to update shared cache control.' });
    }
  });
}

module.exports = { mount, getStatus, setEnabled };
