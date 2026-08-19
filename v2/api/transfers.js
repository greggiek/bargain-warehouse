const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

async function accessForUser(url, key, userId) {
  const response = await fetch(
    url + '/rest/v1/user_location_access?user_id=eq.' + userId + '&select=location_id,can_manage,locations(id,name,active)',
    { headers: jsonHeaders(key) }
  );
  if (!response.ok) throw new Error('location access lookup failed');
  return (await response.json()).filter((entry) => entry.locations && entry.locations.active)
    .map((entry) => ({ id: entry.locations.id, name: entry.locations.name, canManage: entry.can_manage }));
}

module.exports = async (req, res) => {
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  const { url, serviceRoleKey } = configuration();

  try {
    const locations = await accessForUser(url, serviceRoleKey, auth.user.id);
    const productSearch = String(req.query?.productSearch || '').trim();
    if (req.method === 'GET' && productSearch) {
      const term = productSearch.trim();
      if (term.length < 2) return res.status(200).json({ ok: true, products: [] });
      const response = await fetch(url + '/rest/v1/rpc/search_v2_products', {
        method: 'POST',
        headers: jsonHeaders(serviceRoleKey),
        body: JSON.stringify({ p_term: term })
      });
      const products = await response.json();
      if (!response.ok) return res.status(response.status).json({ ok: false, error: products.message || 'Product search failed.' });
      return res.status(200).json({ ok: true, products });
    }
    if (req.method === 'GET') {
      const response = await fetch(
        url + '/rest/v1/transfers?select=id,transfer_number,status,from_location_id,to_location_id,created_at,from_location:locations!transfers_from_location_id_fkey(name),to_location:locations!transfers_to_location_id_fkey(name),transfer_lines(id,requested_quantity,allocated_quantity,shipped_quantity,received_quantity,damaged_quantity,missing_quantity,notes,products(sku,name))&order=created_at.desc&limit=50',
        { headers: jsonHeaders(serviceRoleKey) }
      );
      const transfers = await response.json();
      const allowed = new Set(locations.map((location) => location.id));
      return res.status(response.status).json({
        ok: response.ok, locations,
        transfers: (Array.isArray(transfers) ? transfers : []).filter((transfer) =>
          allowed.has(transfer.from_location_id) || allowed.has(transfer.to_location_id)
        )
      });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const body = req.body || {};
    const action = body.action || 'create';
    if (action === 'create') {
      const sku = String(body.sku || '').trim();
      const quantity = Number(body.quantity);
      const fromLocationId = Number(body.fromLocationId);
      const toLocationId = Number(body.toLocationId);
      const source = locations.find((location) => location.id === fromLocationId);
      const destination = locations.find((location) => location.id === toLocationId);
      if (!source || !destination || !source.canManage || !destination.canManage) {
        return res.status(403).json({ ok: false, error: 'You need manage access to both transfer locations.' });
      }
      if (!sku || !Number.isFinite(quantity) || quantity <= 0 || fromLocationId === toLocationId) {
        return res.status(400).json({ ok: false, error: 'Choose two locations, an exact SKU, and a positive quantity.' });
      }
      const productResponse = await fetch(url + '/rest/v1/products?select=id,sku&sku=ilike.' + encodeURIComponent(sku) + '&limit=2', { headers: jsonHeaders(serviceRoleKey) });
      const products = await productResponse.json();
      const matches = (Array.isArray(products) ? products : []).filter((product) =>
        String(product.sku || '').trim().toUpperCase() === sku.toUpperCase()
      );
      if (matches.length !== 1) return res.status(400).json({ ok: false, error: 'SKU must match exactly one V2 product.' });
      const response = await fetch(url + '/rest/v1/rpc/create_v2_transfer', {
        method: 'POST', headers: jsonHeaders(serviceRoleKey),
        body: JSON.stringify({ p_from: fromLocationId, p_to: toLocationId, p_lines: [{ productId: matches[0].id, quantity }], p_user: auth.user.id, p_name: auth.user.display_name })
      });
      const result = await response.json();
      if (!response.ok) return res.status(response.status).json({ ok: false, error: result.message || 'Transfer allocation failed.' });
      return res.status(201).json({ ok: true, transfer: result });
    }

    if (action !== 'ship' && action !== 'receive') return res.status(400).json({ ok: false, error: 'Unknown transfer action.' });
    const transferId = Number(body.transferId);
    if (!Number.isInteger(transferId) || transferId < 1) return res.status(400).json({ ok: false, error: 'A transfer is required.' });
    const transferResponse = await fetch(url + '/rest/v1/transfers?id=eq.' + transferId + '&select=id,from_location_id,to_location_id&limit=1', { headers: jsonHeaders(serviceRoleKey) });
    const records = await transferResponse.json();
    const transfer = records[0];
    if (!transfer) return res.status(404).json({ ok: false, error: 'Transfer not found.' });
    const requiredLocationId = action === 'ship' ? transfer.from_location_id : transfer.to_location_id;
    const access = locations.find((location) => location.id === requiredLocationId);
    if (!access || !access.canManage) return res.status(403).json({ ok: false, error: 'You need manage access to this transfer location.' });

    const receiptLines = Array.isArray(body.lines) ? body.lines : [];
    if (action === 'receive' && receiptLines.length === 0) {
      return res.status(400).json({ ok: false, error: 'Enter receipt quantities.' });
    }
    const response = await fetch(url + '/rest/v1/rpc/' + (action === 'ship' ? 'ship_v2_transfer' : 'receive_v2_transfer_details'), {
      method: 'POST', headers: jsonHeaders(serviceRoleKey),
      body: JSON.stringify(action === 'ship'
        ? { p_transfer_id: transferId, p_user_id: auth.user.id, p_user_name: auth.user.display_name }
        : { p_transfer_id: transferId, p_lines: receiptLines, p_user_id: auth.user.id, p_user_name: auth.user.display_name })
    });
    const result = await response.json();
    if (!response.ok) return res.status(response.status).json({ ok: false, error: result.message || 'Transfer action failed.' });
    return res.status(200).json({ ok: true, transfer: result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};
