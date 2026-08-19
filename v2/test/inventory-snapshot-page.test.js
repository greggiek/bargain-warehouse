const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const behavior = fs.readFileSync(path.join(__dirname, '..', 'inventory-snapshot.js'), 'utf8');
const endpoint = fs.readFileSync(path.join(__dirname, '..', 'api', 'inventory-opening-snapshot-preview.js'), 'utf8');

test('opening inventory snapshot is preview-only', () => {
  assert.match(page, /id="snapshotNav"/);
  assert.match(page, /id="snapshotView"/);
  assert.match(page, /inventory-snapshot\.js/);
  assert.match(behavior, /OPENING_SNAPSHOT_PREVIEW/);
  assert.match(behavior, /writesEnabled !== false/);
  assert.doesNotMatch(behavior, /method:\s*['"]POST/);
  assert.match(endpoint, /writesEnabled:\s*false/);
  assert.doesNotMatch(endpoint, /inventoryAdjust|inventorySet/);
});
