const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const behavior = fs.readFileSync(path.join(__dirname, '..', 'purchase-orders.js'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'purchase-orders.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260821100000_v2_po_master_scan_receiving.sql'), 'utf8');

test('PO master and scan-first receipt page are wired into V2 navigation', () => {
  assert.match(page, /id="purchaseOrdersNav"/);
  assert.match(page, /id="purchaseOrdersView"/);
  assert.match(page, /purchase-orders\.js/);
  assert.match(page, /Scan-first PO receiving/);
});

test('scan-first receiving accepts SKU scans and posts only selected receipt lines', () => {
  assert.match(behavior, /poScanInput/);
  assert.match(behavior, /products\?\.sku/);
  assert.match(behavior, /action: 'receive-lines'/);
  assert.match(behavior, /damagedQuantity/);
  assert.match(page, /Post scanned receipt/);
});

test('PO API and database function keep receipt history durable and service-only', () => {
  assert.match(api, /Only purchasing administrators can create POs/);
  assert.match(api, /receive_v2_purchase_order_lines/);
  assert.match(migration, /purchase_order_receipts/);
  assert.match(migration, /purchase_order_receipt_lines/);
  assert.match(migration, /revoke all on function public\.receive_v2_purchase_order_lines/);
  assert.match(migration, /damaged_quantity/);
});
