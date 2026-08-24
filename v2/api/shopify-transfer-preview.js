const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const API_VERSION = '2026-07';
const clean = value => String(value || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const stores = () => [
  { key: 'store_1', label: 'Shopify NY', domain: process.env.SHOPIFY_STORE_1_DOMAIN, clientId: process.env.SHOPIFY_STORE_1_CLIENT_ID, clientSecret: process.env.SHOPIFY_STORE_1_CLIENT_SECRET },
  { key: 'store_2', label: 'Shopify CT', domain: process.env.SHOPIFY_STORE_2_DOMAIN, clientId: process.env.SHOPIFY_STORE_2_CLIENT_ID, clientSecret: process.env.SHOPIFY_STORE_2_CLIENT_SECRET }
];
const adminOnly = auth => ['admin', 'developer'].includes(auth.user.role);

async function tokenFor(store) {
  const shop = clean(store.domain);
  if (!shop || !store.clientId || !store.clientSecret) throw new Error(store.label + ': Shopify connection is not configured');
  const response = await fetch('https://' + shop + '/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: store.clientId, client_secret: store.clientSecret }),
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(store.label + ': Shopify token request failed');
  return { shop, token: body.access_token };
}

async function graphql(store, query, variables) {
  const { shop, token } = await tokenFor(store);
  const response = await fetch('https://' + shop + '/admin/api/' + API_VERSION + '/graphql.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(25000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) throw new Error(body.errors?.map(item => item.message).join('; ') || store.label + ': Shopify request failed');
  return body.data;
}

async function loadConfig(url, key) {
  const [locationsResponse, mappingsResponse] = await Promise.all([
    fetch(url + '/rest/v1/locations?active=eq.true&select=id,name&order=name.asc', { headers: jsonHeaders(key) }),
    fetch(url + '/rest/v1/shopify_location_mappings?select=store_key,shopify_location_id,shopify_location_name,location_id&order=store_key,shopify_location_name', { headers: jsonHeaders(key) })
  ]);
  const [locations, mappings] = await Promise.all([locationsResponse.json(), mappingsResponse.json()]);
  if (!locationsResponse.ok || !mappingsResponse.ok) throw new Error('Could not load warehouse / Shopify location mappings.');
  return { locations, mappings };
}

const locationsQuery = 'query TransferLocations { locations(first: 250) { nodes { id name isActive } } }';
async function connectionStatus() {
  return Promise.all(stores().map(async store => {
    try {
      const data = await graphql(store, locationsQuery, {});
      return { key: store.key, label: store.label, ok: true, locations: (data.locations?.nodes || []).filter(location => location.isActive) };
    } catch (error) {
      return { key: store.key, label: store.label, ok: false, error: error.message, locations: [] };
    }
  }));
}

const variantQuery = `query TransferVariant($query: String!) {
  productVariants(first: 25, query: $query) {
    nodes {
      id sku displayName
      inventoryItem {
        id
        inventoryLevels(first: 250) {
          nodes {
            location { id }
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }
  }
}`;

function normalizeSku(value) { return String(value || '').trim(); }
function escapeSearch(value) { return value.replace(/["\\]/g, '\\\\$&'); }
function availableAt(variant, locationId) {
  const level = (variant.inventoryItem?.inventoryLevels?.nodes || []).find(item => item.location?.id === locationId);
  return Number((level?.quantities || []).find(item => item.name === 'available')?.quantity || 0);
}

async function preview(url, key, body) {
  const sourceLocationId = Number(body.sourceLocationId);
  const destinationLocationId = Number(body.destinationLocationId);
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!Number.isInteger(sourceLocationId) || !Number.isInteger(destinationLocationId) || sourceLocationId === destinationLocationId) {
    throw new Error('Choose two different mapped warehouses.');
  }
  if (!lines.length || lines.length > 50) throw new Error('Preview between 1 and 50 SKU lines.');
  const normalizedLines = lines.map(line => ({ sku: normalizeSku(line.sku), quantity: Number(line.quantity) }));
  if (normalizedLines.some(line => !line.sku || !Number.isFinite(line.quantity) || line.quantity <= 0)) {
    throw new Error('Every line needs an exact SKU and a quantity above zero.');
  }
  if (new Set(normalizedLines.map(line => line.sku.toLowerCase())).size !== normalizedLines.length) {
    throw new Error('Each SKU may be included once.');
  }

  const { locations, mappings } = await loadConfig(url, key);
  const source = mappings.find(mapping => Number(mapping.location_id) === sourceLocationId);
  const destination = mappings.find(mapping => Number(mapping.location_id) === destinationLocationId);
  if (!source || !destination) throw new Error('Map both V2 warehouses to Shopify locations before previewing a transfer.');
  const sourceWarehouse = locations.find(location => Number(location.id) === sourceLocationId);
  const destinationWarehouse = locations.find(location => Number(location.id) === destinationLocationId);
  if (!sourceWarehouse || !destinationWarehouse) throw new Error('One selected V2 warehouse is inactive or unavailable.');

  const [sourceStore, destinationStore] = [source, destination].map(mapping => stores().find(store => store.key === mapping.store_key));
  const itemPlans = [];
  for (const line of normalizedLines) {
    const sourceData = await graphql(sourceStore, variantQuery, { query: 'sku:"' + escapeSearch(line.sku) + '"' });
    const sourceMatches = (sourceData.productVariants?.nodes || []).filter(variant => normalizeSku(variant.sku).toLowerCase() === line.sku.toLowerCase());
    if (sourceMatches.length !== 1) throw new Error(sourceStore.label + ': expected exactly one variant for SKU ' + line.sku + '.');
    const sourceVariant = sourceMatches[0];
    const sourceAvailable = availableAt(sourceVariant, source.shopify_location_id);
    let destinationVariant = null;
    if (source.store_key !== destination.store_key) {
      const destinationData = await graphql(destinationStore, variantQuery, { query: 'sku:"' + escapeSearch(line.sku) + '"' });
      const destinationMatches = (destinationData.productVariants?.nodes || []).filter(variant => normalizeSku(variant.sku).toLowerCase() === line.sku.toLowerCase());
      if (destinationMatches.length !== 1) throw new Error(destinationStore.label + ': expected exactly one destination variant for SKU ' + line.sku + '.');
      destinationVariant = destinationMatches[0];
    }
    itemPlans.push({
      sku: line.sku, quantity: line.quantity, product: sourceVariant.displayName || line.sku,
      sourceAvailable, canShip: sourceAvailable >= line.quantity,
      sourceVariantId: sourceVariant.id,
      destinationVariantId: destinationVariant?.id || sourceVariant.id
    });
  }

  const routeType = source.store_key === destination.store_key ? 'same_store' : 'cross_store';
  return {
    previewOnly: true,
    routeType,
    source: { warehouse: sourceWarehouse.name, store: sourceStore.label, shopifyLocation: source.shopify_location_name },
    destination: { warehouse: destinationWarehouse.name, store: destinationStore.label, shopifyLocation: destination.shopify_location_name },
    lines: itemPlans,
    allLinesAvailable: itemPlans.every(line => line.canShip),
    plannedActions: routeType === 'same_store'
      ? ['Create one native Shopify inventory transfer.', 'Ship and receive it in Shopify; Shopify remains the inventory authority.']
      : ['At shipping, record an inventory adjustment down at the sending Shopify location (not a sale).', 'Create a destination Shopify purchase order / inbound transfer reference.', 'Receive at the destination in Shopify. V2 keeps only the link and scan audit.'],
    writeGuard: 'Preview only — this request does not create Shopify transfers, purchase orders, sales orders, inventory adjustments, or inventory ledger movements.'
  };
}

module.exports = async function shopifyTransferPreview(req, res) {
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  if (!adminOnly(auth)) return res.status(403).json({ ok: false, error: 'administrator_role_required' });
  const { url, serviceRoleKey } = configuration();
  try {
    if (req.method === 'GET') {
      const [config, storesStatus] = await Promise.all([loadConfig(url, serviceRoleKey), connectionStatus()]);
      return res.json({ ok: true, previewOnly: true, ...config, stores: storesStatus });
    }
    if (req.method === 'POST') {
      if ((req.body || {}).action !== 'preview') return res.status(400).json({ ok: false, error: 'unknown_action' });
      return res.json({ ok: true, ...(await preview(url, serviceRoleKey, req.body || {})) });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'shopify_transfer_preview_failed' });
  }
};
