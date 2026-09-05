const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const dailyUi = fs.readFileSync(path.join(root, 'daily-cycle-count.js'), 'utf8');
const reviewUi = fs.readFileSync(path.join(root, 'cycle-count-review.js'), 'utf8');
const dailyApi = fs.readFileSync(path.join(root, 'api', 'daily-cycle-count.js'), 'utf8');
const reviewApi = fs.readFileSync(path.join(root, 'api', 'cycle-count-review.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, headers: { get: () => null } };
}

async function invokeDaily(role, grants, req = { method: 'GET', query: { locationId: '2' }, body: {} }) {
  const calls = [], originalLoad = Module._load, originalFetch = global.fetch;
  Module._load = function (request, parent, isMain) {
    if (request === './_lib/auth') return { configuration: () => ({ url: 'https://example.supabase.co', serviceRoleKey: 'test' }), jsonHeaders: () => ({ apikey: 'test' }) };
    if (request === './_lib/require-user') return { requireUser: async () => ({ ok: true, user: { id: 'user-1', role, display_name: 'Test User' } }) };
    return originalLoad.call(this, request, parent, isMain);
  };
  const queue = [response(grants), response([])];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    return queue.shift() || response({});
  };
  const endpointPath = path.join(root, 'api', 'daily-cycle-count.js');
  delete require.cache[require.resolve(endpointPath)];
  const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(payload) { this.payload = payload; return payload; } };
  try { await require(endpointPath)(req, res); return { calls, res }; }
  finally { Module._load = originalLoad; global.fetch = originalFetch; delete require.cache[require.resolve(endpointPath)]; }
}

const activeGrant = [{ location_id: 2, locations: { id: 2, name: 'Amityville', active: true } }];

for (const role of ['warehouse', 'manager', 'admin', 'developer']) {
  test(role + ' may perform read-only Daily Count lookup with an active location grant', { concurrency: false }, async () => {
    const { calls, res } = await invokeDaily(role, activeGrant);
    assert.equal(res.code, 200);
    assert.equal(res.payload.run, null);
    assert.equal(calls.filter(call => call.method !== 'GET').length, 0);
    assert.match(calls[0].url, /user_location_access/);
    assert.doesNotMatch(calls[0].url, /can_manage/);
  });
}

test('inactive and unassigned locations cannot be used', { concurrency: false }, async () => {
  const inactive = [{ location_id: 2, locations: { id: 2, name: 'Amityville', active: false } }];
  const { calls, res } = await invokeDaily('warehouse', inactive);
  assert.equal(res.code, 403);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
});

test('Review remains manager role plus can_manage location restricted', () => {
  assert.match(reviewApi, /new Set\(\['manager', 'admin', 'developer'\]\)/);
  assert.match(reviewApi, /can_manage=eq\.true/);
  assert.doesNotMatch(reviewApi, /'warehouse'/);
  assert.match(dailyApi, /'warehouse', 'manager', 'admin', 'developer'/);
});

test('Daily Count uses one consolidated Save action and controlled row state', () => {
  assert.match(page, /id="cycleCountSave"[^>]*>Save counts</);
  assert.doesNotMatch(dailyUi, /button\.textContent = 'Save'/);
  assert.match(dailyUi, /drafts: new Map/);
  assert.match(dailyUi, /async function saveAll/);
  assert.match(dailyUi, /dirtyCount\(\)/);
  assert.match(page, /id="cycleCountProgressText"/);
  assert.match(page, /id="cycleCountUnsaved"/);
});

test('Daily modal owns loading, no-run, empty, error, Retry and complete states', () => {
  for (const id of ['cycleCountLoading', 'cycleCountNoRun', 'cycleCountEmpty', 'cycleCountError', 'cycleCountRetry', 'cycleCountComplete']) assert.match(page, new RegExp('id="' + id + '"'));
  assert.match(dailyUi, /TIMEOUT = 12000/);
  assert.match(dailyUi, /sequence !== state\.sequence/);
  assert.match(dailyUi, /state\.request\?\.abort/);
});

test('route changes and sign-out close and abort Daily Count', () => {
  assert.match(page, /bm:route-change/);
  assert.match(page, /bm:sign-out/);
  assert.match(dailyUi, /addEventListener\('bm:route-change', close\)/);
  assert.match(dailyUi, /addEventListener\('bm:sign-out', close\)/);
  assert.match(dailyUi, /window\.BMWarehouseCloseDailyCount = close/);
});

test('Daily Count remains keyboard and scanner friendly', () => {
  assert.match(dailyUi, /autocomplete = 'off'/);
  assert.match(dailyUi, /inputMode = 'numeric'/);
  assert.match(dailyUi, /event\.key === 'Enter'/);
  assert.match(dailyUi, /focusNext\(input\)/);
  assert.match(dailyUi, /products\?\.sku/);
});

test('Review actions use an accessible structured dialog instead of prompt', () => {
  assert.match(page, /id="cycleReviewActionDialog"/);
  assert.match(page, /aria-labelledby="cycleReviewActionTitle"/);
  assert.match(reviewUi, /function resolutionNote/);
  assert.doesNotMatch(reviewUi, /\bprompt\(/);
});

test('Pass 2A does not alter Recount, Dismiss or run completion semantics', () => {
  assert.match(reviewApi, /\['recount', 'dismiss'\]/);
  assert.match(reviewApi, /review_status: 'dismissed'/);
  assert.match(reviewApi, /status: 'pending', counted_quantity: null/);
  assert.match(dailyApi, /status: 'ready_for_review'/);
  assert.doesNotMatch(dailyApi + reviewApi, /status: 'reviewed'/);
});