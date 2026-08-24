const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

async function rest(url, key, path, options = {}) {
  const response = await fetch(url + '/rest/v1/' + path, {
    ...options,
    headers: { ...jsonHeaders(key), ...(options.headers || {}) },
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || 'Manufacturing lookup failed');
  return body;
}
const eq = value => encodeURIComponent('eq.' + String(value));

module.exports = async function manufacturingWorkOrders(req, res) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return res.status(auth.status).json({ ok:false, error:auth.error });
    const { url, serviceRoleKey } = configuration();
    if (req.method === 'GET') {
      const [triggers, workOrders] = await Promise.all([
        rest(url, serviceRoleKey, 'manufacturing_shopify_triggers?order=shopify_store_key,shopify_product_id&select=id,shopify_store_key,shopify_product_id,enabled,destination:locations!manufacturing_shopify_triggers_destination_location_id_fkey(id,name)'),
        rest(url, serviceRoleKey, 'manufacturing_shopify_work_order_events?order=received_at.desc&limit=50&select=id,shopify_store_key,shopify_order_name,shopify_order_id,shopify_line_item_id,sku,quantity,status,error,received_at,processed_at,production_work_order_id,production_work_orders(work_order_number,status,destination:locations!production_work_orders_destination_location_id_fkey(name)),product_boms(products!product_boms_finished_product_id_fkey(name))')
      ]);
      const locations = await rest(url, serviceRoleKey, 'user_location_access?user_id=' + eq(auth.user.id) + '&can_manage=eq.true&select=locations(id,name,active)');
      return res.status(200).json({
        ok:true,
        canConfigure: auth.user.role === 'admin',
        triggers,
        workOrders,
        locations: locations.map(x => x.locations).filter(x => x?.active && x.name !== '730 Windham Rd')
      });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok:false,error:'method_not_allowed' });
    if (auth.user.role !== 'admin') return res.status(403).json({ ok:false,error:'admin_required' });
    const body = req.body || {};
    if (body.action !== 'saveTrigger') return res.status(400).json({ ok:false,error:'unknown_action' });
    const productId = String(body.shopifyProductId || '').replace(/\D/g, '');
    const destinationLocationId = Number(body.destinationLocationId);
    if (!productId) return res.status(400).json({ ok:false,error:'Enter the Shopify product ID.' });
    if (!destinationLocationId) return res.status(400).json({ ok:false,error:'Choose the finished-goods destination.' });
    const rows = await rest(url, serviceRoleKey, 'manufacturing_shopify_triggers?on_conflict=shopify_store_key,shopify_product_id', {
      method:'POST',
      headers:{'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=representation'},
      body:JSON.stringify({
        shopify_store_key: String(body.storeKey || 'store_1'),
        shopify_product_id: productId,
        destination_location_id: destinationLocationId,
        enabled: body.enabled !== false,
        updated_at: new Date().toISOString()
      })
    });
    return res.status(200).json({ ok:true, trigger:rows[0] || null });
  } catch (error) {
    return res.status(400).json({ ok:false,error:error.message || 'manufacturing_work_orders_failed' });
  }
};
