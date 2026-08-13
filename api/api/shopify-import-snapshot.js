// api/shopify-import-snapshot.js
//
// Shopify -> Supabase inventory snapshot importer
//
// SHOPIFY: READ ONLY
// SUPABASE: WRITES snapshot + sync log
//
// Existing Vercel environment variables:
//
// SHOPIFY_STORE_1_DOMAIN
// SHOPIFY_STORE_1_CLIENT_ID
// SHOPIFY_STORE_1_CLIENT_SECRET
//
// SHOPIFY_STORE_2_DOMAIN
// SHOPIFY_STORE_2_CLIENT_ID
// SHOPIFY_STORE_2_CLIENT_SECRET
//
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
//
// Optional:
// SHOPIFY_API_VERSION
// IMPORT_SECRET

const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION || "2026-07";

const STORES = [
  {
    key: "store_1",
    label: "Bargain Moulding",
    domain: process.env.SHOPIFY_STORE_1_DOMAIN,
    clientId: process.env.SHOPIFY_STORE_1_CLIENT_ID,
    clientSecret: process.env.SHOPIFY_STORE_1_CLIENT_SECRET,
  },
  {
    key: "store_2",
    label: "Bargain Moulding CT",
    domain: process.env.SHOPIFY_STORE_2_DOMAIN,
    clientId: process.env.SHOPIFY_STORE_2_CLIENT_ID,
    clientSecret: process.env.SHOPIFY_STORE_2_CLIENT_SECRET,
  },
];

function normalizeDomain(value) {
  if (!value) return null;

  return String(value)
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
}

function quantityValue(quantities, name) {
  const item = quantities?.find(
    (q) => q.name === name
  );

  const value = Number(item?.quantity ?? 0);

  return Number.isFinite(value)
    ? value
    : 0;
}

function normalizeSku(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}


// ----------------------------------------------------
// SHOPIFY AUTH
// ----------------------------------------------------

async function getShopifyAccessToken(store) {
  const domain = normalizeDomain(store.domain);

  if (!domain) {
    throw new Error(
      `${store.label}: missing Shopify domain`
    );
  }

  if (!store.clientId) {
    throw new Error(
      `${store.label}: missing Shopify client ID`
    );
  }

  if (!store.clientSecret) {
    throw new Error(
      `${store.label}: missing Shopify client secret`
    );
  }

  const response = await fetch(
    `https://${domain}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: store.clientId,
        client_secret: store.clientSecret,
        grant_type: "client_credentials",
      }),
    }
  );

  const text = await response.text();

  let body;

  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new Error(
      `${store.label}: Shopify authentication failed ` +
      `(${response.status}) ${text}`
    );
  }

  if (!body?.access_token) {
    throw new Error(
      `${store.label}: Shopify returned no access token`
    );
  }

  return body.access_token;
}


// ----------------------------------------------------
// SHOPIFY GRAPHQL
// ----------------------------------------------------

async function shopifyGraphQL(
  store,
  accessToken,
  query,
  variables = {}
) {
  const domain = normalizeDomain(store.domain);

  const response = await fetch(
    `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Shopify-Access-Token": accessToken,
      },

      body: JSON.stringify({
        query,
        variables,
      }),
    }
  );

  const text = await response.text();

  let body;

  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new Error(
      `${store.label}: Shopify HTTP ${response.status}: ${text}`
    );
  }

  if (!body) {
    throw new Error(
      `${store.label}: Shopify returned invalid JSON`
    );
  }

  if (body.errors?.length) {
    throw new Error(
      `${store.label}: Shopify GraphQL error: ` +
      JSON.stringify(body.errors)
    );
  }

  return body.data;
}


// ----------------------------------------------------
// IMPORTANT:
//
// Keep the query deliberately small.
//
// We previously hit Shopify's 1000 query-cost ceiling.
// This fetches only 25 variants per page and only 50
// inventory levels per variant.
// ----------------------------------------------------

const INVENTORY_QUERY = `
  query WarehouseInventory($cursor: String) {

    productVariants(
      first: 25
      after: $cursor
    ) {

      pageInfo {
        hasNextPage
        endCursor
      }

      nodes {

        id
        sku
        barcode

        product {
          id
          title
        }

        inventoryItem {

          id

          inventoryLevels(first: 50) {

            nodes {

              location {
                id
                name
              }

              quantities(
                names: [
                  "on_hand"
                  "available"
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
`;


// ----------------------------------------------------
// READ ONE SHOPIFY STORE
// ----------------------------------------------------

async function readStoreInventory(
  store,
  syncedAt
) {
  const accessToken =
    await getShopifyAccessToken(store);

  const rows = [];

  let cursor = null;
  let pageNumber = 0;

  while (true) {
    pageNumber += 1;

    const data = await shopifyGraphQL(
      store,
      accessToken,
      INVENTORY_QUERY,
      {
        cursor,
      }
    );

    const variants =
      data?.productVariants;

    if (!variants) {
      throw new Error(
        `${store.label}: no productVariants returned`
      );
    }

    for (
      const variant of variants.nodes || []
    ) {
      const sku = String(
        variant.sku || ""
      ).trim();

      if (!sku) {
        continue;
      }

      const inventoryItem =
        variant.inventoryItem;

      if (!inventoryItem) {
        continue;
      }

      const levels =
        inventoryItem.inventoryLevels?.nodes || [];

      for (const level of levels) {
        if (!level.location?.id) {
          continue;
        }

        const quantities =
          level.quantities || [];

        rows.push({

          source_store:
            store.key,

          source_store_label:
            store.label,

          shopify_product_id:
            variant.product?.id || null,

          shopify_variant_id:
            variant.id,

          shopify_inventory_item_id:
            inventoryItem.id,

          shopify_location_id:
            level.location.id,

          location_name:
            level.location.name ||
            "Unknown Shopify Location",

          sku,

          product_name:
            variant.product?.title ||
            null,

          barcode:
            variant.barcode ||
            null,

          on_hand:
            quantityValue(
              quantities,
              "on_hand"
            ),

          available:
            quantityValue(
              quantities,
              "available"
            ),

          committed:
            quantityValue(
              quantities,
              "committed"
            ),

          synced_at:
            syncedAt,

          raw: {
            store:
              store.key,

            product_id:
              variant.product?.id ||
              null,

            variant_id:
              variant.id,

            inventory_item_id:
              inventoryItem.id,

            location_id:
              level.location.id,

            quantities,
          },
        });
      }
    }

    if (
      !variants.pageInfo?.hasNextPage
    ) {
      break;
    }

    cursor =
      variants.pageInfo.endCursor;

    if (!cursor) {
      throw new Error(
        `${store.label}: pagination cursor missing`
      );
    }

    // Absolute safety valve.
    if (pageNumber >= 5000) {
      throw new Error(
        `${store.label}: pagination safety limit reached`
      );
    }
  }

  return {
    store: store.key,
    label: store.label,
    rows,
    pages: pageNumber,
  };
}


// ----------------------------------------------------
// SUPABASE
// ----------------------------------------------------

function supabaseBaseUrl() {
  const value =
    process.env.SUPABASE_URL;

  if (!value) {
    throw new Error(
      "Missing SUPABASE_URL"
    );
  }

  return value.replace(/\/$/, "");
}

function supabaseHeaders(extra = {}) {
  const key =
    process.env
      .SUPABASE_SERVICE_ROLE_KEY;

  if (!key) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY"
    );
  }

  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function supabaseRequest(
  path,
  options = {}
) {
  const response = await fetch(
    `${supabaseBaseUrl()}${path}`,
    {
      ...options,

      headers:
        supabaseHeaders(
          options.headers || {}
        ),
    }
  );

  const text =
    await response.text();

  let body = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ` +
      (
        typeof body === "string"
          ? body
          : JSON.stringify(body)
      )
    );
  }

  return body;
}


// ----------------------------------------------------
// SYNC RUN LOG
// ----------------------------------------------------

async function createSyncRun() {
  const result =
    await supabaseRequest(
      "/rest/v1/shopify_sync_runs",
      {
        method: "POST",

        headers: {
          Prefer:
            "return=representation",
        },

        body: JSON.stringify({
          started_at:
            new Date().toISOString(),

          mode:
            "shopify_inventory_snapshot",

          success:
            null,

          stores_seen:
            0,

          normalized_skus:
            0,

          snapshot_rows:
            0,

          metadata: {
            api_version:
              SHOPIFY_API_VERSION,

            shopify_write_back:
              false,
          },
        }),
      }
    );

  const id =
    result?.[0]?.id;

  if (!id) {
    throw new Error(
      "Could not create Shopify sync run"
    );
  }

  return id;
}

async function updateSyncRun(
  runId,
  values
) {
  await supabaseRequest(
    `/rest/v1/shopify_sync_runs?id=eq.${encodeURIComponent(
      runId
    )}`,
    {
      method: "PATCH",

      headers: {
        Prefer:
          "return=minimal",
      },

      body:
        JSON.stringify(values),
    }
  );
}


// ----------------------------------------------------
// SNAPSHOT UPSERT
//
// Your live table has this unique key:
//
// source_store
// + shopify_variant_id
// + shopify_location_id
// ----------------------------------------------------

async function upsertRows(rows) {
  if (!rows.length) {
    return;
  }

  const batchSize = 250;

  for (
    let i = 0;
    i < rows.length;
    i += batchSize
  ) {
    const batch =
      rows.slice(
        i,
        i + batchSize
      );

    await supabaseRequest(
      "/rest/v1/shopify_inventory_snapshot" +
      "?on_conflict=" +
      "source_store," +
      "shopify_variant_id," +
      "shopify_location_id",
      {
        method: "POST",

        headers: {
          Prefer:
            "resolution=merge-duplicates,return=minimal",
        },

        body:
          JSON.stringify(batch),
      }
    );
  }
}


// ----------------------------------------------------
// REMOVE OLD SNAPSHOT ROWS
//
// ONLY run this after the store was read and upserted
// successfully.
// ----------------------------------------------------

async function deleteOldRows(
  storeKey,
  syncedAt
) {
  const path =
    "/rest/v1/shopify_inventory_snapshot" +

    `?source_store=eq.${encodeURIComponent(
      storeKey
    )}` +

    `&synced_at=lt.${encodeURIComponent(
      syncedAt
    )}`;

  await supabaseRequest(
    path,
    {
      method: "DELETE",

      headers: {
        Prefer:
          "return=minimal",
      },
    }
  );
}


// ----------------------------------------------------
// SKU COUNT
// ----------------------------------------------------

function countUniqueSkus(rows) {
  const set = new Set();

  for (const row of rows) {
    const sku =
      normalizeSku(row.sku);

    if (sku) {
      set.add(sku);
    }
  }

  return set.size;
}


// ----------------------------------------------------
// OPTIONAL ENDPOINT PROTECTION
// ----------------------------------------------------

function authorized(req) {
  const secret =
    process.env.IMPORT_SECRET;

  // During initial setup/testing,
  // IMPORT_SECRET can be omitted.
  if (!secret) {
    return true;
  }

  const authorization =
    req.headers.authorization;

  if (
    authorization ===
    `Bearer ${secret}`
  ) {
    return true;
  }

  const headerSecret =
    req.headers["x-import-secret"];

  return (
    headerSecret === secret
  );
}


// ----------------------------------------------------
// API HANDLER
// ----------------------------------------------------

export default async function handler(
  req,
  res
) {
  if (
    req.method !== "GET" &&
    req.method !== "POST"
  ) {
    res.setHeader(
      "Allow",
      "GET, POST"
    );

    return res
      .status(405)
      .json({
        ok: false,
        error:
          "Method not allowed",
      });
  }

  if (!authorized(req)) {
    return res
      .status(401)
      .json({
        ok: false,
        error:
          "Unauthorized",
      });
  }

  const startedAt =
    Date.now();

  const syncedAt =
    new Date().toISOString();

  let runId = null;

  try {

    // Validate configuration.

    const missing = [];

    for (const store of STORES) {
      if (!store.domain) {
        missing.push(
          `${store.key} domain`
        );
      }

      if (!store.clientId) {
        missing.push(
          `${store.key} client ID`
        );
      }

      if (!store.clientSecret) {
        missing.push(
          `${store.key} client secret`
        );
      }
    }

    if (
      !process.env.SUPABASE_URL
    ) {
      missing.push(
        "SUPABASE_URL"
      );
    }

    if (
      !process.env
        .SUPABASE_SERVICE_ROLE_KEY
    ) {
      missing.push(
        "SUPABASE_SERVICE_ROLE_KEY"
      );
    }

    if (missing.length) {
      throw new Error(
        "Missing configuration: " +
        missing.join(", ")
      );
    }


    // Start log.

    runId =
      await createSyncRun();


    const allRows = [];
    const results = [];


    // Intentionally sequential.
    //
    // We do NOT hammer both Shopify
    // stores simultaneously.

    for (const store of STORES) {

      const result =
        await readStoreInventory(
          store,
          syncedAt
        );

      await upsertRows(
        result.rows
      );

      await deleteOldRows(
        store.key,
        syncedAt
      );

      allRows.push(
        ...result.rows
      );

      results.push({
        store:
          result.store,

        label:
          result.label,

        pages:
          result.pages,

        rows:
          result.rows.length,

        skus:
          countUniqueSkus(
            result.rows
          ),
      });
    }


    const normalizedSkus =
      countUniqueSkus(
        allRows
      );

    const durationMs =
      Date.now() -
      startedAt;


    // Successful log.

    await updateSyncRun(
      runId,
      {
        completed_at:
          new Date().toISOString(),

        success:
          true,

        stores_seen:
          STORES.length,

        normalized_skus:
          normalizedSkus,

        snapshot_rows:
          allRows.length,

        error:
          null,

        metadata: {
          api_version:
            SHOPIFY_API_VERSION,

          shopify_write_back:
            false,

          duration_ms:
            durationMs,

          stores:
            results,
        },
      }
    );


    return res
      .status(200)
      .json({
        ok:
          true,

        mode:
          "SHOPIFY_TO_SUPABASE",

        run_id:
          runId,

        synced_at:
          syncedAt,

        stores_seen:
          STORES.length,

        normalized_skus:
          normalizedSkus,

        snapshot_rows:
          allRows.length,

        stores:
          results,

        duration_ms:
          durationMs,

        shopify_write_back:
          false,
      });

  } catch (error) {

    console.error(
      "Shopify snapshot import failed",
      error
    );

    const message =
      error instanceof Error
        ? error.message
        : String(error);


    // Try to record failure,
    // but don't hide original error
    // if logging itself fails.

    if (runId) {
      try {
        await updateSyncRun(
          runId,
          {
            completed_at:
              new Date().toISOString(),

            success:
              false,

            error:
              message,

            metadata: {
              api_version:
                SHOPIFY_API_VERSION,

              shopify_write_back:
                false,

              duration_ms:
                Date.now() -
                startedAt,
            },
          }
        );
      } catch (logError) {
        console.error(
          "Could not record failed sync run",
          logError
        );
      }
    }


    return res
      .status(500)
      .json({
        ok:
          false,

        run_id:
          runId,

        error:
          message,

        shopify_write_back:
          false,
      });
  }
}
