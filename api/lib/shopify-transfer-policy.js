const crypto = require('node:crypto');

const SHOPIFY_TRANSFER_TEST = Object.freeze({
  sku: 'GREGS SHOES',
  quantity: 1,
  fromLocation: 'Annex Warehouse',
  toLocation: 'Bohemia Main',
  allocate: Object.freeze({
    store: 'store_2',
    locationId: 'gid://shopify/Location/81193369657',
    locationName: 'Annex (Retail) 730',
    delta: -1
  }),
  release: Object.freeze({
    store: 'store_2',
    locationId: 'gid://shopify/Location/81193369657',
    locationName: 'Annex (Retail) 730',
    delta: 1
  }),
  receive: Object.freeze({
    store: 'store_1',
    locationId: 'gid://shopify/Location/68088365268',
    locationName: 'Bohemia Warehouse',
    delta: 1
  })
});

function one(value) {
  return Array.isArray(value) ? value[0] : value;
}

function transferWritebackId(transferId, lineId, leg) {
  const hex = crypto
    .createHash('sha256')
    .update(['bm-shopify-transfer-v1', transferId, lineId, leg].join('|'))
    .digest('hex')
    .slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '4' + hex.slice(13, 16),
    '8' + hex.slice(17, 20),
    hex.slice(20, 32)
  ].join('-');
}

function shopifyTransferTestMatch(transfer) {
  const from = one(transfer?.from)?.name || '';
  const to = one(transfer?.to)?.name || '';
  const lines = transfer?.transfer_lines || [];
  const line = lines[0];
  const product = one(line?.products) || {};
  const matches =
    from === SHOPIFY_TRANSFER_TEST.fromLocation &&
    to === SHOPIFY_TRANSFER_TEST.toLocation &&
    lines.length === 1 &&
    String(product.sku || '').trim().toUpperCase() === SHOPIFY_TRANSFER_TEST.sku &&
    Number(line.requested_qty) === SHOPIFY_TRANSFER_TEST.quantity;
  return matches ? { line, product } : null;
}

function validateShopifyTransferReceipt(transfer, receipt) {
  if (!shopifyTransferTestMatch(transfer)) return null;
  if (
    receipt.length !== 1 ||
    Number(receipt[0]?.received) !== SHOPIFY_TRANSFER_TEST.quantity ||
    Number(receipt[0]?.damaged) !== 0
  ) {
    return 'The allowlisted Shopify test must receive exactly 1 undamaged GREGS SHOES unit.';
  }
  return null;
}

module.exports = {
  SHOPIFY_TRANSFER_TEST,
  shopifyTransferTestMatch,
  transferWritebackId,
  validateShopifyTransferReceipt
};
