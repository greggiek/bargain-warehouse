const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const MANAGER_ROLES = new Set(['manager', 'admin', 'developer']);
const validSorts = new Set(['created_at', 'sku', 'location', 'reason', 'quantity_delta', 'performed_by_name']);

async function accessForUser(url, key, userId) {
  const response = await fetch(url + '/rest/v1/user_location_access?user_id=eq.' + encodeURIComponent(userId) + '&select=location_id,can_manage,locations(id,name,active)', { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Error('location access lookup failed');
  return (await response.json()).filter(entry => entry.locations?.active && entry.can_manage).map(entry => ({ id: Number(entry.location_id), name: entry.locations.name }));
}
async function rpc(url, key, name, payload) {
  const response = await fetch(url + '/rest/v1/rpc/' + name, { method:'POST', headers:{...jsonHeaders(key),'Content-Type':'application/json'}, body:JSON.stringify(payload), signal:AbortSignal.timeout(10000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.message || data.error || 'Inventory adjustment failed');
  return data;
}
function clean(value, max=180) { return String(value || '').trim().slice(0, max); }

module.exports = async function inventoryAdjustments(req, res) {
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ok:false,error:auth.error});
  if (!MANAGER_ROLES.has(auth.user.role)) return res.status(403).json({ok:false,error:'warehouse_manager_access_required'});
  const { url, serviceRoleKey } = configuration();
  try {
    const locations = await accessForUser(url, serviceRoleKey, auth.user.id);
    if (!locations.length) return res.status(403).json({ok:false,error:'No managed warehouse location is assigned to you.'});
    const locationId = Number(req.query?.locationId || req.body?.locationId || locations[0].id);
    if (!locations.some(location => location.id === locationId)) return res.status(403).json({ok:false,error:'You can adjust only inventory at your assigned warehouse.'});

    if (req.method === 'GET') {
      const search = clean(req.query?.search, 80);
      const sort = validSorts.has(req.query?.sort) ? req.query.sort : 'created_at';
      const direction = req.query?.direction === 'asc' ? 'asc' : 'desc';
      const balanceResponse = await fetch(
        url + '/rest/v1/inventory_balances?location_id=eq.' + locationId + '&quantity=neq.0&select=product_id,quantity,allocated_quantity,products(id,sku,name)&order=quantity.desc&limit=250',
        {headers:jsonHeaders(serviceRoleKey),signal:AbortSignal.timeout(8000)}
      );
      const balances = await balanceResponse.json();
      if (!balanceResponse.ok) throw Error(balances.message || 'Could not load warehouse inventory');
      const needle = search.toLowerCase();
      const products = balances.filter(row => !needle || [row.products?.sku,row.products?.name].join(' ').toLowerCase().includes(needle))
        .map(row => ({id:row.product_id,sku:row.products?.sku || '',name:row.products?.name || '',quantity:Number(row.quantity),allocatedQuantity:Number(row.allocated_quantity)}));

      let order = 'created_at.desc';
      if (sort === 'quantity_delta') order = 'quantity_delta.' + direction;
      const ledgerResponse = await fetch(
        url + '/rest/v1/inventory_movements?location_id=eq.' + locationId + '&movement_type=in.(damage,adjustment)&reference_type=eq.inventory_adjustment&select=id,created_at,movement_type,quantity_delta,quantity_before,quantity_after,reason,performed_by_name,metadata,products(sku,name),locations(name)&order=' + encodeURIComponent(order) + '&limit=250',
        {headers:jsonHeaders(serviceRoleKey),signal:AbortSignal.timeout(8000)}
      );
      const ledger = await ledgerResponse.json();
      if (!ledgerResponse.ok) throw Error(ledger.message || 'Could not load adjustment ledger');
      const sorted = sort === 'created_at' || sort === 'quantity_delta' ? ledger : ledger.sort((a,b) => {
        const value = row => sort === 'sku' ? row.products?.sku : sort === 'location' ? row.locations?.name : sort === 'reason' ? row.metadata?.adjustmentReason : row.performed_by_name;
        return String(value(a) || '').localeCompare(String(value(b) || '')) * (direction === 'asc' ? 1 : -1);
      });
      return res.json({ok:true,locations,locationId,products,ledger:sorted});
    }

    if (req.method !== 'POST') { res.setHeader('Allow','GET, POST'); return res.status(405).json({ok:false,error:'method_not_allowed'}); }
    const body = req.body || {};
    const productId = Number(body.productId), quantity = Number(body.quantity);
    const reason = clean(body.reason, 40), note = clean(body.note, 500);
    if (!Number.isInteger(productId) || !Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ok:false,error:'Choose an item and enter a quantity greater than zero.'});
    if (!['damage','missing_stock'].includes(reason)) return res.status(400).json({ok:false,error:'Choose Damaged or Missing stock.'});
    const result = await rpc(url, serviceRoleKey, 'adjust_v2_inventory', {
      p_product_id:productId,p_location_id:locationId,p_quantity:quantity,p_reason:reason,p_note:note,
      p_idempotency_key:clean(body.idempotencyKey,120),p_user_id:auth.user.id,p_user_name:auth.user.display_name
    });
    return res.status(200).json({ok:true,adjustment:result});
  } catch (error) { return res.status(500).json({ok:false,error:error.message || 'inventory_adjustment_failed'}); }
};
