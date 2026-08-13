module.exports = async function (req, res) {
  const stores = [
    {
      key: 'store_1',
      label: 'Bargain Moulding',
      domain: process.env.SHOPIFY_STORE_1_DOMAIN,
      clientId: process.env.SHOPIFY_STORE_1_CLIENT_ID,
      clientSecret: process.env.SHOPIFY_STORE_1_CLIENT_SECRET
    },
    {
      key: 'store_2',
      label: 'Bargain Moulding CT',
      domain: process.env.SHOPIFY_STORE_2_DOMAIN,
      clientId: process.env.SHOPIFY_STORE_2_CLIENT_ID,
      clientSecret: process.env.SHOPIFY_STORE_2_CLIENT_SECRET
    }
  ];

  function cleanDomain(v) {
    return (v || '')
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');
  }

  async function getToken(store) {
    const shop = cleanDomain(store.domain);

    if (!shop || !store.clientId || !store.clientSecret) {
      throw new Error(`${store.key}: missing Shopify environment variables`);
    }

    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: store.clientId,
        client_secret: store.clientSecret
      })
    });

    const text = await r.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    if (!r.ok || !data?.access_token) {
      throw new Error(
        `${store.key}: token request failed (${r.status}) ${
          data?.error_description || data?.error || ''
        }`
      );
    }

    return {
      shop,
      token: data.access_token
    };
  }

  async function gql(shop, token, query, variables = {}) {
    const r = await fetch(
      `https://${shop}/admin/api/2026-07/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Shopify-Access-Token': token
        },
        body: JSON.stringify({ query, variables })
      }
    );

    const text = await r.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    if (!r.ok || !data) {
      throw new Error(`GraphQL request failed (${r.status})`);
    }

    if (data.errors?.length) {
      throw new Error(
        data.errors.map(e => e.message).join('; ')
      );
    }

    return data.data;
  }

  async function loadStore(store) {
    const { shop, token } = await getToken(store);

    const metaQuery = `
      query BMShopifyMeta {
        shop {
          name
          myshopifyDomain
        }
        locations(first: 100) {
          nodes {
            id
            name
            isActive
          }
        }
      }
    `;

    const meta = await gql(shop, token, metaQuery);

    const products = [];
    let cursor = null;
    let hasNextPage = true;
    let pageCount = 0;

    while (hasNextPage && pageCount < 20) {
      pageCount++;

      const query = `
        query BMProducts($cursor: String) {
          products(first: 50, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              title
              status
              variants(first: 100) {
                nodes {
                  id
                  title
                  sku
                  barcode
                  inventoryItem {
                    id
                    tracked
                    inventoryLevels(first: 100) {
                      nodes {
                        id
                        location {
                          id
                          name
                        }
                        quantities(names: ["available", "on_hand", "committed"]) {
                          name
                          quantity
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const data = await gql(shop, token, query, { cursor });

      const connection = data.products;

      for (const product of connection.nodes || []) {
        for (const variant of product.variants?.nodes || []) {
          const levels = variant.inventoryItem?.inventoryLevels?.nodes || [];

          products.push({
            sourceStore: store.key,
            sourceStoreLabel: store.label,
            shopifyProductId: product.id,
            shopifyVariantId: variant.id,
            shopifyInventoryItemId: variant.inventoryItem?.id || null,
            product: product.title,
            variant: variant.title,
            sku: variant.sku || '',
            barcode: variant.barcode || '',
            tracked: variant.inventoryItem?.tracked ?? null,
            inventory: levels.map(level => {
              const qty = {};

              for (const q of level.quantities || []) {
                qty[q.name] = q.quantity;
              }

              return {
                shopifyLocationId: level.location?.id || null,
                locationName: level.location?.name || '',
                available: qty.available ?? 0,
                onHand: qty.on_hand ?? 0,
                committed: qty.committed ?? 0
              };
            })
          });
        }
      }

      hasNextPage = !!connection.pageInfo?.hasNextPage;
      cursor = connection.pageInfo?.endCursor || null;
    }

    return {
      key: store.key,
      label: store.label,
      shop: meta.shop,
      locations: meta.locations?.nodes || [],
      variants: products,
      variantCount: products.length
    };
  }

  function normalize(storesData) {
    const map = new Map();

    for (const store of storesData) {
      for (const variant of store.variants) {
        const sku = (variant.sku || '').trim();

        if (!sku) continue;

        if (!map.has(sku)) {
          map.set(sku, {
            sku,
            product: variant.product,
            variants: [],
            locations: [],
            totalOnHand: 0,
            totalAvailable: 0,
            totalCommitted: 0
          });
        }

        const row = map.get(sku);

        row.variants.push({
          sourceStore: variant.sourceStore,
          sourceStoreLabel: variant.sourceStoreLabel,
          shopifyVariantId: variant.shopifyVariantId,
          barcode: variant.barcode
        });

        for (const inv of variant.inventory) {
          row.locations.push({
            sourceStore: variant.sourceStore,
            sourceStoreLabel: variant.sourceStoreLabel,
            shopifyLocationId: inv.shopifyLocationId,
            locationName: inv.locationName,
            onHand: inv.onHand,
            available: inv.available,
            committed: inv.committed
          });

          row.totalOnHand += Number(inv.onHand || 0);
          row.totalAvailable += Number(inv.available || 0);
          row.totalCommitted += Number(inv.committed || 0);
        }
      }
    }

    return Array.from(map.values()).sort((a, b) =>
      a.sku.localeCompare(b.sku)
    );
  }

  try {
    const results = [];

    for (const store of stores) {
      results.push(await loadStore(store));
    }

    const normalized = normalize(results);

    return res.status(200).json({
      ok: true,
      mode: 'READ_ONLY_PREVIEW',
      writesEnabled: false,
      stores: results.map(store => ({
        key: store.key,
        label: store.label,
        shop: store.shop,
        locations: store.locations,
        variantCount: store.variantCount
      })),
      normalizedCount: normalized.length,
      normalized,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      mode: 'READ_ONLY_PREVIEW',
      writesEnabled: false,
      error: error.message
    });
  }
};
