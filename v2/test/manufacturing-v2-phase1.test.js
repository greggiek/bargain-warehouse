const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'manufacturing-v2.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260901193000_manufacturing_v2_phase1_foundation.sql'), 'utf8');

test('Manufacturing V2 authenticates before its disabled feature gate', () => {
  assert.ok(api.indexOf('await requireUser(req)') < api.indexOf("MANUFACTURING_V2_ENABLED !== 'true'"));
  assert.match(api, /const actorId = Number\(auth\.user\.id\)/);
  assert.doesNotMatch(api, /body\.(userId|user_id|role|userName)/);
});

test('Manufacturing V2 is disabled by both deployment and database flags', () => {
  assert.match(api, /MANUFACTURING_V2_ENABLED/);
  assert.match(api, /mfg_feature_flags/);
  assert.match(migration, /'manufacturing_v2',false/);
});

test('every command is permission checked server-side', () => {
  for (const permission of ['manufacturing_create_draft', 'manufacturing_release', 'manufacturing_shortage_override', 'manufacturing_cancel']) {
    assert.match(api, new RegExp(`requirePermission\\(url, serviceRoleKey, actorId, '${permission}'\\)`));
  }
  assert.match(migration, /mfg_actor_can/);
  assert.match(migration, /manufacturing_location_permission_denied/);
});

test('direct database release is service-role only', () => {
  assert.match(migration, /start_v2_stock_production_job[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /release_mfg_work_order[\s\S]*from public,anon,authenticated/);
  assert.match(migration, /grant execute on function public\.release_mfg_work_order[\s\S]*to service_role/);
});

test('planned production transfer begins with zero transferable inventory', () => {
  assert.match(migration, /transferable_quantity numeric not null default 0/);
  assert.match(migration, /select v_plan_id,finished_product_id,planned_quantity,0/);
});

test('Manufacturing transaction layer contains no Shopify calls', () => {
  assert.doesNotMatch(api, /shopify/i);
  assert.doesNotMatch(migration, /https?:\/\//i);
  assert.doesNotMatch(migration, /shopify_(inventory|adjust|write)/i);
});

test('costing foundation refuses to manufacture a zero-dollar cost', () => {
  assert.match(migration, /Cost unavailable — component cost source not configured/);
  assert.match(migration, /coalesce\(p\.moving_average_cost,0\)<=0/);
});

test('legacy production runtime is removed without replacing Forecasting or Inventory', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'production.js')), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'manufacturing-v3.js')), true);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'forecasting.js')), true);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'inventory.js')), true);
});
