const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const behavior = fs.readFileSync(path.join(__dirname, '..', 'purchase-orders.js'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'purchase-orders.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260821100000_v2_po_scan_receiving.sql'), 'utf8');
const detailMigration = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260821113000_v2_purchase_order_details.sql'), 'utf8');
const editMigration = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260822060000_v2_purchase_order_draft_edit.sql'), 'utf8');

test('PO master drills into an order workspace and receiving is launched from Overview', () => {
  assert.match(page, /id="purchaseOrdersNav"/);
  assert.match(page, /id="poMasterList"/);
  assert.match(page, /id="poDetailPanel"/);
  assert.match(page, /id="overviewReceivePo"/);
  assert.match(page, /id="poReceivingDialog"/);
  assert.match(page, /id="poReceiveOrderScan"/);
  assert.match(page, /Scan PO to start/);
  assert.match(behavior, /scanPurchaseOrder/);
  assert.match(page, /Scan SKU or barcode, then press Enter/);
  assert.match(behavior, /action: 'send'/);
  assert.match(behavior, /action: 'receive-lines'/);
  assert.match(behavior, /openDetail/);
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
  assert.match(behavior, /create-detailed/);
  assert.match(api, /create_v2_purchase_order_with_details/);
  assert.match(detailMigration, /supplier_reference_number/);
  assert.match(detailMigration, /unit_cost/);
  assert.match(detailMigration, /revoke all on function public\.create_v2_purchase_order_with_details/);
});

test('only draft POs can be edited and the database function remains service-role only', () => {
  assert.match(behavior, /update-detailed/);
  assert.match(api, /Only a draft purchase order can be edited/);
  assert.match(api, /update_v2_purchase_order_with_details/);
  assert.match(editMigration, /v_order\.status <> 'draft'/);
  assert.match(editMigration, /PURCHASE_ORDER_UPDATED/);
  assert.match(editMigration, /revoke all on function public\.update_v2_purchase_order_with_details/);
});
