const crypto = require('crypto');
const { configuration, jsonHeaders } = require('../_lib/auth');

const clean = value => String(value || '').replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
const stores = () => [
  { key: 'store_1', domain: process.env.SHOPIFY_STORE_1_DOMAIN, secret: process.env.SHOPIFY_STORE_1_CLIENT_SECRET },
  { key: 'store_2', domain: process.env.SHOPIFY_STORE_2_DOMAIN, secret: process.env.SHOPIFY_STORE_2_CLIENT_SECRET }
];

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verified(raw, supplied, secret) {
  if (!supplied || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  const actual = Buffer.from(String(supplied));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

module.exports.config = { api: { bodyParser: false } };

module.exports = async function shopifyPaidOrderWebhook(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  try {
    const shopDomain = clean(req.headers['x-shopify-shop-domain']);
    const store = stores().find(candidate => clean(candidate.domain) === shopDomain);
    if (!store) return res.status(401).json({ ok: false, error: 'unknown_shopify_store' });

    const raw = await readRaw(req);
    if (!verified(raw, req.headers['x-shopify-hmac-sha256'], store.secret)) {
      return res.status(401).json({ ok: false, error: 'invalid_webhook_signature' });
    }

    const topic = String(req.headers['x-shopify-topic'] || '').toLowerCase();
    if (topic !== 'orders/paid') return res.status(202).json({ ok: true, ignored: true, topic });

    const payload = JSON.parse(raw.toString('utf8'));
    const webhookId = String(req.headers['x-shopify-webhook-id'] || '');
    const orderId = String(payload.id || '');
    if (!webhookId || !orderId) return res.status(400).json({ ok: false, error: 'invalid_order_payload' });

    const { url, serviceRoleKey } = configuration();
    if (!url || !serviceRoleKey) throw new Error('warehouse_database_not_configured');

    const lines = Array.isArray(payload.line_items) ? payload.line_items.map(line => ({
      id: String(line.id || ''),
      sku: String(line.sku || '').trim(),
      quantity: Number(line.quantity || 0)
    })) : [];

    const response = await fetch(url + '/rest/v1/rpc/apply_v2_shopify_paid_order', {
      method: 'POST',
      headers: jsonHeaders(serviceRoleKey),
      body: JSON.stringify({
        p_store_key: store.key,
        p_webhook_id: webhookId,
        p_order_id: orderId,
        p_order_number: String(payload.name || payload.order_number || ''),
        p_shopify_location_id: payload.location_id == null ? null : String(payload.location_id),
        p_lines: lines
      }),
      signal: AbortSignal.timeout(20000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || 'warehouse_sale_post_failed');

    return res.status(200).json({ ok: true, result });
  } catch (error) {
    console.error('Shopify paid-order webhook failed', error);
    return res.status(500).json({ ok: false, error: error.message || 'shopify_paid_webhook_failed' });
  }
};