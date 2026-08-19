const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

async function accessForUser(url, key, userId) {
  const response = await fetch(
    url + '/rest/v1/user_location_access?user_id=eq.' + encodeURIComponent(userId) + '&select=location_id,can_manage,locations(id,name,active)',
    { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) }
  );
  if (!response.ok) throw new Error('location access lookup failed');
  return (await response.json()).filter((entry) => entry.locations && entry.locations.active)
    .map((entry) => ({ id: entry.locations.id, name: entry.locations.name, canManage: entry.can_manage }));
}

module.exports = async function receipts(req, res) {
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const { url, serviceRoleKey } = configuration();
  try {
    const locations = await accessForUser(url, serviceRoleKey, auth.user.id);
    const productSearch = String(req.query?.productSearch || '').trim();
    if (req.method === 'GET' && productSearch) {
      if (productSearch.length < 2) return res.status(200).json({ ok: true, products: [] });
      const response = await fetch(url + '/rest/v1/rpc/search_v2_products', {
        method: 'POST',
        headers: jsonHeaders(serviceRoleKey),
        body: JSON.stringify({ p_term: productSearch })
      });
      const products = await response.json();
      if (!response.ok) return res.status(response.status).json({ ok: false, error: products.message || 'Product search failed.' });
      return res.status(200).json({ ok: true, products });
    }

    if (req.method === 'GET') {
      const response = await fetch(
        url + '/rest/v1/activity_events?select=id,document_number,description,user_name,created_at,metadata&document_type=eq.receipt&order=created_at.desc&limit=25',
        { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) }
      );
      const receipts = response.ok ? await response.json() : [];
      const permitted = new Set(locations.map((location) => location.id));
      return res.status(200).json({
        ok: true,
        locations: locations.filter((location) => location.canManage),
        receipts: receipts.filter((receipt) => permitted.has(Number(receipt.metadata?.locationId)))
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const body = req.body || {};
    const productId = Number(body.productId);
    const locationId = Number(body.locationId);
    const quantity = Number(body.quantity);
    const idempotencyKey = String(body.idempotencyKey || '').trim();
    const access = locations.find((location) => location.id === locationId);

    if (!access || !access.canManage) return res.status(403).json({ ok: false, error: 'You need manage access to this receiving location.' });
    if (!Number.isInteger(productId) || productId < 1 || !Number.isFinite(quantity) || quantity <= 0 || !idempotencyKey) {
      return res.status(400).json({ ok: false, error: 'Choose an item, location, positive quantity, and receipt key.' });
    }

    const response = await fetch(url + '/rest/v1/rpc/receive_v2_inventory', {
      method: 'POST',
      headers: jsonHeaders(serviceRoleKey),
      body: JSON.stringify({
        p_product_id: productId,
        p_location_id: locationId,
        p_quantity: quantity,
        p_reference: String(body.reference || '').trim(),
        p_note: String(body.note || '').trim(),
        p_idempotency_key: idempotencyKey,
        p_user_id: auth.user.id,
        p_user_name: auth.user.display_name
      })
    });
    const result = await response.json();
    if (!response.ok) return res.status(response.status).json({ ok: false, error: result.message || 'Receiving failed.' });
    return res.status(201).json({ ok: true, receipt: result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};
