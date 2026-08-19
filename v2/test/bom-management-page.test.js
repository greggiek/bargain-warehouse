const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const behavior = fs.readFileSync(path.join(__dirname, '..', 'bom-management.js'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'production.js'), 'utf8');

test('BOM management is a Production navigation roll-up', () => {
  assert.match(page, /id="bomManagementNav"/);
  assert.match(page, /id="bomManagementView"/);
  assert.match(page, /bom-management\.js/);
});

test('BOM management separates working recipes from V1 recipes needing setup', () => {
  assert.match(page, /Working BOMs/);
  assert.match(page, /Needs setup/);
  assert.match(api, /v1_door_bom_sources/);
  assert.match(api, /bomManagementTemplateSku/);
});

test('BOM management reuses the V2-only BOM save flow', () => {
  assert.match(behavior, /action: 'saveBom'/);
  assert.match(page, /never Shopify, Qoblex, or inventory/);
});
