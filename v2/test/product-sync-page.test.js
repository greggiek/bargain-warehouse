const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const behavior = fs.readFileSync(path.join(__dirname, '..', 'product-sync.js'), 'utf8');

test('Shopify catalog preview is wired into navigation', () => {
  assert.match(page, /id="productSyncNav"/);
  assert.match(page, /id="productSyncView"/);
  assert.match(page, /product-sync\.js/);
});

test('Shopify catalog interface previews before a controlled manual sync', () => {
  assert.match(behavior, /PREVIEW_ONLY/);
  assert.match(behavior, /writesEnabled !== false/);
  assert.match(behavior, /\/api\/product-sync-preview/);
  assert.match(behavior, /\/api\/shopify-catalog-sync/);
  assert.match(behavior, /SYNC_SHOPIFY_CATALOG/);
});

test('Shopify catalog interface keeps Shopify as the source of truth', () => {
  assert.match(page, /Sync Shopify catalog to V2/);
  assert.match(page, /Shopify source of truth/i);
  assert.match(page, /Shopify → V2 only/i);
  assert.doesNotMatch(page, /productSyncImport/);
  assert.doesNotMatch(behavior, /product-catalog-import/);
});
