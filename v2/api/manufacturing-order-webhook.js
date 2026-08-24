const crypto = require('crypto');
const { configuration, jsonHeaders } = require('./_lib/auth');

const cleanDomain = value => String(value || '').replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
const stores = () => [
  { key: 'store_1', domain: process.env.SHOPIFY_STORE_1_DOMAIN, secret: process.env.SHOPIFY_STORE_1_WEBHOOK_SECRET || process.env.SHOPIFY_STORE_1_CLIENT_SECRET },
  { key: 'store_2', domain: process.env.SHOPIFY_STORE_2_DOMAIN, secret: process.env.SHOPIFY_STORE_2_WEBHOOK_SECRET || process.env.SHOPIFY_STORE_2_CLIENT_SECRET }
];

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function validSignature(raw, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  const left = Buffer.from(expected), right = Buffer.from(String(signature));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
async function rest(url, key, path, options = {}) {
  const response = await fetch(url + '/rest/v1/' + path, {
    ...options,
    headers: { ...jsonHeaders(key), ...(options.headers || {}) },
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || 'Supabase request failed');
  return body;
}
async function rpc(url, key, name, body) {
  return rest(url, key, 'rpc/' + name, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}
function eq(value) { return encodeURIComponent('eq.' + String(value)); }
async function existingEvent(url, key, storeKey, orderId, lineId) {
  const rows = await rest(url, key,
    'manufacturing_shopify_work_order_events?shopify_store_key=' + eq(storeKey) +
    '&shopify_order_id=' + eq(orderId) +
    '&shopify_line_item_id=' + eq(lineId) +
    '&select=*&limit=1'
  );
  return rows[0] || null;
}
async function saveEvent(url, key, event) {
  return rest(url, key, 'manufacturing_shopify_work_order_events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(event)
  });
}
async function patchEvent(url, key, id, patch) {
  return rest(url, key, 'manufacturing_shopify_work_order_events?id=' + eq(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  });
}
async function activeRule(url, key, storeKey, productId) {
  const rows = await rest(url, key,
    'manufacturing_shopify_triggers?shopify_store_key=' + eq(storeKey) +
    '&shopify_product_id=' + eq(productId) +
    '&enabled=eq.true&select=id,destination_location_id&limit=1'
  );
  return rows[0] || null;
}
async function bomForSku(url, key, sku) {
  if (!sku) return null;
  const rows = await rest(url, key,
    'product_boms?active=eq.true&select=id,finished_product_id,products!inner(sku)' +
    '&products.sku=' + eq(sku) + '&limit=1'
  );
  return rows[0] || null;
}
async function handleLine({ url, key, storeKey, order, line }) {
  const productId = String(line.product_id || '');
  const rule = await activeRule(url, key, storeKey, productId);
  if (!rule) return { ignored: true };
  const orderId = String(order.id || ''), lineId = String(line.id || '');
  if (!orderId || !lineId) return { ignored: true };
  let event = await existingEvent(url, key, storeKey, orderId, lineId);
  if (event?.status === 'released') return { released: true, duplicate: true, workOrderId: event.production_work_order_id };
  if (!event) {
    const created = await saveEvent(url, key, {
      shopify_store_key: storeKey,
      shopify_order_id: orderId,
      shopify_order_name: String(order.name || ''),
      shopify_line_item_id: lineId,
      shopify_product_id: productId,
      shopify_variant_id: line.variant_id ? String(line.variant_id) : null,
      sku: line.sku || null,
      quantity: Number(line.quantity || 0),
      status: 'pending',
      payload: { financial_status: order.financial_status || null, source_name: order.source_name || null }
    });
    event = created[0] || await existingEvent(url, key, storeKey, orderId, lineId);
  }
  const bom = await bomForSku(url, key, line.sku);
  if (!bom) {
    await patchEvent(url, key, event.id, {
      status: 'needs_bom',
      error: 'No active BOM matches Shopify SKU ' + (line.sku || '—'),
      processed_at: new Date().toISOString()
    });
    return { needsBom: true };
  }
  try {
    const work = await rpc(url, key, 'start_v2_production_work_order', {
      p_bom_id: Number(bom.id),
      p_destination_location_id: Number(rule.destination_location_id),
      p_output_quantity: Number(line.quantity || 0),
      p_reference: 'Shopify ' + (order.name || orderId) + ' · ' + (line.sku || 'made-to-order'),
      p_idempotency_key: 'shopify-mto:' + storeKey + ':' + orderId + ':' + lineId,
      p_user_id: null,
      p_user_name: 'Shopify paid order'
    });
    await patchEvent(url, key, event.id, {
      status: 'released',
      error: null,
      bom_id: Number(bom.id),
      production_work_order_id: Number(work.workOrderId),
      processed_at: new Date().toISOString()
    });
    return { released: true, workOrderId: work.workOrderId, workOrderNumber: work.workOrderNumber };
  } catch (error) {
    await patchEvent(url, key, event.id, {
      status: 'failed',
      bom_id: Number(bom.id),
      error: error.message || 'Unable to release production work order',
      processed_at: new Date().toISOString()
    });
    throw error;
  }
}

module.exports = async function manufacturingOrderWebhook(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const domain = cleanDomain(req.headers['x-shopify-shop-domain']);
    const store = stores().find(item => cleanDomain(item.domain) === domain);
    const raw = await rawBody(req);
    if (!store || !validSignature(raw, req.headers['x-shopify-hmac-sha256'], store.secret)) {
      return res.status(401).json({ ok: false, error: 'invalid_shopify_webhook_signature' });
    }
    if (String(req.headers['x-shopify-topic'] || '').toLowerCase() !== 'orders/paid') {
      return res.status(200).json({ ok: true, ignored: 'topic_not_orders_paid' });
    }
    const order = JSON.parse(raw.toString('utf8'));
    if (order.cancelled_at || order.financial_status !== 'paid') {
      return res.status(200).json({ ok: true, ignored: 'order_not_eligible' });
    }
    const { url, serviceRoleKey } = configuration();
    const results = [];
    for (const line of order.line_items || []) {
      results.push(await handleLine({ url, key: serviceRoleKey, storeKey: store.key, order, line }));
    }
    return res.status(200).json({ ok: true, processed: results.filter(x => x.released).length, results });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'manufacturing_order_webhook_failed' });
  }
};

module.exports.config = { api: { bodyParser: false } };
