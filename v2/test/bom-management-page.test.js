const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const behavior = fs.readFileSync(path.join(__dirname, '..', 'bom-management.js'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'manufacturing-boms.js'), 'utf8');

test('BOM management is a Production navigation roll-up', () => {
  assert.match(page, /id="bomManagementNav"/);
  assert.match(page, /id="bomManagementView"/);
  assert.match(page, /bom-management\.js/);
});

test('BOM management separates working recipes from V1 recipes needing setup', () => {
  assert.match(page, /Working BOMs/);
  assert.match(page, /Needs setup/);
  assert.match(api, /v1_door_bom_sources/);
  assert.match(api, /bomManagementTemplateSku/);
});

test('BOM management reuses the V2-only BOM save flow', () => {
  assert.match(behavior, /action: 'saveBom'/);
  assert.match(behavior, /action:'saveBomDraft'/);
  assert.match(api, /save_mfg_bom_draft/);
  assert.match(behavior, /\/api\/manufacturing-boms/);
  assert.match(page, /never Shopify, Qoblex, or inventory/);
});

test('Phase 3 draft save is explicit, single-flight, and leaves activation separate', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260904102000_manufacturing_bom_draft_versions.sql'), 'utf8');
  assert.match(behavior, /Save draft version/);
  assert.match(behavior, /button\.disabled=true/);
  assert.match(behavior, /The active BOM remains unchanged/);
  assert.match(migration, /status='draft'/);
  assert.match(migration, /mfg_bom_versions_one_draft_idx/);
  assert.doesNotMatch(migration, /status='active'/);
  assert.doesNotMatch(migration, /update public\.product_boms/);
});

test('dedicated BOM API contains no legacy production job transaction path', () => {
  assert.doesNotMatch(api, /production_jobs|start_v2_stock_production_job|complete_v2_production/);
  assert.match(api, /bom_query_required/);
});
