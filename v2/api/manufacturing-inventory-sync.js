const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const API_VERSION = '2026-07';
const clean = value => String(value || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const stores = () => [
  { key: 'store_1', label: 'Shopify NY', domain: process.env.SHOPIFY_STORE_1_DOMAIN, clientId: process.env.SHOPIFY_STORE_1_CLIENT_ID, clientSecret: process.env.SHOPIFY_STORE_1_CLIENT_SECRET },
  { key: 'store_2', label: 'Shopify CT', domain: process.env.SHOPIFY_STORE_2_DOMAIN, clientId: process.env.SHOPIFY_STORE_2_CLIENT_ID, clientSecret: process.env.SHOPIFY_STORE_2_CLIENT_SECRET }
];

async function rest(url, key, path, options = {}) {
  const response = await fetch(url + '/rest/v1/' + path, {
    ...options,
    headers: { ...jsonHeaders(key), ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeout || 30000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || 'manufacturing_inventory_sync_database_error');
  return body;
}

async function rpc(url, key, name, body) {
  return rest(url, key, 'rpc/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function tokenFor(store) {
  const shop = clean(store.domain);
  if (!shop || !store.clientId || !store.clientSecret) throw new Error(store.label + ': Shopify connection is not configured.');
  const response = await fetch('https://' + shop + '/admin/oauth/access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: store.clientId, client_secret: store.clientSecret }),
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(store.label + ': Shopify token request failed.');
  return { shop, token: body.access_token };
}

async function graphql(store, query, variables) {
  const { shop, token } = await tokenFor(store);
  const response = await fetch('https://' + shop + '/admin/api/' + API_VERSION + '/graphql.json', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) throw new Error(body.errors?.map(error => error.message).join('; ') || 'Shopify request failed.');
  return body.data;
}

const levelQuery = `query ManufacturingInventoryLevel($inventoryItemId: ID!, $locationId: ID!) {
  inventoryItem(id: $inventoryItemId) {
    inventoryLevel(locationId: $locationId) { quantities(names: ["on_hand", "available"]) { name quantity } }
  }
}`;
const adjustMutation = `mutation ManufacturingInventoryAdjustment($input: InventoryAdjustQuantitiesInput!, $key: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
    inventoryAdjustmentGroup { id referenceDocumentUri }
    userErrors { field message }
  }
}`;

function quantity(data, name) {
  const value = data?.inventoryItem?.inventoryLevel?.quantities?.find(item => item.name === name)?.quantity;
  if (!Number.isFinite(Number(value))) throw new Error('Shopify inventory level is unavailable.');
  return Number(value);
}

async function allowed(req) {
  if (req.method === 'GET' && process.env.CRON_SECRET && req.headers?.authorization === 'Bearer ' + process.env.CRON_SECRET) return true;
  if (req.method !== 'POST') return false;
  const auth = await requireUser(req);
  return auth.ok && ['admin', 'developer'].includes(auth.user.role);
}

module.exports = async function manufacturingInventorySync(req, res) {
  if (!(await allowed(req))) return res.status(req.method === 'GET' || req.method === 'POST' ? 403 : 405).json({ ok: false, error: 'manufacturing_inventory_sync_not_authorized' });
  const { url, serviceRoleKey } = configuration();
  const claim = await rpc(url, serviceRoleKey, 'claim_mfg_shopify_inventory_adjustment', { p_lease_seconds: 120 });
  if (!claim) return res.status(200).json({ ok: true, processed: false });
  try {
    const store = stores().find(item => item.key === claim.storeKey);
    if (!store) throw new Error('Shopify store route is unavailable.');
    const before = await graphql(store, levelQuery, { inventoryItemId: claim.shopifyInventoryItemId, locationId: claim.shopifyLocationId });
    const currentOnHand = quantity(before, 'on_hand');
    const currentAvailable = quantity(before, 'available');
    const expectedOnHand = await rpc(url, serviceRoleKey, 'prepare_mfg_shopify_inventory_adjustment', {
      p_id: claim.id, p_lease_token: claim.leaseToken, p_current_on_hand: currentOnHand
    });
    const result = await graphql(store, adjustMutation, {
      key: claim.idempotencyKey,
      input: {
        reason: 'correction', name: 'available',
        referenceDocumentUri: 'bmwarehouse://manufacturing-inventory/' + claim.id,
        changes: [{ inventoryItemId: claim.shopifyInventoryItemId, locationId: claim.shopifyLocationId,
          delta: Number(claim.quantityDelta), changeFromQuantity: currentAvailable }]
      }
    });
    const payload = result.inventoryAdjustQuantities;
    if (payload?.userErrors?.length) throw new Error(payload.userErrors.map(error => error.message).join('; '));
    const adjustmentId = payload?.inventoryAdjustmentGroup?.id;
    if (!adjustmentId) throw new Error('Shopify did not confirm the Manufacturing adjustment.');
    await rpc(url, serviceRoleKey, 'confirm_mfg_shopify_inventory_adjustment', {
      p_id: claim.id, p_lease_token: claim.leaseToken, p_shopify_adjustment_id: adjustmentId
    });
    return res.status(200).json({ ok: true, processed: true, adjustmentId, expectedOnHand, idempotencyKey: claim.idempotencyKey });
  } catch (error) {
    try {
      await rpc(url, serviceRoleKey, 'fail_mfg_shopify_inventory_adjustment', {
        p_id: claim.id, p_lease_token: claim.leaseToken, p_error: error.message || 'manufacturing_inventory_sync_failed'
      });
    } catch (leaseError) {
      console.error('Manufacturing inventory queue lease could not be released', leaseError);
    }
    console.error('Manufacturing Shopify inventory handoff failed', { adjustmentId: claim.id, attempt: claim.attempt, error: error.message });
    return res.status(503).json({ ok: false, error: error.message || 'manufacturing_inventory_sync_failed', retryable: true, adjustmentId: claim.id });
  }
};
