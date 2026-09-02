const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260902150000_manufacturing_shopify_handoff.sql'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'v2/api/manufacturing-inventory-sync.js'), 'utf8');

test('Manufacturing movements enqueue exactly once inside their local transaction', () => {
  assert.match(migration, /inventory_movement_id bigint not null unique/);
  assert.match(migration, /after insert on public\.inventory_movements/);
  assert.match(migration, /new\.reference_type<>'manufacturing'/);
  assert.match(migration, /new\.idempotency_key\|\|':shopify'/);
});

test('route and Shopify identity must be unique and backed by a current cache row', () => {
  assert.match(migration, /location_id bigint primary key/);
  assert.match(migration, /v_count<>1/);
  assert.match(migration, /manufacturing_shopify_cache_snapshot_missing/);
});

test('worker uses a stable persisted Shopify idempotency key', () => {
  assert.match(worker, /@idempotent\(key: \$key\)/);
  assert.match(worker, /key: claim\.idempotencyKey/);
  assert.doesNotMatch(worker, /randomUUID/);
});

test('Shopify is called only by the post-commit worker', () => {
  assert.match(worker, /inventoryAdjustQuantities/);
  assert.match(worker, /claim_mfg_shopify_inventory_adjustment/);
  assert.doesNotMatch(migration, /https?:\/\//);
});

test('failed calls retain durable retry state and release their lease', () => {
  assert.match(worker, /fail_mfg_shopify_inventory_adjustment/);
  assert.match(migration, /status='failed'.*last_error/s);
  assert.match(migration, /status in \('pending','failed'\)/);
});

test('queue serializes adjustments for the same Shopify inventory level', () => {
  assert.match(migration, /prior\.shopify_inventory_item_id=q\.shopify_inventory_item_id/);
  assert.match(migration, /prior\.id<q\.id/);
  assert.match(migration, /for update skip locked/);
});

test('reconciliation overlays unresolved Manufacturing deltas without clamping signed stock', () => {
  assert.match(migration, /v_operational:=v_on_hand\+v_pending/);
  assert.match(migration, /status in\('pending','processing','shopify_confirmed','failed'\)/);
  assert.doesNotMatch(migration, /greatest\(v_operational|greatest\(v_on_hand/);
});

test('reconciliation confirms reflected adjustments and never enqueues its own movement', () => {
  assert.match(migration, /expected_shopify_on_hand=v_on_hand/);
  assert.match(migration, /set status='confirmed',reconciled_at=now\(\)/);
  assert.match(migration, /'source','shopify_reconciliation','outboundShopify',false/);
});
