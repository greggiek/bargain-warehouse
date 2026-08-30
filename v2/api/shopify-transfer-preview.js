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
  if (normalizedLines.some(line => !line.sku || !Number.isInteger(line.quantity) || line.quantity <= 0)) {
    throw new Error('Every line needs an exact SKU and a whole-piece quantity above zero.');
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
      sourceInventoryItemId: sourceVariant.inventoryItem.id,
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

const createNativeTransferMutation = `mutation CreateNativeTransfer($input: InventoryTransferCreateInput!, $idempotencyKey: String!) {
  inventoryTransferCreate(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryTransfer { id name status referenceName }
    userErrors { field message }
  }
}`;

async function nextTransferReference(url, key) {
  const response = await fetch(url + '/rest/v1/rpc/next_bm_transfer_reference', { method: 'POST', headers: jsonHeaders(key), body: '{}' });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value) throw new Error('Could not reserve the next transfer number.');
  return String(value);
}

async function postgrest(url, path, method, key, body, prefer) {
  const response = await fetch(url + '/rest/v1/' + path, {
    method,
    headers: { ...jsonHeaders(key), ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || result.hint || 'Could not save the Shopify transfer link.');
  return result;
}

async function createNativeTransfer(url, key, auth, body) {
  const plan = await preview(url, key, body);
  if (plan.routeType !== 'same_store') {
    throw new Error('Cross-store transfers are not enabled yet. This route needs the linked inbound PO workflow, so V2 will not create an incomplete move.');
  }
  if (!plan.allLinesAvailable) throw new Error('One or more SKUs do not have enough available source stock. Nothing was created.');

  const sourceLocationId = Number(body.sourceLocationId);
  const destinationLocationId = Number(body.destinationLocationId);
  const config = await loadConfig(url, key);
  const source = config.mappings.find(mapping => Number(mapping.location_id) === sourceLocationId);
  const destination = config.mappings.find(mapping => Number(mapping.location_id) === destinationLocationId);
  const store = stores().find(item => item.key === source.store_key);
  const bmReference = 'TR-' + await nextTransferReference(url, key);

  const linkRows = await postgrest(url, 'shopify_transfer_links', 'POST', key, {
    bm_reference: bmReference,
    route_type: 'same_store',
    status: 'draft',
    source_location_id: sourceLocationId,
    destination_location_id: destinationLocationId,
    source_store_key: source.store_key,
    destination_store_key: destination.store_key,
    source_shopify_location_id: source.shopify_location_id,
    destination_shopify_location_id: destination.shopify_location_id,
    created_by_user_id: auth.user.id,
    created_by_name: auth.user.display_name,
    metadata: { created_from: 'bm_warehouse_v2', write_mode: 'native_shopify_transfer' }
  }, 'return=representation');
  const link = linkRows[0];
  if (!link) throw new Error('Could not create the BM transfer audit link.');

  try {
    const data = await graphql(store, createNativeTransferMutation, {
      input: {
        originLocationId: source.shopify_location_id,
        destinationLocationId: destination.shopify_location_id,
        lineItems: plan.lines.map(line => ({ inventoryItemId: line.sourceInventoryItemId, quantity: line.quantity })),
        referenceName: bmReference,
        note: 'Created by BM Warehouse V2. Draft only; Shopify remains inventory authority.',
        tags: ['BM Warehouse', 'BM Transfer']
      },
      idempotencyKey: crypto.randomUUID()
    });
    const payload = data.inventoryTransferCreate || {};
    const errors = payload.userErrors || [];
    if (errors.length) throw new Error(errors.map(item => item.message).join('; '));
    if (!payload.inventoryTransfer?.id) throw new Error('Shopify did not return a transfer ID.');

    await postgrest(url, 'shopify_transfer_links?id=eq.' + encodeURIComponent(link.id), 'PATCH', key, {
      source_shopify_transfer_id: payload.inventoryTransfer.id,
      metadata: { created_from: 'bm_warehouse_v2', write_mode: 'native_shopify_transfer', shopify_transfer_name: payload.inventoryTransfer.name }
    });
    await postgrest(url, 'shopify_transfer_link_lines', 'POST', key, plan.lines.map(line => ({
      transfer_link_id: link.id,
      sku: line.sku,
      quantity: line.quantity,
      source_shopify_variant_id: line.sourceVariantId,
      destination_shopify_variant_id: line.destinationVariantId
    })));
    return {
      bmReference,
      shopifyTransfer: payload.inventoryTransfer,
      message: 'Draft Shopify transfer ' + (payload.inventoryTransfer.name || bmReference) + ' created. It has not moved stock; mark it Ready to ship in Shopify when material actually leaves.'
    };
  } catch (error) {
    await postgrest(url, 'shopify_transfer_links?id=eq.' + encodeURIComponent(link.id), 'PATCH', key, { status: 'failed', error: error.message || 'Shopify transfer creation failed' }).catch(() => {});
    throw error;
  }
}


function legalEntityFor(storeKey) {
  return storeKey === 'store_1'
    ? 'Bargain Build Inc. (NY)'
    : 'Bargain Build CT Inc. (CT)';
}

async function createIntercompanyDraft(url, key, auth, body) {
  const plan = await preview(url, key, body);
  if (plan.routeType !== 'cross_store') throw new Error('Choose warehouses in different legal entities for an intercompany draft.');
  if (!plan.allLinesAvailable) throw new Error('One or more SKUs do not have enough available source stock. Nothing was created.');

  const sourceLocationId = Number(body.sourceLocationId);
  const destinationLocationId = Number(body.destinationLocationId);
  const config = await loadConfig(url, key);
  const source = config.mappings.find(mapping => Number(mapping.location_id) === sourceLocationId);
  const destination = config.mappings.find(mapping => Number(mapping.location_id) === destinationLocationId);
  const bmReference = 'IC-' + await nextTransferReference(url, key);

  const linkRows = await postgrest(url, 'shopify_transfer_links', 'POST', key, {
    bm_reference: bmReference,
    route_type: 'cross_store',
    status: 'draft',
    source_location_id: sourceLocationId,
    destination_location_id: destinationLocationId,
    source_store_key: source.store_key,
    destination_store_key: destination.store_key,
    source_shopify_location_id: source.shopify_location_id,
    destination_shopify_location_id: destination.shopify_location_id,
    created_by_user_id: auth.user.id,
    created_by_name: auth.user.display_name,
    metadata: {
      created_from: 'bm_warehouse_v2',
      write_mode: 'intercompany_draft_only',
      source_entity: legalEntityFor(source.store_key),
      destination_entity: legalEntityFor(destination.store_key),
      inventory_effect: 'none',
      next_steps: ['Prepare the outbound shipment.', 'Create the matching inbound receipt.', 'Only then post the Shopify inventory movements.']
    }
  }, 'return=representation');
  const link = linkRows[0];
  if (!link) throw new Error('Could not create the intercompany transfer link.');

  try {
    await postgrest(url, 'shopify_transfer_link_lines', 'POST', key, plan.lines.map(line => ({
      transfer_link_id: link.id,
      sku: line.sku,
      quantity: line.quantity,
      source_shopify_variant_id: line.sourceVariantId,
      destination_shopify_variant_id: line.destinationVariantId
    })));
    return {
      bmReference,
      intercompanyDraft: true,
      message: 'Intercompany draft ' + bmReference + ' created for ' + legalEntityFor(source.store_key) + ' → ' + legalEntityFor(destination.store_key) + '. No Shopify inventory changed. The next step is the paired ship/receive workflow.'
    };
  } catch (error) {
    await postgrest(url, 'shopify_transfer_links?id=eq.' + encodeURIComponent(link.id), 'PATCH', key, {
      status: 'failed',
      error: error.message || 'Could not create intercompany lines.'
    }).catch(() => {});
    throw error;
  }
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
      const action = (req.body || {}).action;
      if (action === 'preview') return res.json({ ok: true, ...(await preview(url, serviceRoleKey, req.body || {})) });
      if (action === 'create_native_same_store') return res.status(201).json({ ok: true, ...(await createNativeTransfer(url, serviceRoleKey, auth, req.body || {})) });
      if (action === 'create_intercompany_draft') return res.status(201).json({ ok: true, ...(await createIntercompanyDraft(url, serviceRoleKey, auth, req.body || {})) });
      return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'shopify_transfer_preview_failed' });
  }
};