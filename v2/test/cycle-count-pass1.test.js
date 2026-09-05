const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const dailyUi = fs.readFileSync(path.join(root, 'daily-cycle-count.js'), 'utf8');
const reviewUi = fs.readFileSync(path.join(root, 'cycle-count-review.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function response(data, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, headers: { get: key => headers[key.toLowerCase()] || null } };
}

async function invokeDaily(fetchResponses, req = { method: 'GET', query: { locationId: '2' }, body: {} }) {
  const calls = [];
  const originalLoad = Module._load, originalFetch = global.fetch;
  Module._load = function (request, parent, isMain) {
    if (request === './_lib/auth') return { configuration: () => ({ url: 'https://example.supabase.co', serviceRoleKey: 'test' }), jsonHeaders: () => ({ apikey: 'test' }) };
    if (request === './_lib/require-user') return { requireUser: async () => ({ ok: true, user: { id: 'user-1', role: 'manager', display_name: 'Test Manager' } }) };
    return originalLoad.call(this, request, parent, isMain);
  };
  global.fetch = async (url, options = {}) => { calls.push({ url, method: options.method || 'GET' }); return fetchResponses.shift(); };
  const endpointPath = path.join(root, 'api', 'daily-cycle-count.js'); delete require.cache[require.resolve(endpointPath)];
  const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(payload) { this.payload = payload; return payload; } };
  try { await require(endpointPath)(req, res); return { calls, res }; }
  finally { Module._load = originalLoad; global.fetch = originalFetch; delete require.cache[require.resolve(endpointPath)]; }
}

test('Daily Count GET with no existing run performs zero database writes', { concurrency: false }, async () => {
  const result = await invokeDaily([response([{ location_id: 2, locations: { id: 2, name: 'Amityville', active: true } }]), response([])]);
  assert.equal(result.res.payload.run, null);
  assert.equal(result.calls.filter(call => call.method !== 'GET').length, 0);
  assert.equal(result.calls.filter(call => call.url.includes('/rpc/open_v2_daily_cycle_count')).length, 0);
});

test('Daily Count GET with an existing run remains read-only', { concurrency: false }, async () => {
  const run = { id: 7, location_id: 2, cycle_count_lines: [] };
  const result = await invokeDaily([response([{ location_id: 2, locations: { id: 2, name: 'Amityville', active: true } }]), response([{ id: 7 }]), response([run])]);
  assert.equal(result.res.payload.run.id, 7);
  assert.deepEqual(new Set(result.calls.map(call => call.method)), new Set(['GET']));
});

test('unauthorized managed location is rejected before run lookup or mutation', { concurrency: false }, async () => {
  const result = await invokeDaily([response([{ location_id: 2, locations: { id: 2, name: 'Amityville', active: true } }])], { method: 'GET', query: { locationId: '99' }, body: {} });
  assert.equal(result.res.code, 403);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].method, 'GET');
});

test('Daily Count has explicit creation, timeout, Retry, cancellation, stale protection, and Save locking', () => {
  assert.match(page, /id="cycleCountStart"[^>]*>Start today’s count</);
  assert.match(page, /id="cycleCountRetry"/);
  assert.match(dailyUi, /action: 'start'/);
  assert.match(dailyUi, /TIMEOUT = 12000/);
  assert.match(dailyUi, /state\.request\?\.abort/);
  assert.match(dailyUi, /sequence !== state\.sequence/);
  assert.match(dailyUi, /state\.saving/);
  assert.match(dailyUi, /addEventListener\('close', close\)/);
});

test('app shell exclusively owns Cycle Count Review navigation', () => {
  assert.match(page, /data-route="cycle-count-review"/);
  assert.match(page, /requestedRoute === 'cycle-count-review'/);
  assert.doesNotMatch(reviewUi, /cycleCountReviewNav'\)\.addEventListener/);
  assert.match(reviewUi, /overviewCycleReview'\)\?\.addEventListener\('click', \(\) => \$\('cycleCountReviewNav'\)\.click\(\)\)/);
});

test('Review has sequence-safe loading, action locking and explicit total', () => {
  assert.match(reviewUi, /sequence !== state\.sequence/);
  assert.match(reviewUi, /state\.action/);
  assert.match(reviewUi, /buttons\.forEach\(button => \{ button\.disabled = true/);
  assert.match(page, /id="cycleReviewTotal"/);
  assert.match(reviewUi, /!\$\('cycleCountReviewView'\)\.hidden && sessionStorage\.getItem\('bm-active-view'\) === 'cycle-count-review'/);
});

test('OAuth redirects only to Production or the exact approved PR Preview origin', () => {
  assert.match(page, /'https:\/\/bargain-warehouse-v2\.vercel\.app'/);
  assert.match(page, /'https:\/\/bargain-warehouse-v2-git-codex-v2-clea-ca4192-bargain-moulding1\.vercel\.app'/);
  assert.match(page, /approvedAuthOrigins\.has\(location\.origin\)/);
  assert.match(page, /return location\.origin \+ location\.pathname/);
  assert.doesNotMatch(page, /document\.cookie.*domain=/i);
});
