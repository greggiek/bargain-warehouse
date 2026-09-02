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

test('inventory screen only calls the signed read-only V2 inventory endpoint', () => {
  const endpoint = fs.readFileSync(path.join(__dirname, '..', 'api', 'inventory.js'), 'utf8');
  assert.match(behavior, /\/api\/inventory\?/);
  assert.match(endpoint, /req\.method !== 'GET'/);
  assert.match(endpoint, /quantity,allocated_quantity/);
  assert.match(endpoint, /available: number\(balance\.quantity\) - number\(balance\.allocated_quantity\)/);
  assert.doesNotMatch(behavior, /qoblex/i);
  assert.doesNotMatch(behavior, /method:\s*['"]POST/);
});

test('inventory screen renders every active location returned for the user', () => {
  assert.match(behavior, /setLocations\(data\.allLocations/);
  assert.match(behavior, /renderMatrix\(data\.rows \|\| \[\], data\.locations \|\| \[\]/);
  assert.match(behavior, /locations\.forEach\(location =>/);
});
