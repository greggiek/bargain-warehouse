function cleanShopifyDomain(value) {
  return String(value || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function createShopifyClient({ stores, apiVersion, getEnv, fetchImpl = fetch }) {
  const tokenCache = new Map();

  function storeFor(key) {
    const store = stores.find(item => item.key === key);
    if (!store) throw new Error(`Unknown Shopify store ${key}`);
    return store;
  }

  async function access(store) {
    const cached = tokenCache.get(store.key);
    if (cached && cached.expiresAt > Date.now() + 60000) return cached;
    const shop = cleanShopifyDomain(getEnv(store.domain));
    const response = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: getEnv(store.clientId),
        client_secret: getEnv(store.clientSecret)
      })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.access_token) {
      throw new Error(`${store.label}: Shopify authentication failed (${response.status})`);
    }
    const value = {
      shop,
      token: data.access_token,
      expiresAt: Date.now() + Math.max(300, Number(data.expires_in || 3600)) * 1000
    };
    tokenCache.set(store.key, value);
    return value;
  }

  async function graphql(store, query, variables, operation) {
    const { shop, token } = await access(store);
    const response = await fetchImpl(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query, variables })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${store.label}: Shopify ${operation} failed (${response.status})`);
    if (payload?.errors?.length) {
      throw new Error(`${store.label}: ${payload.errors.map(error => error.message).join('; ')}`);
    }
    return payload;
  }

  async function inventoryItemForSku(storeKey, rawSku) {
    const store = storeFor(storeKey);
    const sku = String(rawSku || '').trim().toUpperCase();
    const query = `query BMVariantBySku($query:String!){productVariants(first:20,query:$query){nodes{sku inventoryItem{id}}}}`;
    const payload = await graphql(store, query, { query: `sku:${JSON.stringify(sku)}` }, 'SKU lookup');
    const exact = (payload?.data?.productVariants?.nodes || [])
      .filter(node => String(node.sku || '').trim().toUpperCase() === sku);
    if (exact.length !== 1) {
      throw new Error(exact.length
        ? `${store.label}: More than one Shopify variant uses SKU ${sku}.`
        : `${store.label}: SKU ${sku} was not found.`);
    }
    return exact[0].inventoryItem?.id || null;
  }

  async function availableQuantity(storeKey, inventoryItemId, locationId) {
    const store = storeFor(storeKey);
    const query = `query BMAvailableAtLocation($item:ID!,$location:ID!){inventoryItem(id:$item){inventoryLevel(locationId:$location){quantities(names:["available"]){name quantity}}}}`;
    const payload = await graphql(store, query, { item: inventoryItemId, location: locationId }, 'available-quantity lookup');
    const quantity = (payload?.data?.inventoryItem?.inventoryLevel?.quantities || [])
      .find(item => item.name === 'available')?.quantity;
    if (!Number.isInteger(quantity)) {
      throw new Error(`${store.label}: Shopify returned no available quantity for this location.`);
    }
    return quantity;
  }

  return { access, availableQuantity, graphql, inventoryItemForSku, storeFor };
}

module.exports = { cleanShopifyDomain, createShopifyClient };
