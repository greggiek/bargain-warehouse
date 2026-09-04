const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const behavior = fs.readFileSync(path.join(__dirname, '..', 'inventory.js'), 'utf8');
const endpoint = fs.readFileSync(path.join(__dirname, '..', 'api', 'inventory.js'), 'utf8');

test('inventory route is owned by the authenticated app shell', () => {
  assert.match(page, /id="inventoryNav"[^>]+data-route="inventory"/);
  assert.match(page, /requestedRoute === 'inventory'/);
  assert.match(page, /BMWarehouseEnterInventory/);
  assert.match(page, /id="inventoryView"/);
  assert.match(page, /inventory\.js/);
  assert.doesNotMatch(behavior, /inventoryNav'\)\.addEventListener/);
  assert.doesNotMatch(behavior, /overviewNav'\)\.addEventListener/);
});

test('inventory screen only calls the signed read-only V2 inventory endpoint', () => {
  assert.match(behavior, /\/api\/inventory\?/);
  assert.match(endpoint, /req\.method !== 'GET'/);
  assert.match(endpoint, /quantity,allocated_quantity/);
  assert.match(endpoint, /available: onHand - committed/);
  assert.doesNotMatch(behavior, /qoblex/i);
  assert.doesNotMatch(behavior, /method:\s*['"]POST/);
  assert.doesNotMatch(endpoint, /incoming/i);
});

test('inventory endpoint enforces location authorization and bounded pagination', () => {
  assert.match(endpoint, /allLocations\.some\(location => location\.id === requestedLocationId\)/);
  assert.match(endpoint, /requestedSortLocationId && !locationIds\.includes\(requestedSortLocationId\)/);
  assert.match(endpoint, /MAX_PAGE_SIZE = 100/);
  assert.match(endpoint, /pageSize = Math\.min\(MAX_PAGE_SIZE/);
  assert.match(endpoint, /totalResults/);
  assert.match(endpoint, /totalPages/);
});

test('search, category, stable sorting and pagination precede page balance hydration', () => {
  const productLookup = endpoint.indexOf('await matchingProducts');
  const stableSort = endpoint.indexOf('products.sort');
  const pageSlice = endpoint.indexOf('const pageProducts = products.slice');
  const hydration = endpoint.indexOf('const pageBalances = await balancesForProducts');
  assert.ok(productLookup > -1 && stableSort > productLookup);
  assert.ok(pageSlice > stableSort && hydration > pageSlice);
  assert.match(endpoint, /a\.id - b\.id/);
  assert.match(endpoint, /sku\.ilike/);
  assert.match(endpoint, /category=eq/);
});

test('inventory loading has timeout, retry, cancellation and stale-response protection', () => {
  assert.match(behavior, /setTimeout\(\(\) => controller\.abort\('timeout'\), 12000\)/);
  assert.match(behavior, /state\.request\?\.abort\(\)/);
  assert.match(behavior, /sequence !== state\.sequence/);
  assert.match(behavior, /Inventory took longer than 12 seconds\. Retry\./);
  assert.match(behavior, /textContent = error \? 'Retry' : 'Refresh'/);
});

test('inventory screen renders pagination, all authorized locations and request metrics', () => {
  assert.match(page, /id="inventoryPrev"/);
  assert.match(page, /id="inventoryNext"/);
  assert.match(page, /id="inventoryPageSize"/);
  assert.match(behavior, /setLocations\(data\.allLocations/);
  assert.match(behavior, /renderMatrix\(data\.rows \|\| \[\], data\.locations \|\| \[\]/);
  assert.match(behavior, /locations\.forEach\(location =>/);
  assert.match(behavior, /responseTimeMs/);
  assert.match(behavior, /queryTimeMs/);
  assert.match(behavior, /payloadBytes/);
  assert.match(behavior, /renderedRows/);
});
