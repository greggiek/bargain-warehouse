const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const me = require('../api/auth/me');

const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dashboard = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');

function responseCapture() {
  let statusCode;
  let payload;
  const headers = {};
  return {
    res: {
      setHeader(name, value) { headers[name] = value; },
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; return this; }
    },
    read() { return { statusCode, payload, headers }; }
  };
}

test('bootstrap requests only auth/me before showing an authenticated view', () => {
  assert.match(page, /startBootstrap\(\)/);
  assert.match(page, /await loadSession\(sequence, controller\.signal\)/);
  assert.match(page, /showApp\(session\)/);
  assert.doesNotMatch(dashboard, /DOMContentLoaded[^\n]+load\(\)/);
});

test('bootstrap cancels stale work and restores only approved routes after auth', () => {
  assert.match(page, /bootstrap\.controller\?\.abort\(\)/);
  assert.match(page, /sequence !== bootstrap\.sequence/);
  assert.match(page, /dashboard:\s*'overviewNav'/);
  assert.match(page, /manufacturing:\s*'productionNav'/);
  assert.match(page, /transfers:\s*'transfersNav'/);
  assert.match(page, /inventory:\s*'inventoryNav'/);
  assert.match(page, /if \(!bootstrap\.authenticated \|\| !nav\) return/);
});

test('desktop and mobile sign-out share cleanup and clear stored route', () => {
  assert.match(page, /window\.BMWarehouseSignOut = signOut/);
  assert.match(page, /mobileLogout\?\.addEventListener\('click',\(\)=>window\.BMWarehouseSignOut\?\.\(\)\)/);
  assert.match(page, /document\.querySelectorAll\('dialog\[open\]'\)/);
  assert.match(page, /sessionStorage\.removeItem\(routeKey\)/);
});

test('expired Google access token is refreshed and rotated before user lookup', async () => {
  const priorFetch = global.fetch;
  const priorEnv = { ...process.env };
  process.env.BM_WAREHOUSE_V2_SUPABASE_URL = 'https://example.supabase.co';
  process.env.BM_WAREHOUSE_V2_SUPABASE_PUBLISHABLE_KEY = 'publishable';
  process.env.BM_WAREHOUSE_V2_SUPABASE_SERVICE_ROLE_KEY = 'service';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/v1/user') && calls.filter(call => call.url.endsWith('/auth/v1/user')).length === 1) return { ok: false };
    if (url.includes('/auth/v1/token?grant_type=refresh_token')) return { ok: true, json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }) };
    if (url.endsWith('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'auth-1', email: 'greg@bargainmoulding.com' }) };
    if (url.includes('/rest/v1/app_users?')) return { ok: true, json: async () => ([{ id: 3, display_name: 'Greg', email: 'greg@bargainmoulding.com', role: 'admin' }]) };
    if (url.includes('/rest/v1/user_location_access?')) return { ok: true, json: async () => ([]) };
    throw new Error('unexpected request ' + url);
  };
  try {
    const capture = responseCapture();
    await me({ method: 'GET', headers: { cookie: 'bm_v2_access_token=expired; bm_v2_refresh_token=valid-refresh' } }, capture.res);
    assert.equal(capture.read().statusCode, 200);
    assert.equal(calls[1].options.method, 'POST');
    assert.equal(calls[1].options.body, JSON.stringify({ refresh_token: 'valid-refresh' }));
    const cookies = capture.read().headers['Set-Cookie'];
    assert.equal(cookies.length, 2);
    assert.match(cookies[0], /^bm_v2_access_token=new-access;/);
    assert.match(cookies[0], /Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600/);
    assert.match(cookies[1], /^bm_v2_refresh_token=new-refresh;/);
  } finally {
    global.fetch = priorFetch;
    process.env = priorEnv;
  }
});

test('failed refresh clears every stale session cookie and returns 401', async () => {
  const priorFetch = global.fetch;
  const priorEnv = { ...process.env };
  process.env.BM_WAREHOUSE_V2_SUPABASE_URL = 'https://example.supabase.co';
  process.env.BM_WAREHOUSE_V2_SUPABASE_PUBLISHABLE_KEY = 'publishable';
  process.env.BM_WAREHOUSE_V2_SUPABASE_SERVICE_ROLE_KEY = 'service';
  global.fetch = async url => url.includes('/auth/v1/token') ? { ok: false } : { ok: false };
  try {
    const capture = responseCapture();
    await me({ method: 'GET', headers: { cookie: 'bm_v2_access_token=expired; bm_v2_refresh_token=expired-refresh' } }, capture.res);
    assert.equal(capture.read().statusCode, 401);
    assert.equal(capture.read().payload.error, 'session_expired');
    assert.equal(capture.read().headers['Set-Cookie'].length, 3);
  } finally {
    global.fetch = priorFetch;
    process.env = priorEnv;
  }
});
