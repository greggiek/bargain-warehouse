const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanShopifyDomain, createShopifyClient } = require('../api/lib/shopify-client');

const stores = [{
  key: 'store_1',
  label: 'Test Store',
  domain: 'DOMAIN',
  clientId: 'CLIENT_ID',
  clientSecret: 'CLIENT_SECRET'
}];
const values = {
  DOMAIN: 'https://example.myshopify.com/',
  CLIENT_ID: 'client',
  CLIENT_SECRET: 'secret'
};

function response(data, ok = true, status = 200) {
  return { ok, status, json: async () => data };
}

test('normalizes Shopify domains', () => {
  assert.equal(cleanShopifyDomain('https://example.myshopify.com/'), 'example.myshopify.com');
});

test('authenticates once and reuses a valid token', async () => {
  let calls = 0;
  const client = createShopifyClient({
    stores,
    apiVersion: '2026-07',
    getEnv: name => values[name],
    fetchImpl: async () => {
      calls += 1;
      return response({ access_token: 'token', expires_in: 3600 });
    }
  });
  await client.access(stores[0]);
  await client.access(stores[0]);
  assert.equal(calls, 1);
});

test('finds an exact SKU and reads its available quantity', async () => {
  const requests = [];
  const client = createShopifyClient({
    stores,
    apiVersion: '2026-07',
    getEnv: name => values[name],
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/admin/oauth/access_token')) {
        return response({ access_token: 'token', expires_in: 3600 });
      }
      const body = JSON.parse(options.body);
      if (body.query.includes('BMVariantBySku')) {
        return response({ data: { productVariants: { nodes: [
          { sku: 'GREGS SHOES', inventoryItem: { id: 'gid://shopify/InventoryItem/1' } }
        ] } } });
      }
      return response({ data: { inventoryItem: { inventoryLevel: {
        quantities: [{ name: 'available', quantity: 2 }]
      } } } });
    }
  });
  const itemId = await client.inventoryItemForSku('store_1', 'gregs shoes');
  const quantity = await client.availableQuantity('store_1', itemId, 'gid://shopify/Location/1');
  assert.equal(itemId, 'gid://shopify/InventoryItem/1');
  assert.equal(quantity, 2);
  assert.equal(requests.length, 3);
});

test('rejects missing and duplicate exact SKU matches', async () => {
  for (const nodes of [[], [
    { sku: 'DUP', inventoryItem: { id: '1' } },
    { sku: 'dup', inventoryItem: { id: '2' } }
  ]]) {
    const client = createShopifyClient({
      stores,
      apiVersion: '2026-07',
      getEnv: name => values[name],
      fetchImpl: async url => url.endsWith('/admin/oauth/access_token')
        ? response({ access_token: 'token', expires_in: 3600 })
        : response({ data: { productVariants: { nodes } } })
    });
    await assert.rejects(
      client.inventoryItemForSku('store_1', nodes.length ? 'DUP' : 'MISSING'),
      nodes.length ? /More than one/ : /was not found/
    );
  }
});
