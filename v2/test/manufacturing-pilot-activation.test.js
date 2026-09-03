const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const activation = fs.readFileSync(
  path.join(root, 'supabase/operations/activate_manufacturing_pilot.sql'),
  'utf8'
);

const pilotFlags = [
  'manufacturing_pilot_release_enabled',
  'manufacturing_pilot_completion_enabled',
  'manufacturing_pilot_inventory_enabled',
  'manufacturing_pilot_outbound_enabled',
  'manufacturing_pilot_transfer_enabled'
];

test('activation requires, updates, and verifies all five pilot capability rows', () => {
  for (const flag of pilotFlags) assert.match(activation, new RegExp(flag));
  assert.match(activation, /v_expected_flag_count <> 5/);
  assert.match(activation, /get diagnostics v_updated_flag_count = row_count/);
  assert.match(activation, /v_updated_flag_count <> 5/);
  assert.match(activation, /v_enabled_flag_count <> 5/);
  assert.doesNotMatch(
    activation,
    /if\s+found\s+(?:is\s+false\s+)?then\s+raise exception 'pilot_capability_flags_missing'/i
  );
});

test('activation keeps general Manufacturing flags fail-closed', () => {
  for (const flag of [
    'manufacturing_release_enabled',
    'manufacturing_completion_enabled',
    'manufacturing_inventory_mutations_enabled',
    'manufacturing_shopify_outbound_enabled',
    'manufacturing_transfer_handoff_enabled'
  ]) assert.match(activation, new RegExp(flag));
  assert.match(activation, /general_manufacturing_flag_enabled/);
});

test('activation remains bound to the approved one-door cross-store scope', () => {
  assert.match(activation, /approved_work_order_id <> v_work_order_id/);
  assert.match(activation, /approved_finished_product_id <> 3523/);
  assert.match(activation, /approved_bom_id <> 194/);
  assert.match(activation, /planned_quantity = 1/);
  assert.match(activation, /origin_location_id <> 6/);
  assert.match(activation, /destination_location_id <> 2/);
  assert.match(activation, /machine_code <> 'NIGHTHAWK'/);
  assert.match(activation, /'routeType','cross_store'/);
});
