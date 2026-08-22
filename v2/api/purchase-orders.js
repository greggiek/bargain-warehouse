const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const PROCUREMENT_ROLES = new Set(['admin', 'developer']);

async function accessForUser(url, key, userId) {
  const response = await fetch(url + '/rest/v1/user_location_access?user_id=eq.' + encodeURIComponent(userId) + '&select=location_id,can_manage,locations(id,name,code,active)', { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('location access lookup failed');
  return (await response.json()).filter(row => row.locations?.active).map(row => ({ id: Number(row.location_id), name: row.locations.name, code: row.locations.code, canManage: Boolean(row.can_manage) }));
}
async function rpc(url, key, name, body) {
  const response = await fetch(url + '/rest/v1/rpc/' + name, { method: 'POST', headers: jsonHeaders(key), body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || name + ' failed');
  return data;
}
function integer(value) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : null; }

module.exports = async function purchaseOrders(req, res) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    const { url, serviceRoleKey } = configuration();
    const access = await accessForUser(url, serviceRoleKey, auth.user.id);
    const manageable = access.filter(location => location.canManage);
    const canManagePurchaseOrders = PROCUREMENT_ROLES.has(auth.user.role);
    const hub = access.find(location => location.code === '730' || location.name === '730 Windham Rd');
    const readableIds = (canManagePurchaseOrders ? access : manageable).map(location => location.id);

    if (req.method === 'GET' && req.query?.productSearch) {
      const term = String(req.query.productSearch).trim();
      if (term.length < 2) return res.status(200).json({ ok: true, products: [] });
      return res.status(200).json({ ok: true, products: await rpc(url, serviceRoleKey, 'search_v2_products', { p_term: term }) });
    }
    if (req.method === 'GET') {
      if (!readableIds.length) return res.status(200).json({ ok: true, orders: [], locations: [], capabilities: { canManagePurchaseOrders, canReceive: false } });
      const query = 'receiving_location_id=in.(' + readableIds.join(',') + ')&order=created_at.desc&limit=100&select=id,purchase_order_number,vendor_name,supplier_reference_number,status,notes,order_date,expected_date,shipping_cost,created_at,ordered_at,received_at,sent_at,receiving_location_id,locations(id,name,code),purchase_order_lines(id,product_id,ordered_quantity,received_quantity,notes,uom,unit_cost,products(sku,name,barcode))';
      const [orderResponse, vendorResponse] = await Promise.all([
        fetch(url + '/rest/v1/purchase_orders?' + query, { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(10000) }),
        canManagePurchaseOrders ? fetch(url + '/rest/v1/vendors?active=eq.true&order=name.asc&select=id,name,code', { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) }) : Promise.resolve(null)
      ]);
      const orders = await orderResponse.json().catch(() => []);
      if (!orderResponse.ok) throw new Error(orders.message || 'purchase order lookup failed');
      const vendors = vendorResponse ? await vendorResponse.json().catch(() => []) : [];
      if (vendorResponse && !vendorResponse.ok) throw new Error('vendor lookup failed');
      return res.status(200).json({ ok: true, orders, vendors, locations: access, hub: hub ? { id: hub.id, name: hub.name } : null, capabilities: { canManagePurchaseOrders, canReceive: manageable.length > 0 } });
    }

    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const body = req.body || {}, action = String(body.action || '');
    if (action === 'create') {
      if (!canManagePurchaseOrders) return res.status(403).json({ ok: false, error: 'Only an admin can create a purchase order.' });
      const receivingLocationId = integer(body.receivingLocationId) || hub?.id;
      if (!receivingLocationId || !access.some(location => location.id === receivingLocationId)) return res.status(400).json({ ok: false, error: 'Choose an accessible receiving location.' });
      const lines = (body.lines || []).map(line => ({ productId: integer(line.productId), quantity: Number(line.quantity), note: String(line.note || '') })).filter(line => line.productId && Number.isFinite(line.quantity) && line.quantity > 0);
      if (!lines.length) return res.status(400).json({ ok: false, error: 'Add at least one purchase item.' });
      const result = await rpc(url, serviceRoleKey, 'create_v2_purchase_order', { p_vendor_name: String(body.vendorName || ''), p_receiving_location_id: receivingLocationId, p_lines: lines, p_notes: String(body.notes || ''), p_idempotency_key: String(body.idempotencyKey || ''), p_user_id: auth.user.id, p_user_name: auth.user.display_name });
      return res.status(201).json({ ok: true, purchaseOrder: result });
    }
    if (action === 'create-detailed') {
      if (!canManagePurchaseOrders) return res.status(403).json({ ok: false, error: 'Only an admin can create a purchase order.' });
      const receivingLocationId = integer(body.receivingLocationId) || hub?.id;
      if (!receivingLocationId || !access.some(location => location.id === receivingLocationId)) return res.status(400).json({ ok: false, error: 'Choose an accessible receiving location.' });
      const lines = (body.lines || []).map(line => ({ productId: integer(line.productId), quantity: Number(line.quantity), note: String(line.note || ''), uom: String(line.uom || 'EA').trim().toUpperCase(), unitCost: Number(line.unitCost || 0) })).filter(line => line.productId && Number.isFinite(line.quantity) && line.quantity > 0 && Number.isFinite(line.unitCost) && line.unitCost >= 0);
      if (!lines.length) return res.status(400).json({ ok: false, error: 'Add at least one PO item with a quantity and non-negative unit cost.' });
      const result = await rpc(url, serviceRoleKey, 'create_v2_purchase_order_with_details', {
        p_purchase_order_number: String(body.purchaseOrderNumber || ''),
        p_vendor_name: String(body.vendorName || ''),
        p_supplier_reference_number: String(body.supplierReferenceNumber || ''),
        p_receiving_location_id: receivingLocationId,
        p_order_date: body.orderDate || null,
        p_expected_date: body.expectedDate || null,
        p_shipping_cost: Number(body.shippingCost || 0),
        p_lines: lines,
        p_notes: String(body.notes || ''),
        p_idempotency_key: String(body.idempotencyKey || ''),
        p_user_id: auth.user.id,
        p_user_name: auth.user.display_name
      });
      return res.status(201).json({ ok: true, purchaseOrder: result });
    }

    const purchaseOrderId = integer(body.purchaseOrderId);
    if (!purchaseOrderId) return res.status(400).json({ ok: false, error: 'Choose a purchase order.' });
    const lookupResponse = await fetch(url + '/rest/v1/purchase_orders?id=eq.' + purchaseOrderId + '&select=id,receiving_location_id,status', { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) });
    const lookup = await lookupResponse.json().catch(() => []);
    if (!lookupResponse.ok) throw new Error('purchase order lookup failed');
    const order = lookup[0];
    if (!order) return res.status(404).json({ ok: false, error: 'Purchase order not found.' });

    if (action === 'send') {
      if (!canManagePurchaseOrders) return res.status(403).json({ ok: false, error: 'Only an admin can send a purchase order.' });
      return res.status(200).json({ ok: true, purchaseOrder: await rpc(url, serviceRoleKey, 'send_v2_purchase_order', { p_purchase_order_id: purchaseOrderId, p_user_id: auth.user.id, p_user_name: auth.user.display_name }) });
    }
    if (action === 'update-detailed') {
      if (!canManagePurchaseOrders) return res.status(403).json({ ok: false, error: 'Only an admin can edit a purchase order.' });
      if (order.status !== 'draft') return res.status(400).json({ ok: false, error: 'Only a draft purchase order can be edited.' });
      const receivingLocationId = integer(body.receivingLocationId);
      if (!receivingLocationId || !access.some(location => location.id === receivingLocationId)) return res.status(400).json({ ok: false, error: 'Choose an accessible receiving location.' });
      const lines = (body.lines || []).map(line => ({ productId: integer(line.productId), quantity: Number(line.quantity), note: String(line.note || ''), uom: String(line.uom || 'EA').trim().toUpperCase(), unitCost: Number(line.unitCost || 0) })).filter(line => line.productId && Number.isFinite(line.quantity) && line.quantity > 0 && Number.isFinite(line.unitCost) && line.unitCost >= 0);
      if (!lines.length) return res.status(400).json({ ok: false, error: 'Add at least one PO item with a quantity and non-negative unit cost.' });
      return res.status(200).json({ ok: true, purchaseOrder: await rpc(url, serviceRoleKey, 'update_v2_purchase_order_with_details', {
        p_purchase_order_id: purchaseOrderId,
        p_vendor_name: String(body.vendorName || ''),
        p_supplier_reference_number: String(body.supplierReferenceNumber || ''),
        p_receiving_location_id: receivingLocationId,
        p_order_date: body.orderDate || null,
        p_expected_date: body.expectedDate || null,
        p_shipping_cost: Number(body.shippingCost || 0),
        p_lines: lines,
        p_notes: String(body.notes || ''),
        p_idempotency_key: String(body.idempotencyKey || ''),
        p_user_id: auth.user.id,
        p_user_name: auth.user.display_name
      }) });
    }
    if (action === 'receive-lines') {
      if (!manageable.some(entry => entry.id === Number(order.receiving_location_id))) return res.status(403).json({ ok: false, error: 'You need manager access to this PO receiving location.' });
      const lines = (body.lines || []).map(line => ({ lineId: integer(line.lineId), quantity: Number(line.quantity) })).filter(line => line.lineId && Number.isFinite(line.quantity) && line.quantity > 0);
      if (!lines.length) return res.status(400).json({ ok: false, error: 'Scan at least one expected PO item.' });
      return res.status(200).json({ ok: true, purchaseOrder: await rpc(url, serviceRoleKey, 'receive_v2_purchase_order_lines', { p_purchase_order_id: purchaseOrderId, p_lines: lines, p_idempotency_key: String(body.idempotencyKey || ''), p_user_id: auth.user.id, p_user_name: auth.user.display_name }) });
    }
    return res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'purchase_order_failed' });
  }
};
