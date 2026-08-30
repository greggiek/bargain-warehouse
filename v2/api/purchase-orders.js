const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const PROCUREMENT_ROLES = new Set(['admin', 'developer']);
const API_VERSION='2026-07';
const cleanDomain=value=>String(value||'').replace(/^https?:\/\//,'').replace(/\/+$/,'');
const stores=()=>[{key:'store_1',domain:process.env.SHOPIFY_STORE_1_DOMAIN,clientId:process.env.SHOPIFY_STORE_1_CLIENT_ID,clientSecret:process.env.SHOPIFY_STORE_1_CLIENT_SECRET},{key:'store_2',domain:process.env.SHOPIFY_STORE_2_DOMAIN,clientId:process.env.SHOPIFY_STORE_2_CLIENT_ID,clientSecret:process.env.SHOPIFY_STORE_2_CLIENT_SECRET}];
async function shopifyGraphql(store,query,variables){
 const shop=cleanDomain(store.domain);if(!shop||!store.clientId||!store.clientSecret)throw Error('Shopify connection is not configured.');
 const tokenResponse=await fetch('https://'+shop+'/admin/oauth/access_token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:store.clientId,client_secret:store.clientSecret}),signal:AbortSignal.timeout(20000)});
 const tokenBody=await tokenResponse.json().catch(()=>({}));if(!tokenResponse.ok||!tokenBody.access_token)throw Error('Shopify token request failed.');
 const response=await fetch('https://'+shop+'/admin/api/'+API_VERSION+'/graphql.json',{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':tokenBody.access_token},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(25000)});
 const body=await response.json().catch(()=>({}));if(!response.ok||body.errors?.length)throw Error(body.errors?.map(e=>e.message).join('; ')||'Shopify request failed.');return body.data;
}
async function postReceiptToShopify(url,key,order,lines,idempotencyKey){
 const mapResponse=await fetch(url+'/rest/v1/shopify_location_mappings?location_id=eq.'+order.receiving_location_id+'&select=store_key,shopify_location_id',{headers:jsonHeaders(key)});
 const mapping=(await mapResponse.json().catch(()=>[]))[0];if(!mapResponse.ok||!mapping)throw Error('This PO warehouse is not mapped to Shopify.');
 const store=stores().find(item=>item.key===mapping.store_key);if(!store)throw Error('Shopify store mapping is unavailable.');
 const detailResponse=await fetch(url+'/rest/v1/purchase_order_lines?purchase_order_id=eq.'+order.id+'&select=id,ordered_quantity,received_quantity,products(sku)',{headers:jsonHeaders(key)});
 const details=await detailResponse.json().catch(()=>[]);if(!detailResponse.ok)throw Error('Could not validate PO lines.');
 const changes=[];
 for(const input of lines){
  const line=details.find(item=>Number(item.id)===Number(input.lineId));
  if(!line||Number(input.quantity)<=0||Number(input.quantity)>Number(line.ordered_quantity)-Number(line.received_quantity))throw Error('Invalid receipt quantity.');
  const sku=String(line.products?.sku||'');
  const escapedSku=sku.replace(/["\\]/g,'\\$&');
  const result=await shopifyGraphql(store,`query($q:String!,$locationId:ID!){productVariants(first:5,query:$q){nodes{id sku inventoryItem{id inventoryLevel(locationId:$locationId){quantities(names:[\"available\"]){quantity}}}}}}`,{q:'sku:"'+escapedSku+'"',locationId:mapping.shopify_location_id});
  const variant=(result.productVariants?.nodes||[]).find(v=>String(v.sku||'').toLowerCase()===sku.toLowerCase());
  if(!variant?.inventoryItem?.id)throw Error('Shopify SKU lookup failed for '+sku+'.');
  const available=variant.inventoryItem.inventoryLevel?.quantities?.[0]?.quantity;if(!Number.isFinite(available))throw Error('Shopify could not read the current stock for '+sku+'.');changes.push({inventoryItemId:variant.inventoryItem.id,locationId:mapping.shopify_location_id,delta:Number(input.quantity),changeFromQuantity:available});
 }
 const result=await shopifyGraphql(store,`mutation($input:InventoryAdjustQuantitiesInput!,$key:String!){inventoryAdjustQuantities(input:$input) @idempotent(key:$key){inventoryAdjustmentGroup{id referenceDocumentUri} userErrors{message}}}`,{input:{reason:'correction',name:'available',referenceDocumentUri:'bmwarehouse://purchase-order/'+encodeURIComponent(order.purchase_order_number),changes},key:idempotencyKey});
 const payload=result.inventoryAdjustQuantities;if(payload?.userErrors?.length)throw Error(payload.userErrors.map(e=>e.message).join('; '));if(!payload?.inventoryAdjustmentGroup?.id)throw Error('Shopify did not confirm the PO receipt.');return payload.inventoryAdjustmentGroup.id;
}

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
      const query = 'receiving_location_id=in.(' + readableIds.join(',') + ')&order=created_at.desc&limit=100&select=id,purchase_order_number,vendor_name,supplier_reference_number,status,notes,order_date,expected_date,purchase_type,shipping_cost,created_at,ordered_at,received_at,sent_at,receiving_location_id,locations(id,name,code),purchase_order_lines(id,product_id,ordered_quantity,received_quantity,notes,uom,unit_cost,products(sku,name,variant_title,barcode,purchase_price,moving_average_cost))';
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
    // The original minimal create path is retired; the detailed PO workspace is the only create path.
    if (action === 'create') return res.status(410).json({
      ok: false,
      error: 'Legacy PO creation is retired. Use the detailed purchase-order workspace.'
    });
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
    const lookupResponse = await fetch(url + '/rest/v1/purchase_orders?id=eq.' + purchaseOrderId + '&select=id,purchase_order_number,receiving_location_id,status', { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) });
    const lookup = await lookupResponse.json().catch(() => []);
    if (!lookupResponse.ok) throw new Error('purchase order lookup failed');
    const order = lookup[0];
    if (!order) return res.status(404).json({ ok: false, error: 'Purchase order not found.' });

    if (action === 'set-purchase-type') {
      if (!canManagePurchaseOrders) return res.status(403).json({ ok: false, error: 'Only an admin can change a purchase type.' });
      const purchaseType = body.purchaseType === 'container_buy' ? 'container_buy' : 'local_buy';
      const update = await fetch(url + '/rest/v1/purchase_orders?id=eq.' + purchaseOrderId, { method: 'PATCH', headers: jsonHeaders(serviceRoleKey), body: JSON.stringify({ purchase_type: purchaseType }), signal: AbortSignal.timeout(8000) });
      if (!update.ok) throw new Error('Could not save the purchase type.');
      return res.status(200).json({ ok: true, purchaseOrder: { id: purchaseOrderId, purchaseOrderNumber: order.purchase_order_number, purchaseType } });
    }

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
    if (action === 'update-open-detailed') {
      if (!canManagePurchaseOrders) return res.status(403).json({ ok: false, error: 'Only an admin can edit a purchase order.' });
      if (!['ordered', 'partially_received'].includes(order.status)) return res.status(400).json({ ok: false, error: 'Only an open purchase order can be edited.' });
      const receivingLocationId = integer(body.receivingLocationId);
      if (!receivingLocationId || !access.some(location => location.id === receivingLocationId)) return res.status(400).json({ ok: false, error: 'Choose an accessible receiving location.' });
      const lines = (body.lines || []).map(line => ({ productId: integer(line.productId), quantity: Number(line.quantity), note: String(line.note || ''), uom: String(line.uom || 'EA').trim().toUpperCase(), unitCost: Number(line.unitCost || 0) })).filter(line => line.productId && Number.isFinite(line.quantity) && line.quantity > 0 && Number.isFinite(line.unitCost) && line.unitCost >= 0);
      if (!lines.length) return res.status(400).json({ ok: false, error: 'Add at least one PO item with a quantity and non-negative unit cost.' });
      return res.status(200).json({ ok: true, purchaseOrder: await rpc(url, serviceRoleKey, 'update_v2_open_purchase_order_with_details', {
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
    if (action === 'delete') {
      if (!canManagePurchaseOrders) return res.status(403).json({ ok: false, error: 'Only an admin can delete a purchase order.' });
      return res.status(200).json({ ok: true, result: await rpc(url, serviceRoleKey, 'delete_v2_purchase_order', {
        p_purchase_order_id: purchaseOrderId, p_user_id: auth.user.id, p_user_name: auth.user.display_name
      }) });
    }
    if (action === 'receive-lines') {
      if (!manageable.some(entry => entry.id === Number(order.receiving_location_id))) return res.status(403).json({ ok: false, error: 'You need manager access to this PO receiving location.' });
      const lines = (body.lines || []).map(line => ({ lineId: integer(line.lineId), quantity: Number(line.quantity) })).filter(line => line.lineId && Number.isFinite(line.quantity) && line.quantity > 0);
      if (!lines.length) return res.status(400).json({ ok: false, error: 'Scan at least one expected PO item.' });
      // The server owns the durable receipt key. If the browser or Wi-Fi drops,
      // submitting the same PO lines resumes this attempt instead of adding stock again.
      const attempt=await rpc(url,serviceRoleKey,'begin_v2_purchase_order_receipt',{
        p_purchase_order_id:purchaseOrderId,
        p_receiving_location_id:Number(order.receiving_location_id),
        p_lines:lines,
        // Receipt-attempt audit stores the Supabase Auth UUID when one exists.
        // BM OS sessions use the numeric app_users ID, which belongs to the
        // inventory ledger calls below and must not be sent to this UUID field.
        p_user_id:auth.authUser?.id || null,
        p_user_name:auth.user.display_name
      });
      let shopifyAdjustmentId=attempt.shopifyAdjustmentId;
      if(!shopifyAdjustmentId){
        shopifyAdjustmentId=await postReceiptToShopify(url,serviceRoleKey,order,lines,attempt.idempotencyKey);
        await rpc(url,serviceRoleKey,'confirm_v2_purchase_order_receipt_shopify',{
          p_attempt_id:attempt.attemptId,
          p_shopify_adjustment_id:shopifyAdjustmentId
        });
      }
      const purchaseOrder=await rpc(url,serviceRoleKey,'receive_v2_purchase_order_lines',{
        p_purchase_order_id:purchaseOrderId,
        p_lines:lines,
        p_idempotency_key:attempt.idempotencyKey,
        p_user_id:auth.user.id,
        p_user_name:auth.user.display_name
      });
      await rpc(url,serviceRoleKey,'complete_v2_purchase_order_receipt',{p_attempt_id:attempt.attemptId});
      const notificationKey = 'po-receipt:' + attempt.attemptId;
      const notificationPayload = { purchaseOrderNumber: order.purchase_order_number, vendorName: order.vendor_name, receivedAt: new Date().toISOString(), receivedBy: auth.user.display_name, lines };
      const existingNoticeResponse = await fetch(url + '/rest/v1/purchase_order_accounting_notifications?idempotency_key=eq.' + encodeURIComponent(notificationKey) + '&select=id,status', { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) });
      const existingNotice = (await existingNoticeResponse.json().catch(() => []))[0];
      let accountingNotification = existingNotice?.status || 'pending_configuration';
      if (existingNotice?.status !== 'sent' && process.env.RESEND_API_KEY) {
        const linesText = lines.map(line => '<li>Line ' + line.lineId + ': ' + line.quantity + '</li>').join('');
        const emailResponse = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.PO_ACCOUNTING_FROM_EMAIL || 'BM Warehouse <warehouse@bargainmoulding.com>', to: ['accounting@bargainmoulding.com'], subject: 'PO received: ' + order.purchase_order_number, html: '<h2>Purchase order received</h2><p><strong>PO:</strong> ' + order.purchase_order_number + '</p><p><strong>Received by:</strong> ' + auth.user.display_name + '</p><ul>' + linesText + '</ul>' }), signal: AbortSignal.timeout(15000) });
        const emailData = await emailResponse.json().catch(() => ({}));
        accountingNotification = emailResponse.ok ? 'sent' : 'failed';
        await fetch(url + '/rest/v1/purchase_order_accounting_notifications?on_conflict=idempotency_key', { method: 'POST', headers: { ...jsonHeaders(serviceRoleKey), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ purchase_order_id: purchaseOrderId, receipt_attempt_id: attempt.attemptId, idempotency_key: notificationKey, status: accountingNotification, provider_message_id: emailData.id || null, error: emailResponse.ok ? null : (emailData.message || 'Resend delivery failed'), payload: notificationPayload, sent_at: emailResponse.ok ? new Date().toISOString() : null }), signal: AbortSignal.timeout(8000) });
      } else if (!existingNotice) {
        await fetch(url + '/rest/v1/purchase_order_accounting_notifications?on_conflict=idempotency_key', { method: 'POST', headers: { ...jsonHeaders(serviceRoleKey), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ purchase_order_id: purchaseOrderId, receipt_attempt_id: attempt.attemptId, idempotency_key: notificationKey, status: 'pending_configuration', payload: notificationPayload }), signal: AbortSignal.timeout(8000) });
      }
      return res.status(200).json({ok:true,purchaseOrder,shopifyAdjustmentId,receiptResumed:Boolean(attempt.reused),accountingNotification});
    }
    return res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'purchase_order_failed' });
  }
};
