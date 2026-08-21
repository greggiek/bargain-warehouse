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
const masterSelect = 'id,purchase_order_number,vendor_name,status,notes,created_at,ordered_at,received_at,receiving_location_id,locations(name,code),purchase_order_lines(id,product_id,ordered_quantity,received_quantity,damaged_quantity,notes,products(sku,name,barcode)),purchase_order_receipts(id,receipt_number,reference,notes,received_at,received_by_name,purchase_order_receipt_lines(id,purchase_order_line_id,received_quantity,damaged_quantity,notes))';
const canPurchase = auth => ['admin', 'developer'].includes(String(auth.user.role || '').toLowerCase());

module.exports = async function purchaseOrders(req, res) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    const { url, serviceRoleKey } = configuration();
    const managed = (await accessForUser(url, serviceRoleKey, auth.user.id)).filter(row => row.can_manage);
    if (!managed.length) return res.status(403).json({ ok: false, error: 'Manage access to a receiving warehouse is required.' });
    const hub = managed.find(row => row.locations?.code === '730' || row.locations?.name === '730 Windham Rd');
    const allowedLocationIds = managed.map(row => row.location_id).join(',');
    if (req.method === 'GET') {
      const id = Number(req.query?.id || 0);
      const query = id
        ? 'purchase_orders?id=eq.' + encodeURIComponent(id) + '&receiving_location_id=in.(' + allowedLocationIds + ')&select=' + encodeURIComponent(masterSelect)
        : 'purchase_orders?receiving_location_id=in.(' + allowedLocationIds + ')&order=created_at.desc&limit=100&select=' + encodeURIComponent(masterSelect);
      const response = await fetch(url + '/rest/v1/' + query, { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(10000) });
      const orders = await response.json();
      if (!response.ok) throw new Error(orders.message || 'purchase order lookup failed');
      return res.status(200).json({ ok: true, canPurchase: canPurchase(auth), hub: hub ? { id: hub.location_id, name: hub.locations.name } : null, orders });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const body = req.body || {};
    if (body.action === 'create') {
      if (!canPurchase(auth)) return res.status(403).json({ ok: false, error: 'Only purchasing administrators can create POs.' });
      if (!hub) return res.status(403).json({ ok: false, error: 'Manage access to 730 Windham Rd is required for procurement POs.' });
      const lines = (body.lines || []).map(line => ({ productId: Number(line.productId), quantity: Number(line.quantity), note: String(line.note || '') })).filter(line => line.productId && line.quantity > 0);
      if (!lines.length) return res.status(400).json({ ok: false, error: 'Select at least one purchase item.' });
      const result = await rpc(url, serviceRoleKey, 'create_v2_purchase_order', { p_vendor_name: String(body.vendorName || ''), p_receiving_location_id: Number(body.receivingLocationId) || hub.location_id, p_lines: lines, p_notes: String(body.notes || ''), p_idempotency_key: String(body.idempotencyKey || ''), p_user_id: auth.user.id, p_user_name: auth.user.display_name });
      return res.status(201).json({ ok: true, purchaseOrder: result });
    }
    const purchaseOrderId = Number(body.purchaseOrderId);
    const lookup = await fetch(url + '/rest/v1/purchase_orders?id=eq.' + encodeURIComponent(purchaseOrderId) + '&select=id,receiving_location_id,purchase_order_number,status', { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) });
    const orders = await lookup.json().catch(() => []);
    if (!lookup.ok) throw new Error('purchase order lookup failed');
    const order = orders[0];
    if (!order) return res.status(404).json({ ok: false, error: 'Purchase order not found.' });
    if (!managed.some(row => Number(row.location_id) === Number(order.receiving_location_id))) return res.status(403).json({ ok: false, error: 'You cannot receive into this warehouse.' });
    if (body.action === 'receive-lines') {
      const lines = (body.lines || []).map(line => ({ lineId: Number(line.lineId), receivedQuantity: Number(line.receivedQuantity || 0), damagedQuantity: Number(line.damagedQuantity || 0), note: String(line.note || '') })).filter(line => line.lineId && (line.receivedQuantity > 0 || line.damagedQuantity > 0));
      if (!lines.length) return res.status(400).json({ ok: false, error: 'Scan or enter at least one received line.' });
      const result = await rpc(url, serviceRoleKey, 'receive_v2_purchase_order_lines', { p_purchase_order_id: purchaseOrderId, p_lines: lines, p_reference: String(body.reference || ''), p_notes: String(body.notes || ''), p_idempotency_key: String(body.idempotencyKey || ''), p_user_id: auth.user.id, p_user_name: auth.user.display_name });
      return res.status(200).json({ ok: true, receipt: result });
    }
    if (body.action === 'mark-ordered') {
      if (!canPurchase(auth)) return res.status(403).json({ ok: false, error: 'Only purchasing administrators can send POs.' });
      const response = await fetch(url + '/rest/v1/purchase_orders?id=eq.' + purchaseOrderId + '&status=in.(draft,ordered)', { method: 'PATCH', headers: { ...jsonHeaders(serviceRoleKey), 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ status: 'ordered', ordered_at: new Date().toISOString(), updated_at: new Date().toISOString() }), signal: AbortSignal.timeout(8000) });
      const updated = await response.json(); if (!response.ok) throw new Error(updated.message || 'Could not mark PO ordered');
      return res.status(200).json({ ok: true, purchaseOrder: updated[0] });
    }
    return res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'purchase_order_failed' });
  }
};
