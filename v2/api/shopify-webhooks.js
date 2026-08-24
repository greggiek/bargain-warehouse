const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');
const API_VERSION = '2026-07';
const clean = value => String(value || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');

const stores = () => [
  { key: 'store_1', label: 'Shopify NY', domain: process.env.SHOPIFY_STORE_1_DOMAIN, clientId: process.env.SHOPIFY_STORE_1_CLIENT_ID, clientSecret: process.env.SHOPIFY_STORE_1_CLIENT_SECRET },
  { key: 'store_2', label: 'Shopify CT', domain: process.env.SHOPIFY_STORE_2_DOMAIN, clientId: process.env.SHOPIFY_STORE_2_CLIENT_ID, clientSecret: process.env.SHOPIFY_STORE_2_CLIENT_SECRET }
];

async function tokenFor(store) {
  const shop = clean(store.domain);
  if (!shop || !store.clientId || !store.clientSecret) throw new Error(store.label + ': Shopify connection is not configured');
  const response = await fetch('https://' + shop + '/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: store.clientId, client_secret: store.clientSecret })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(store.label + ': Shopify token request failed');
  return { shop, token: body.access_token };
}

async function graph(store, query, variables) {
  const { shop, token } = await tokenFor(store);
  const response = await fetch('https://' + shop + '/admin/api/' + API_VERSION + '/graphql.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(25000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) throw new Error(body.errors?.map(x => x.message).join('; ') || store.label + ': Shopify request failed');
  return body.data;
}

function allowed(auth) {
  return ['admin', 'developer'].includes(auth.user.role);
}

async function load(url, key) {
  const [locationsResponse, mappingsResponse, eventsResponse] = await Promise.all([
    fetch(url + '/rest/v1/locations?active=eq.true&select=id,name&order=name.asc', { headers: jsonHeaders(key) }),
    fetch(url + '/rest/v1/shopify_location_mappings?select=store_key,shopify_location_id,shopify_location_name,location_id&order=store_key,shopify_location_name', { headers: jsonHeaders(key) }),
    fetch(url + '/rest/v1/shopify_webhook_events?select=store_key,shopify_order_number,shopify_location_id,status,processed_lines,skipped_lines,error,received_at&order=received_at.desc&limit=30', { headers: jsonHeaders(key) })
  ]);
  const [locations, mappings, events] = await Promise.all([locationsResponse.json(), mappingsResponse.json(), eventsResponse.json()]);
  if (!locationsResponse.ok || !mappingsResponse.ok || !eventsResponse.ok) throw new Error('Could not load warehouse webhook configuration');
  const locationQuery = 'query WarehouseLocations { locations(first: 250) { nodes { id name isActive } } webhookSubscriptions(first: 250) { nodes { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }';
  const shopifyStores = await Promise.all(stores().map(async store => {
    try {
      const data = await graph(store, locationQuery, {});
      return {
        key: store.key, label: store.label, error: null,
        locations: (data.locations?.nodes || []).filter(item => item.isActive),
        subscriptions: (data.webhookSubscriptions?.nodes || []).filter(item => item.topic === 'ORDERS_PAID')
      };
    } catch (error) {
      return { key: store.key, label: store.label, error: error.message, locations: [], subscriptions: [] };
    }
  }));
  return { locations, mappings, events, stores: shopifyStores };
}

module.exports = async function shopifyWebhookSetup(req, res) {
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  if (!allowed(auth)) return res.status(403).json({ ok: false, error: 'administrator_role_required' });
  const { url, serviceRoleKey } = configuration();

  try {
    if (req.method === 'GET') return res.json({ ok: true, ...(await load(url, serviceRoleKey)) });
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ ok: false, error: 'method_not_allowed' }); }

    const body = req.body || {};
    if (body.action === 'save_mappings') {
      const mappings = Array.isArray(body.mappings) ? body.mappings : [];
      if (!mappings.length || mappings.length > 50) return res.status(400).json({ ok: false, error: 'Save between 1 and 50 location mappings.' });
      const payload = mappings.map(item => ({
        store_key: String(item.storeKey || ''),
        shopify_location_id: String(item.shopifyLocationId || ''),
        shopify_location_name: String(item.shopifyLocationName || ''),
        location_id: Number(item.locationId),
        updated_at: new Date().toISOString()
      }));
      if (payload.some(item => !['store_1', 'store_2'].includes(item.store_key) || !item.shopify_location_id || !item.shopify_location_name || !Number.isInteger(item.location_id))) {
        return res.status(400).json({ ok: false, error: 'Every mapping needs a Shopify store, Shopify location, and V2 warehouse.' });
      }
      const response = await fetch(url + '/rest/v1/shopify_location_mappings?on_conflict=store_key,shopify_location_id', {
        method: 'POST',
        headers: { ...jsonHeaders(serviceRoleKey), Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'Could not save Shopify location mappings.');
      return res.json({ ok: true, saved: result.length });
    }

    if (body.action === 'enable_paid_orders') {
      const callbackUrl = String(body.callbackUrl || '').trim();
      if (!/^https:\/\/.+\/api\/webhooks\/shopify-order-paid$/.test(callbackUrl)) return res.status(400).json({ ok: false, error: 'Invalid webhook callback URL.' });
      const existing = await load(url, serviceRoleKey);
      const incomplete = existing.stores.filter(store => !store.error && !existing.mappings.some(mapping => mapping.store_key === store.key));
      if (incomplete.length) return res.status(400).json({ ok: false, error: 'Map at least one sale location for ' + incomplete.map(store => store.label).join(' and ') + ' before enabling.' });
      const mutation = 'mutation CreatePaidOrderWebhook($topic: WebhookSubscriptionTopic!, $subscription: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) { webhookSubscription { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } userErrors { field message } } }';
      const outcomes = [];
      for (const store of stores()) {
        const configured = existing.stores.find(item => item.key === store.key);
        if (configured?.error) { outcomes.push({ store: store.label, status: 'error', error: configured.error }); continue; }
        const already = (configured?.subscriptions || []).some(subscription => subscription.endpoint?.callbackUrl === callbackUrl);
        if (already) { outcomes.push({ store: store.label, status: 'already_enabled' }); continue; }
        const data = await graph(store, mutation, { topic: 'ORDERS_PAID', subscription: { uri: callbackUrl, format: 'JSON' } });
        const errors = data.webhookSubscriptionCreate?.userErrors || [];
        outcomes.push(errors.length ? { store: store.label, status: 'error', error: errors.map(item => item.message).join('; ') } : { store: store.label, status: 'enabled' });
      }
      return res.json({ ok: true, outcomes });
    }

    return res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'shopify_webhook_setup_failed' });
  }
};