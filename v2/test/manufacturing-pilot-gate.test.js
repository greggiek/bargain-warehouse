const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260902170000_restricted_manufacturing_pilot.sql'), 'utf8');
const canonicalApi = fs.readFileSync(path.join(root, 'v2/api/manufacturing-v2.js'), 'utf8');

test('restricted pilot is fail-closed until explicitly configured', () => {
  assert.match(migration, /enabled boolean not null default false/);
  assert.match(migration, /approved_bom_id bigint/);
  assert.match(migration, /destination_location_id bigint references/);
  assert.match(migration, /machine_code text check \(machine_code in \('NIGHTHAWK','TERMINATOR'\)\)/);
});

test('pilot enforces one active, one-unit work order and the two resolved operators', () => {
  assert.match(migration, /quantity integer not null check \(quantity=1\)/);
  assert.match(migration, /manufacturing_pilot_one_active/);
  assert.match(migration, /greg@bargainmoulding\.com/);
  assert.match(migration, /edwin@bargainmoulding\.com/);
  assert.match(migration, /p\.sku='CD2680PHLHSN80'/);
  assert.match(migration, /destination\.id=2 and destination\.name='Amityville Main'/);
  assert.match(migration, /gid:\/\/shopify\/InventoryItem\/47884539166932/);
  assert.match(migration, /shopifySourceSku',approved_shopify_source_sku/);
  assert.match(migration, /Manually authorized one-door production test; destination par shortage is 0/);
  assert.match(migration, /manufacturing_pilot_audit_events/);
  assert.match(migration, /Only Greg or Edwin may operate this pilot/);
});

test('release and completion both reject component shortages', () => {
  assert.match(migration, /Component shortage for product %; pilot release rejected/);
  assert.match(migration, /Component shortage at completion; no inventory changed/);
  assert.doesNotMatch(migration, /greatest\(0,allocated_quantity/);
});

test('standalone pilot and legacy production endpoints are retired', () => {
  assert.equal(fs.existsSync(path.join(root, 'v2/api/production.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'v2/api/manufacturing-pilot.js')), false);
  assert.match(canonicalApi, /manufacturing_release_enabled/);
  assert.match(canonicalApi, /manufacturing_completion_enabled/);
});
