const { configuration, jsonHeaders } = require('./_lib/auth');

const API_VERSION = '2026-07';
const STORE_KEY = 'store_2';
const BATCH_SIZE = 50;
const clean = value => String(value || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function rest(url, key, path, options = {}) {
  const response = await fetch(url + '/rest/v1/' + path, {
    ...options,
    headers: { ...jsonHeaders(key), ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeout || 30000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || 'Database request failed');
  return body;
}

async function token() {
  const shop = clean(process.env.SHOPIFY_STORE_2_DOMAIN);
  const response = await fetch('https://' + shop + '/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_STORE_2_CLIENT_ID,
      client_secret: process.env.SHOPIFY_STORE_2_CLIENT_SECRET
    }),
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error('Shopify CT token request failed');
  return { shop, accessToken: body.access_token };
}

async function graphql(shop, accessToken, query, variables, telemetry) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch('https://' + shop + '/admin/api/' + API_VERSION + '/graphql.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(45000)
      });
      const body = await response.json().catch(() => ({}));
      const throttled = response.status === 429 || body.errors?.some(error => error.extensions?.code === 'THROTTLED');
      if (throttled) {
        telemetry.throttleEvents++;
        telemetry.retryEvents++;
        await wait(Math.min(1000 * 2 ** attempt, 10000));
        continue;
      }
      if (!response.ok || body.errors?.length) throw new Error(body.errors?.map(error => error.message).join('; ') || 'Shopify GraphQL failed');
      return body.data;
    } catch (error) {
      lastError = error;
      if (attempt === 4) break;
      telemetry.retryEvents++;
      await wait(Math.min(1000 * 2 ** attempt, 10000));
    }
  }
  throw lastError;
}

const emptyCategory = () => ({ lines: 0, units: 0, salesValue: 0, skus: [], examples: [] });
const emptyAudit = () => ({
  status: 'running',
  nextOrderOffset: 0,
  sourceRows: 0,
  sourceSkus: 0,
  sourceOrders: 0,
  processedOrders: 0,
  matchedSourceLines: 0,
  throttleEvents: 0,
  retryEvents: 0,
  categories: {
    custom_non_catalog: emptyCategory(),
    real_product_mapping_failure: emptyCategory(),
    blank_or_invalid_sku: emptyCategory(),
    archived_product: emptyCategory(),
    special_order_non_stock: emptyCategory(),
    still_unknown: emptyCategory()
  }
});

function categoryFor(detail) {
  const sku = String(detail.sku || '').trim().toUpperCase();
  const placeholder = !sku || /^(CUSTOM|MISC|MISCELLANEOUS|CUSTOM SALE|OPEN ITEM|N\/A|NA|NONE|NO SKU)$/i.test(sku);
  if (!detail.productId && !detail.variantId) return 'custom_non_catalog';
  if (placeholder) return 'blank_or_invalid_sku';
  if (detail.productStatus === 'ARCHIVED') return 'archived_product';
  const specialEvidence = [detail.title, detail.productTitle, detail.productType, ...(detail.productTags || [])].join(' ');
  if (/\b(SPECIAL[ -]?ORDER|NON[ -]?STOCK|CUSTOM[ -]?ORDER)\b/i.test(specialEvidence) || detail.inventoryTracked === false) {
    return 'special_order_non_stock';
  }
  if (detail.productId || detail.variantId) return 'real_product_mapping_failure';
  return 'still_unknown';
}

function addResult(audit, categoryName, detail) {
  const category = audit.categories[categoryName];
  const units = Number(detail.fulfilledQuantity || 0);
  const value = Number(detail.fulfilledSalesValue || 0);
  category.lines++;
  category.units += units;
  category.salesValue += value;
  if (detail.sku && !category.skus.includes(detail.sku)) category.skus.push(detail.sku);
  if (category.examples.length < 5) category.examples.push(detail);
}

module.exports = async function ctUnmatchedSalesAudit(req, res) {
  const cron = req.method === 'GET' && Boolean(process.env.CRON_SECRET) &&
    String(req.headers?.authorization || '') === 'Bearer ' + process.env.CRON_SECRET;
  if (!cron) return res.status(401).json({ ok: false, error: 'cron_authorization_required' });

  const telemetry = { throttleEvents: 0, retryEvents: 0 };
  try {
    const { url, serviceRoleKey } = configuration();
    const jobs = await rest(url, serviceRoleKey,
      'shopify_sync_jobs?store_key=eq.store_2&job_type=eq.sales_backfill&status=eq.completed&select=id,checkpoint&order=completed_at.desc&limit=1');
    const job = jobs[0];
    if (!job) throw new Error('Completed CT sales backfill not found');

    const rows = await rest(url, serviceRoleKey,
      'shopify_sales_dedup?store_key=eq.store_2&product_id=is.null&select=shopify_order_id,shopify_line_id,sku,gross_fulfilled_quantity&order=shopify_order_id.asc&limit=1000');
    const orderIds = [...new Set(rows.map(row => row.shopify_order_id))].sort();
    const skuCount = new Set(rows.map(row => row.sku).filter(Boolean)).size;
    let audit = job.checkpoint?.ctUnmatchedAudit || emptyAudit();
    if (audit.status === 'completed') return res.status(200).json({ ok: true, alreadyComplete: true, audit });

    audit.sourceRows = rows.length;
    audit.sourceSkus = skuCount;
    audit.sourceOrders = orderIds.length;
    const batchIds = orderIds.slice(audit.nextOrderOffset, audit.nextOrderOffset + BATCH_SIZE);
    const wanted = new Map();
    for (const row of rows) {
      if (!batchIds.includes(row.shopify_order_id)) continue;
      wanted.set(row.shopify_line_id, row);
    }

    const auth = await token();
    const query = `query BMUnmatchedAudit($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Order {
          id name sourceName
          channelInformation { channelDefinition { channelName } }
          retailLocation { id name }
          fulfillments(first: 100) {
            id location { id name }
            fulfillmentLineItems(first: 250) {
              nodes {
                id quantity
                lineItem {
                  id title sku quantity requiresShipping
                  discountedTotalSet { shopMoney { amount currencyCode } }
                  variant {
                    id title
                    inventoryItem { id tracked }
                    product { id title status productType tags }
                  }
                }
              }
            }
          }
        }
      }
    }`;
    const data = batchIds.length ? await graphql(auth.shop, auth.accessToken, query, { ids: batchIds }, telemetry) : { nodes: [] };

    for (const order of data.nodes || []) {
      if (!order) continue;
      for (const fulfillment of order.fulfillments || []) {
        for (const fulfilled of fulfillment.fulfillmentLineItems?.nodes || []) {
          const cached = wanted.get(fulfilled.id);
          if (!cached) continue;
          const line = fulfilled.lineItem;
          const variant = line?.variant;
          const product = variant?.product;
          const orderedQuantity = Number(line?.quantity || 0);
          const totalValue = Number(line?.discountedTotalSet?.shopMoney?.amount || 0);
          const fulfilledQuantity = Number(cached.gross_fulfilled_quantity || fulfilled.quantity || 0);
          const detail = {
            orderId: order.id,
            orderName: order.name,
            fulfillmentLineId: fulfilled.id,
            title: line?.title || null,
            sku: line?.sku || cached.sku || null,
            productId: product?.id || null,
            variantId: variant?.id || null,
            inventoryItemId: variant?.inventoryItem?.id || null,
            productStatus: product?.status || null,
            productTitle: product?.title || null,
            productType: product?.productType || null,
            productTags: product?.tags || [],
            requiresShipping: line?.requiresShipping ?? null,
            inventoryTracked: variant?.inventoryItem?.tracked ?? null,
            posLocationId: order.retailLocation?.id || fulfillment.location?.id || null,
            posLocation: order.retailLocation?.name || fulfillment.location?.name || null,
            salesChannel: order.channelInformation?.channelDefinition?.channelName || order.sourceName || null,
            fulfilledQuantity,
            fulfilledSalesValue: orderedQuantity > 0 ? Number((totalValue * fulfilledQuantity / orderedQuantity).toFixed(2)) : 0,
            currency: line?.discountedTotalSet?.shopMoney?.currencyCode || null
          };
          addResult(audit, categoryFor(detail), detail);
          audit.matchedSourceLines++;
          wanted.delete(fulfilled.id);
        }
      }
    }

    for (const [lineId, cached] of wanted) {
      addResult(audit, 'still_unknown', {
        orderId: cached.shopify_order_id,
        fulfillmentLineId: lineId,
        title: null,
        sku: cached.sku || null,
        productId: null,
        variantId: null,
        inventoryItemId: null,
        fulfilledQuantity: Number(cached.gross_fulfilled_quantity || 0),
        fulfilledSalesValue: 0,
        evidence: 'Shopify source line was not returned for the cached fulfillment-line identity'
      });
    }

    audit.processedOrders += batchIds.length;
    audit.nextOrderOffset += batchIds.length;
    audit.throttleEvents += telemetry.throttleEvents;
    audit.retryEvents += telemetry.retryEvents;
    if (audit.nextOrderOffset >= orderIds.length) {
      audit.status = 'completed';
      audit.completedAt = new Date().toISOString();
      for (const category of Object.values(audit.categories)) {
        category.units = Number(category.units.toFixed(4));
        category.salesValue = Number(category.salesValue.toFixed(2));
        category.skuCount = category.skus.length;
      }
    }
    const checkpoint = { ...(job.checkpoint || {}), ctUnmatchedAudit: audit };
    await rest(url, serviceRoleKey, 'shopify_sync_jobs?id=eq.' + encodeURIComponent(job.id), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ checkpoint, updated_at: new Date().toISOString() })
    });

    return res.status(200).json({
      ok: true,
      batchOrders: batchIds.length,
      remainingOrders: Math.max(orderIds.length - audit.nextOrderOffset, 0),
      status: audit.status,
      throttleEvents: telemetry.throttleEvents,
      retryEvents: telemetry.retryEvents
    });
  } catch (error) {
    console.error('CT unmatched Shopify sales audit failed', error);
    return res.status(500).json({ ok: false, error: error.message || 'ct_unmatched_sales_audit_failed' });
  }
};
