const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const behavior = fs.readFileSync(path.join(__dirname, '..', 'purchase-orders.js'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'purchase-orders.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260821100000_v2_po_scan_receiving.sql'), 'utf8');
const detailMigration = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260821113000_v2_purchase_order_details.sql'), 'utf8');

test('PO master has a dedicated admin and scanner workflow', () => {
  assert.match(page, /id="purchaseOrdersNav"/);
  assert.match(page, /id="poMasterCard"/);
  assert.match(page, /id="poScannerCard"/);
  assert.match(page, /Scan SKU or barcode, then press Enter/);
  assert.match(behavior, /action: 'send'/);
  assert.match(behavior, /action: 'receive-lines'/);
});

test('PO receiving posts only scanned expected lines', () => {
  assert.match(behavior, /not an expected line/);
  assert.match(behavior, /already fully scanned/);
  assert.match(api, /receive_v2_purchase_order_lines/);
  assert.doesNotMatch(api, /body\.action === 'receive'/);
});

test('PO transactions are sent and idempotent server-side', () => {
  assert.match(migration, /create or replace function public\.send_v2_purchase_order/);
  assert.match(migration, /create or replace function public\.receive_v2_purchase_order_lines/);
  assert.match(migration, /receiptIdempotencyKey/);
  assert.match(migration, /revoke all on function public\.receive_v2_purchase_order_lines/);
});

test('PO master carries V1 purchasing details without exposing direct writes', () => {
  for (const id of ['poNumber', 'poSupplierReference', 'poOrderDate', 'poExpectedDate', 'poShippingCost', 'poLineUom', 'poLineCost']) assert.match(page, new RegExp('id="' + id + '"'));
  assert.match(behavior, /action: 'create-detailed'/);
  assert.match(api, /create_v2_purchase_order_with_details/);
  assert.match(detailMigration, /supplier_reference_number/);
  assert.match(detailMigration, /unit_cost/);
  assert.match(detailMigration, /revoke all on function public\.create_v2_purchase_order_with_details/);
});
