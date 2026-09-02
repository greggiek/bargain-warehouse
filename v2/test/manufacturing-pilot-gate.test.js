const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260902170000_restricted_manufacturing_pilot.sql'), 'utf8');
const productionApi = fs.readFileSync(path.join(root, 'v2/api/production.js'), 'utf8');
const pilotApi = fs.readFileSync(path.join(root, 'v2/api/manufacturing-pilot.js'), 'utf8');

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
  assert.match(migration, /Only Greg or Edwin may operate this pilot/);
});

test('release and completion both reject component shortages', () => {
  assert.match(migration, /Component shortage for product %; pilot release rejected/);
  assert.match(migration, /Component shortage at completion; no inventory changed/);
  assert.doesNotMatch(migration, /greatest\(0,allocated_quantity/);
});

test('legacy manufacturing mutations are blocked server-side', () => {
  assert.match(productionApi, /manufacturing_restricted_pilot_only/);
  assert.match(pilotApi, /BM-MFG-PILOT-001/);
  assert.match(pilotApi, /greg@bargainmoulding\.com/);
  assert.match(pilotApi, /edwin@bargainmoulding\.com/);
});
