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

test('Shopify catalog interface enforces preview-only responses', () => {
  assert.match(behavior, /PREVIEW_ONLY/);
  assert.match(behavior, /writesEnabled !== false/);
  assert.match(behavior, /\/api\/product-sync-preview/);
  assert.doesNotMatch(behavior, /method:\s*['"]POST/);
});

test('Shopify catalog interface has no commit control', () => {
  assert.doesNotMatch(page, />\s*(?:Import|Commit|Apply sync)\s*</i);
  assert.match(page, /Shopify source of truth/i);
  assert.match(page, /no database writes/i);
  assert.doesNotMatch(page, /productSyncImport/);
  assert.doesNotMatch(behavior, /product-catalog-import/);
});
