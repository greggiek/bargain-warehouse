const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

module.exports = async (req, res) => {
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  const { url, serviceRoleKey } = configuration();

  try {
    const accessResponse = await fetch(
      url + '/rest/v1/user_location_access?user_id=eq.' + auth.user.id + '&select=location_id,can_manage,locations(id,name,active)',
      { headers: jsonHeaders(serviceRoleKey) }
    );
    const access = await accessResponse.json();
    const locations = (Array.isArray(access) ? access : [])
      .filter((entry) => entry.locations && entry.locations.active)
      .map((entry) => ({ id: entry.locations.id, name: entry.locations.name, canManage: entry.can_manage }));

    if (req.method === 'GET') return res.status(200).json({ ok: true, locations });
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const body = req.body || {};
    const sku = String(body.sku || '').trim();
    const quantity = Number(body.quantity);
    const fromLocationId = Number(body.fromLocationId);
    const toLocationId = Number(body.toLocationId);
    const source = locations.find((location) => location.id === fromLocationId);
    const destination = locations.find((location) => location.id === toLocationId);
    if (!source || !destination || !source.canManage) {
      return res.status(403).json({ ok: false, error: 'You need manage access to the source and access to the destination location.' });
    }
    if (!sku || !Number.isFinite(quantity) || quantity <= 0 || fromLocationId === toLocationId) {
      return res.status(400).json({ ok: false, error: 'Choose two locations, an exact SKU, and a positive quantity.' });
    }

    const productResponse = await fetch(url + '/rest/v1/products?select=id,sku&sku=ilike.' + encodeURIComponent(sku) + '&limit=2', {
      headers: jsonHeaders(serviceRoleKey)
    });
    const products = await productResponse.json();
    const matches = (Array.isArray(products) ? products : []).filter((product) =>
      String(product.sku || '').trim().toUpperCase() === sku.toUpperCase()
    );
    if (matches.length !== 1) return res.status(400).json({ ok: false, error: 'SKU must match exactly one V2 product.' });

    const response = await fetch(url + '/rest/v1/rpc/create_v2_transfer', {
      method: 'POST',
      headers: jsonHeaders(serviceRoleKey),
      body: JSON.stringify({ p_from: fromLocationId, p_to: toLocationId, p_lines: [{ productId: matches[0].id, quantity },], p_user: auth.user.id, p_name: auth.user.display_name })
    });
    const result = await response.json();
    if (!response.ok) return res.status(response.status).json({ ok: false, error: result.message || 'Transfer allocation failed.' });
    return res.status(201).json({ ok: true, transfer: result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};
