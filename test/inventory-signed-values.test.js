const test = require('node:test');
const assert = require('node:assert/strict');
const { signedInventory, forecastUsable, csvCell } = require('../v2/inventory-values');

test('negative on-hand remains negative', () => assert.deepEqual(signedInventory(-4, 0), { onHand: -4, committed: 0, available: -4 }));
test('committed above on-hand produces negative available', () => assert.deepEqual(signedInventory(3, 8), { onHand: 3, committed: 8, available: -5 }));
test('zero remains zero', () => assert.deepEqual(signedInventory(0, 0), { onHand: 0, committed: 0, available: 0 }));
test('positive inventory remains positive', () => assert.deepEqual(signedInventory(12, 2), { onHand: 12, committed: 2, available: 10 }));
test('forecast clamp does not mutate signed inventory', () => {
  const inventory = signedInventory(-4, 0);
  assert.equal(forecastUsable(inventory.onHand, inventory.committed), 0);
  assert.deepEqual(inventory, { onHand: -4, committed: 0, available: -4 });
});
test('explicit signed Shopify available value is preserved', () => assert.deepEqual(signedInventory(3, 8, -5), { onHand: 3, committed: 8, available: -5 }));

test('inventory CSV retains negative quantities', () => assert.equal(csvCell(-14), '-14'));
test('forecast refresh logic cannot mutate signed values', () => {
  const before = signedInventory(3, 8);
  forecastUsable(before.onHand, before.committed);
  assert.deepEqual(before, { onHand: 3, committed: 8, available: -5 });
});
