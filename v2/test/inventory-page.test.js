const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const behavior = fs.readFileSync(path.join(__dirname, '..', 'inventory.js'), 'utf8');

test('inventory screen is wired into authenticated navigation', () => {
  assert.match(page, /id="inventoryNav"/);
  assert.match(page, /id="inventoryView"/);
  assert.match(page, /inventory\.js/);
});

test('inventory screen only calls the read-only V2 Shopify endpoint', () => {
  assert.match(behavior, /\/api\/shopify-sync-preview/);
  assert.match(behavior, /writesEnabled !== false/);
  assert.doesNotMatch(behavior, /qoblex/i);
  assert.doesNotMatch(behavior, /method:\s*['"]POST/);
});

test('inventory screen includes all six warehouse columns', () => {
  ['Amityville', 'Bohemia', 'Outpost', 'Riverhead', 'Windham', 'Annex'].forEach(name => {
    assert.match(page, new RegExp(name));
  });
});
