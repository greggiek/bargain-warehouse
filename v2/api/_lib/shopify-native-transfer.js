const API_VERSION = '2026-07';

const clean = value => String(value || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');

const CREATE_NATIVE_TRANSFER_MUTATION = `mutation CreateNativeTransfer($input: InventoryTransferCreateInput!, $idempotencyKey: String!) {
  inventoryTransferCreate(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryTransfer { id name status referenceName }
    userErrors { field message }
  }
}`;

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
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) throw new Error(body.errors?.map(item => item.message).join('; ') || store.label + ': Shopify request failed');
  return body.data;
}

async function createShopifyNativeDraftTransfer({ store, input, idempotencyKey }) {
  const data = await graphql(store, CREATE_NATIVE_TRANSFER_MUTATION, { input, idempotencyKey });
  const payload = data.inventoryTransferCreate || {};
  if (payload.userErrors?.length) throw new Error(payload.userErrors.map(item => item.message).join('; '));
  if (!payload.inventoryTransfer?.id) throw new Error('Shopify did not return a transfer ID.');
  return payload.inventoryTransfer;
}

module.exports = { API_VERSION, graphql, createShopifyNativeDraftTransfer };
