const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const API_VERSION = '2026-07';
const TRANSFER_ADMIN_ROLES = new Set(['admin', 'developer']);
const clean = value => String(value || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const stores = () => [
  { key: 'store_1', label: 'Shopify NY', domain: process.env.SHOPIFY_STORE_1_DOMAIN, clientId: process.env.SHOPIFY_STORE_1_CLIENT_ID, clientSecret: process.env.SHOPIFY_STORE_1_CLIENT_SECRET },
  { key: 'store_2', label: 'Shopify CT', domain: process.env.SHOPIFY_STORE_2_DOMAIN, clientId: process.env.SHOPIFY_STORE_2_CLIENT_ID, clientSecret: process.env.SHOPIFY_STORE_2_CLIENT_SECRET }
];

async function accessForUser(url, key, userId) {
  const response = await fetch(url + '/rest/v1/user_location_access?user_id=eq.' + userId + '&select=location_id,can_manage,locations(id,name,active)', { headers: jsonHeaders(key) });
  if (!response.ok) throw new Error('Location access lookup failed.');
  return (await response.json()).filter(entry => entry.locations?.active).map(entry => ({ id: Number(entry.locations.id), name: entry.locations.name, canManage: Boolean(entry.can_manage) }));
}

async function tokenFor(store) {
  const shop = clean(store.domain);
  if (!shop || !store.clientId || !store.clientSecret) throw new Error(store.label + ': Shopify connection is not configured.');
  const response = await fetch('https://' + shop + '/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(25000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) throw new Error(body.errors?.map(item => item.message).join('; ') || store.label + ': Shopify request failed.');
  return body.data;
}

async function postgrest(url, path, method, key, body, prefer) {
  const response = await fetch(url + '/rest/v1/' + path, {
    method,
    headers: { ...jsonHeaders(key), ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || result.hint || 'Could not update the Shopify transfer link.');
  return result;
}

async function loadLink(url, key, id) {
  const rows = await postgrest(url, 'shopify_transfer_links?select=*,shopify_transfer_link_lines(*)&id=eq.' + encodeURIComponent(id) + '&limit=1', 'GET', key);
  const link = rows[0];
  if (!link) throw new Error('Shopify transfer link not found.');
  if (link.route_type !== 'same_store' || !link.source_shopify_transfer_id) throw new Error('Only linked native Shopify transfers can use this workflow.');
  return link;
}

function storeFor(key) {
  const store = stores().find(item => item.key === key);
  if (!store) throw new Error('Shopify store mapping is unavailable.');
  return store;
}

function errorsFor(payload) {
  const errors = payload?.userErrors || [];
  if (errors.length) throw new Error(errors.map(item => item.message).join('; '));
}

const variantItemsQuery = `query TransferInventoryItems($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProductVariant { id inventoryItem { id } }
  }
}`;

const markReadyMutation = `mutation MarkTransferReady($id: ID!) {
  inventoryTransferMarkAsReadyToShip(id: $id) {
    inventoryTransfer { id name status }
    userErrors { field message }
  }
}`;

const createInTransitMutation = `mutation CreateInTransitShipment($input: InventoryShipmentCreateInput!, $idempotencyKey: String!) {
  inventoryShipmentCreateInTransit(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryShipment { id status }
    userErrors { field message code }
  }
}`;

const receiveShipmentMutation = `mutation ReceiveShipment($id: ID!, $idempotencyKey: String!) {
  inventoryShipmentReceive(id: $id, bulkReceiveAction: ACCEPTED) @idempotent(key: $idempotencyKey) {
    inventoryShipment { id status }
    userErrors { field message }
  }
}`;

async function ship(url, key, auth, link) {
  if (link.status !== 'draft') throw new Error('This Shopify transfer is already ' + link.status + '.');
  const store = storeFor(link.source_store_key);
  const lines = link.shopify_transfer_link_lines || [];
  if (!lines.length) throw new Error('This Shopify transfer has no linked SKU lines.');
  const variants = await graphql(store, variantItemsQuery, { ids: lines.map(line => line.source_shopify_variant_id) });
  const items = new Map((variants.nodes || []).filter(item => item?.id && item.inventoryItem?.id).map(item => [item.id, item.inventoryItem.id]));
  const shipmentLines = lines.map(line => {
    const inventoryItemId = items.get(line.source_shopify_variant_id);
    if (!inventoryItemId) throw new Error('Could not find Shopify inventory item for ' + line.sku + '.');
    if (!Number.isInteger(Number(line.quantity)) || Number(line.quantity) <= 0) throw new Error('Invalid quantity for ' + line.sku + '.');
    return { inventoryItemId, quantity: Number(line.quantity) };
  });

  const ready = await graphql(store, markReadyMutation, { id: link.source_shopify_transfer_id });
  errorsFor(ready.inventoryTransferMarkAsReadyToShip);
  const inTransit = await graphql(store, createInTransitMutation, {
    input: { movementId: link.source_shopify_transfer_id, lineItems: shipmentLines },
    idempotencyKey: crypto.randomUUID()
  });
  errorsFor(inTransit.inventoryShipmentCreateInTransit);
  const shipment = inTransit.inventoryShipmentCreateInTransit?.inventoryShipment;
  if (!shipment?.id) throw new Error('Shopify did not return an in-transit shipment.');

  await postgrest(url, 'shopify_transfer_links?id=eq.' + encodeURIComponent(link.id), 'PATCH', key, {
    status: 'shipped',
    shipped_at: new Date().toISOString(),
    metadata: { ...(link.metadata || {}), shopify_shipment_id: shipment.id, shopify_shipment_status: shipment.status, shipped_by: auth.user.display_name }
  });
  return { message: 'Transfer ' + link.bm_reference + ' is now in transit in Shopify.', status: 'shipped' };
}

async function receive(url, key, auth, link) {
  if (link.status !== 'shipped' && link.status !== 'partially_received') throw new Error('This Shopify transfer is not waiting to be received.');
  const shipmentId = link.metadata?.shopify_shipment_id;
  if (!shipmentId) throw new Error('The linked Shopify shipment ID is missing. Receive it in Shopify, then refresh this page.');
  const store = storeFor(link.destination_store_key);
  const data = await graphql(store, receiveShipmentMutation, { id: shipmentId, idempotencyKey: crypto.randomUUID() });
  errorsFor(data.inventoryShipmentReceive);
  await postgrest(url, 'shopify_transfer_links?id=eq.' + encodeURIComponent(link.id), 'PATCH', key, {
    status: 'completed',
    received_at: new Date().toISOString(),
    metadata: { ...(link.metadata || {}), shopify_receipt_status: data.inventoryShipmentReceive?.inventoryShipment?.status || 'RECEIVED', received_by: auth.user.display_name }
  });
  return { message: 'Transfer ' + link.bm_reference + ' was received into the destination in Shopify.', status: 'completed' };
}

module.exports = async function shopifyTransferLifecycle(req, res) {
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  const { url, serviceRoleKey } = configuration();

  try {
    const locations = await accessForUser(url, serviceRoleKey, auth.user.id);
    const managed = new Set(locations.filter(item => item.canManage).map(item => item.id));
    const isAdmin = TRANSFER_ADMIN_ROLES.has(auth.user.role);

    if (req.method === 'GET') {
      const links = await postgrest(url, 'shopify_transfer_links?select=id,bm_reference,status,source_location_id,destination_location_id,source_store_key,destination_store_key,created_at,metadata,shopify_transfer_link_lines(sku,quantity)&order=created_at.desc&limit=50', 'GET', serviceRoleKey);
      const visible = (Array.isArray(links) ? links : []).filter(link => isAdmin
        ? managed.has(Number(link.source_location_id)) || managed.has(Number(link.destination_location_id))
        : managed.has(Number(link.destination_location_id)));
      const names = new Map(locations.map(location => [location.id, location.name]));
      return res.json({
        ok: true,
        links: visible.map(link => ({ ...link, source_name: names.get(Number(link.source_location_id)) || '—', destination_name: names.get(Number(link.destination_location_id)) || '—' })),
        capabilities: { canShip: isAdmin, canReceive: managed.size > 0 }
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const action = req.body?.action;
    const linkId = String(req.body?.linkId || '');
    if (!linkId) return res.status(400).json({ ok: false, error: 'Shopify transfer link is required.' });
    const link = await loadLink(url, serviceRoleKey, linkId);

    if (action === 'ship') {
      if (!isAdmin || !managed.has(Number(link.source_location_id))) return res.status(403).json({ ok: false, error: 'Administrator manage access is required at the sending warehouse.' });
      return res.status(200).json({ ok: true, ...(await ship(url, serviceRoleKey, auth, link)) });
    }
    if (action === 'receive') {
      if (!managed.has(Number(link.destination_location_id))) return res.status(403).json({ ok: false, error: 'Manage access is required at the receiving warehouse.' });
      return res.status(200).json({ ok: true, ...(await receive(url, serviceRoleKey, auth, link)) });
    }
    return res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'shopify_transfer_lifecycle_failed' });
  }
};
