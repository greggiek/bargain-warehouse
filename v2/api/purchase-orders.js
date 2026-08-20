const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

async function accessForUser(url, key, userId) {
  const response = await fetch(url + '/rest/v1/user_location_access?user_id=eq.' + encodeURIComponent(userId) + '&select=location_id,can_manage,locations(id,name,code,active)', { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('location access lookup failed');
  return (await response.json()).filter(row => row.locations?.active);
}
async function rpc(url, key, name, body) {
  const response = await fetch(url + '/rest/v1/rpc/' + name, { method: 'POST', headers: { ...jsonHeaders(key), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || name + ' failed');
  return data;
}

module.exports = async function purchaseOrders(req, res) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    const { url, serviceRoleKey } = configuration();
    const access = await accessForUser(url, serviceRoleKey, auth.user.id);
    const hub = access.find(row => row.locations?.code === '730' || row.locations?.name === '730 Windham Rd');
    if (!hub?.can_manage) return res.status(403).json({ ok: false, error: 'Manage access to 730 Windham Rd is required for purchasing.' });
    if (req.method === 'GET') {
      const response = await fetch(url + '/rest/v1/purchase_orders?receiving_location_id=eq.' + hub.location_id + '&order=created_at.desc&limit=25&select=id,purchase_order_number,vendor_name,status,notes,created_at,ordered_at,received_at,purchase_order_lines(id,ordered_quantity,received_quantity,products(sku,name))', { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) });
      const orders = await response.json();
      if (!response.ok) throw new Error(orders.message || 'purchase order lookup failed');
      return res.status(200).json({ ok: true, hub: { id: hub.location_id, name: hub.locations.name }, orders });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const body = req.body || {};
    if (body.action === 'create') {
      const lines = (body.lines || []).map(line => ({ productId: Number(line.productId), quantity: Number(line.quantity), note: String(line.note || '') })).filter(line => line.productId && line.quantity > 0);
      if (!lines.length) return res.status(400).json({ ok: false, error: 'Select at least one purchase item.' });
      const result = await rpc(url, serviceRoleKey, 'create_v2_purchase_order', { p_vendor_name: String(body.vendorName || ''), p_receiving_location_id: hub.location_id, p_lines: lines, p_notes: String(body.notes || ''), p_idempotency_key: String(body.idempotencyKey || ''), p_user_id: auth.user.id, p_user_name: auth.user.display_name });
      return res.status(201).json({ ok: true, purchaseOrder: result });
    }
    if (body.action === 'receive') {
      const purchaseOrderId = Number(body.purchaseOrderId);
      const lookup = await fetch(url + '/rest/v1/purchase_orders?id=eq.' + encodeURIComponent(purchaseOrderId) + '&receiving_location_id=eq.' + encodeURIComponent(hub.location_id) + '&select=id', { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) });
      const orders = await lookup.json().catch(() => []);
      if (!lookup.ok) throw new Error('purchase order lookup failed');
      if (!orders.length) return res.status(404).json({ ok: false, error: 'Purchase order not found at 730.' });
      const result = await rpc(url, serviceRoleKey, 'receive_v2_purchase_order', { p_purchase_order_id: purchaseOrderId, p_user_id: auth.user.id, p_user_name: auth.user.display_name });
      return res.status(200).json({ ok: true, purchaseOrder: result });
    }
    return res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'purchase_order_failed' });
  }
};
