const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('catalog sync skips duplicate Shopify barcodes without aborting', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '20260818212000_skip_duplicate_shopify_barcodes.sql'),
    'utf8'
  );
  const preview = fs.readFileSync(path.join(__dirname, '..', 'api', 'product-sync-preview.js'), 'utf8');
  assert.match(migration, /incoming_barcode_rank > 1/);
  assert.match(migration, /on conflict \(upper\(trim\(sku\)\)\)/);
  assert.match(preview, /duplicate_barcode/);
});
