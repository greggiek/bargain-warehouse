const { requireUser } = require('./_lib/require-user');

module.exports = async function (req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed', writesEnabled: false });
  }

  const authorization = await requireUser(req);
  if (!authorization.ok) {
    return res.status(authorization.status).json({
      ok: false,
      error: authorization.error,
      writesEnabled: false
    });
  }

  const API_VERSION = '2026-07';

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

  function cleanDomain(value) {
    return String(value || '')
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
  }

  async function getAccessToken(store) {
    const shop = cleanDomain(store.domain);

    if (!shop || !store.clientId || !store.clientSecret) {
      throw new Error(`${store.key}: missing Shopify environment variables`);
    }

    const response = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
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
      }
    );

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    if (!response.ok || !data?.access_token) {
      throw new Error(
        `${store.key}: token request failed (${response.status}) ${
          data?.error_description || data?.error || ''
        }`
      );
    }

    return {
      shop,
      token: data.access_token
    };
  }

  async function graphql(shop, token, query, variables = {}) {
    const response = await fetch(
      `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Shopify-Access-Token': token
        },
        body: JSON.stringify({
          query,
          variables
        })
      }
    );

    const text = await response.text();

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }

    if (!response.ok || !payload) {
      throw new Error(
        `Shopify GraphQL request failed (${response.status})`
      );
    }

    if (payload.errors?.length) {
      throw new Error(
        payload.errors.map(error => error.message).join('; ')
      );
    }

    return payload.data;
  }

  async function loadStoreMeta(shop, token) {
    const query = `
      query BMStoreMeta {
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

    return graphql(shop, token, query);
  }

  async function loadProducts(shop, token, store) {
    const variants = [];

    let cursor = null;
    let hasNextPage = true;
    let page = 0;

    while (hasNextPage && page < 100) {
      page += 1;

      const query = `
        query BMProducts($cursor: String) {
          products(
            first: 10
            after: $cursor
          ) {
            pageInfo {
              hasNextPage
              endCursor
            }

            nodes {
              id
              title
              productType
              status

              variants(first: 20) {
                nodes {
                  id
                  title
                  sku
                  barcode

                  inventoryItem {
                    id
                    tracked

                    inventoryLevels(first: 20) {
                      nodes {
                        id

                        location {
                          id
                          name
                        }

                        quantities(
                          names: [
                            "available"
                            "on_hand"
                            "committed"
                          ]
                        ) {
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

      const data = await graphql(
        shop,
        token,
        query,
        { cursor }
      );

      const connection = data?.products;

      if (!connection) {
        throw new Error(`${store.key}: products connection missing`);
      }

      for (const product of connection.nodes || []) {
        for (const variant of product.variants?.nodes || []) {
          const inventoryLevels =
            variant.inventoryItem?.inventoryLevels?.nodes || [];

          variants.push({
            sourceStore: store.key,
            sourceStoreLabel: store.label,

            shopifyProductId: product.id,
            shopifyVariantId: variant.id,
            shopifyInventoryItemId:
              variant.inventoryItem?.id || null,

            product: product.title,
            category: product.productType || '',
            productStatus: product.status,
            variant: variant.title,

            sku: variant.sku || '',
            barcode: variant.barcode || '',
            tracked: variant.inventoryItem?.tracked ?? false,

            inventory: inventoryLevels.map(level => {
              const quantities = {};

              for (const item of level.quantities || []) {
                quantities[item.name] = item.quantity;
              }

              return {
                shopifyLocationId:
                  level.location?.id || null,

                locationName:
                  level.location?.name || '',

                onHand:
                  Number(quantities.on_hand || 0),

                available:
                  Number(quantities.available || 0),

                committed:
                  Number(quantities.committed || 0)
              };
            })
          });
        }
      }

      hasNextPage =
        Boolean(connection.pageInfo?.hasNextPage);

      cursor =
        connection.pageInfo?.endCursor || null;
    }

    return variants;
  }

  async function loadStore(store) {
    const { shop, token } =
      await getAccessToken(store);

    const meta =
      await loadStoreMeta(shop, token);

    const variants =
      await loadProducts(shop, token, store);

    return {
      key: store.key,
      label: store.label,

      shop: meta.shop,

      locations:
        meta.locations?.nodes || [],

      variants,

      variantCount:
        variants.length
    };
  }

  function normalize(storeResults) {
    const skuMap = new Map();

    for (const store of storeResults) {
      for (const variant of store.variants) {
        const sku =
          String(variant.sku || '').trim();

        if (!sku) {
          continue;
        }

        if (!skuMap.has(sku)) {
          skuMap.set(sku, {
            sku,
            product: variant.product,
            category: variant.category || '',

            totalOnHand: 0,
            totalAvailable: 0,
            totalCommitted: 0,

            variants: [],
            locations: []
          });
        }

        const row =
          skuMap.get(sku);

        row.variants.push({
          sourceStore:
            variant.sourceStore,

          sourceStoreLabel:
            variant.sourceStoreLabel,

          shopifyProductId:
            variant.shopifyProductId,

          shopifyVariantId:
            variant.shopifyVariantId,

          shopifyInventoryItemId:
            variant.shopifyInventoryItemId,

          variantTitle:
            variant.variant || '',

          barcode:
            variant.barcode || ''
        });

        for (const location of variant.inventory) {
          row.locations.push({
            sourceStore:
              variant.sourceStore,

            sourceStoreLabel:
              variant.sourceStoreLabel,

            shopifyLocationId:
              location.shopifyLocationId,

            locationName:
              location.locationName,

            onHand:
              Number(location.onHand || 0),

            available:
              Number(location.available || 0),

            committed:
              Number(location.committed || 0)
          });

          row.totalOnHand +=
            Number(location.onHand || 0);

          row.totalAvailable +=
            Number(location.available || 0);

          row.totalCommitted +=
            Number(location.committed || 0);
        }
      }
    }

    return Array
      .from(skuMap.values())
      .sort((a, b) =>
        a.sku.localeCompare(b.sku)
      );
  }

  try {
    const storeResults = [];

    for (const store of stores) {
      const result =
        await loadStore(store);

      storeResults.push(result);
    }

    const normalized =
      normalize(storeResults);

    return res.status(200).json({
      ok: true,

      mode:
        'READ_ONLY_PREVIEW',

      writesEnabled:
        false,

      stores:
        storeResults.map(store => ({
          key:
            store.key,

          label:
            store.label,

          shop:
            store.shop,

          locations:
            store.locations,

          variantCount:
            store.variantCount
        })),

      normalizedCount:
        normalized.length,

      normalized,

      generatedAt:
        new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      mode:
        'READ_ONLY_PREVIEW',

      writesEnabled:
        false,

      error:
        error.message
    });
  }
};
