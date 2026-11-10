'use strict';

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
    endpointId: endpoint.id
  };
}

async function setEnabled(enabled) {
  if (typeof enabled !== 'boolean') {
    const error = new Error('A boolean enabled value is required.');
    error.status = 400;
    throw error;
  }
  const endpoint = await neonRequest('PUT', { endpoint: { disabled: !enabled } });
  return {
    enabled: !endpoint.disabled,
    disabled: Boolean(endpoint.disabled),
    computeState: endpoint.current_state || 'unknown',
    endpointId: endpoint.id
  };
}

function mount(app, options) {
  const middleware = options.middleware || ((req, res, next) => next());
  const authorize = options.authorize || (async () => false);
  app.get('/api/shared-cache/control', middleware, async (req, res) => {
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
  app.post('/api/shared-cache/control', middleware, async (req, res) => {
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
