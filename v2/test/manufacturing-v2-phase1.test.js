const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'manufacturing-v2.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260901193000_manufacturing_v2_phase1_foundation.sql'), 'utf8');
const shadowMigration = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260902170000_manufacturing_shadow_mode.sql'), 'utf8');

test('Manufacturing V2 authenticates before its user-specific Shadow Mode gate', () => {
  assert.ok(api.indexOf('await requireUser(req)') < api.indexOf("manufacturing_draft_enabled"));
  assert.match(api, /const actorId = Number\(auth\.user\.id\)/);
  assert.doesNotMatch(api, /body\.(userId|user_id|role|userName)/);
});

test('Manufacturing mutations are disabled by separate database controls', () => {
  assert.match(api, /manufacturing_release_enabled/);
  assert.match(api, /manufacturing_completion_enabled/);
  assert.match(shadowMigration, /'manufacturing_release_enabled',false/);
  assert.match(shadowMigration, /'manufacturing_completion_enabled',false/);
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

test('legacy production, Forecasting and Inventory source files are not replaced', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'production.js')), true);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'forecasting.js')), true);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'inventory.js')), true);
});
