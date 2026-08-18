const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SHOPIFY_TRANSFER_TEST,
  shopifyTransferTestMatch,
  transferWritebackId,
  validateShopifyTransferReceipt
} = require('../api/lib/shopify-transfer-policy');

function transfer(overrides = {}) {
  return {
    id: 'transfer-1',
    from: { name: 'Annex Warehouse' },
    to: { name: 'Bohemia Main' },
    transfer_lines: [{
      id: 'line-1',
      requested_qty: 1,
      products: { sku: 'gregs shoes' }
    }],
    ...overrides
  };
}

test('matches only the exact allowlisted route, SKU, and quantity', () => {
  assert.ok(shopifyTransferTestMatch(transfer()));
  assert.equal(shopifyTransferTestMatch(transfer({ from: { name: '730 Windham Rd' } })), null);
  assert.equal(shopifyTransferTestMatch(transfer({ to: { name: 'Riverhead Main' } })), null);
  assert.equal(shopifyTransferTestMatch(transfer({
    transfer_lines: [{ id: 'line-1', requested_qty: 2, products: { sku: 'GREGS SHOES' } }]
  })), null);
  assert.equal(shopifyTransferTestMatch(transfer({
    transfer_lines: [{ id: 'line-1', requested_qty: 1, products: { sku: 'OTHER' } }]
  })), null);
});

test('writeback IDs are deterministic and unique by leg', () => {
  const allocate = transferWritebackId('transfer-1', 'line-1', 'allocate');
  assert.equal(allocate, transferWritebackId('transfer-1', 'line-1', 'allocate'));
  assert.notEqual(allocate, transferWritebackId('transfer-1', 'line-1', 'receive'));
  assert.match(allocate, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('allocation, release, and receipt deltas remain balanced', () => {
  assert.equal(SHOPIFY_TRANSFER_TEST.allocate.delta, -1);
  assert.equal(SHOPIFY_TRANSFER_TEST.release.delta, 1);
  assert.equal(SHOPIFY_TRANSFER_TEST.receive.delta, 1);
});

test('requires exactly one undamaged unit for the allowlisted receipt', () => {
  assert.equal(validateShopifyTransferReceipt(transfer(), [{ received: 1, damaged: 0 }]), null);
  assert.match(validateShopifyTransferReceipt(transfer(), [{ received: 0, damaged: 0 }]), /exactly 1/);
  assert.match(validateShopifyTransferReceipt(transfer(), [{ received: 1, damaged: 1 }]), /undamaged/);
  assert.equal(validateShopifyTransferReceipt(transfer({ from: { name: '730 Windham Rd' } }), []), null);
});
