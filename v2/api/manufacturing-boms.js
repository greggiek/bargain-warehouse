const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

async function accessForUser(url, key, userId) {
  const response = await fetch(url + '/rest/v1/user_location_access?user_id=eq.' + encodeURIComponent(userId) + '&select=location_id,can_manage,locations(id,name,active)', { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('location access lookup failed');
  return response.json();
}
async function rpc(url, key, name, body) {
  const response = await fetch(url + '/rest/v1/rpc/' + name, { method: 'POST', headers: { ...jsonHeaders(key), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || name + ' failed');
  return data;
}
module.exports = async (req, res) => {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const { url: supabaseUrl, serviceRoleKey } = configuration();
    const access = (await accessForUser(supabaseUrl, serviceRoleKey, auth.user.id)).filter(row => row.locations?.active);
    const allowed = new Map(access.map(row => [Number(row.location_id), Boolean(row.can_manage)]));
    if (req.method === 'GET') {
      const term = String(req.query?.term || '').trim();
      if (term) return res.status(200).json(await rpc(supabaseUrl, serviceRoleKey, 'search_v2_products', { p_term: term }));
      if (String(req.query?.bomManagement || '') === '1') {
        const [goodResponse, needsSetupResponse] = await Promise.all([
          fetch(supabaseUrl + '/rest/v1/product_boms?active=eq.true&order=updated_at.desc&select=id,yield_quantity,notes,updated_at,products!product_boms_finished_product_id_fkey(id,sku,name)', { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) }),
          fetch(supabaseUrl + '/rest/v1/v1_door_bom_sources?match_status=eq.unmatched&order=finished_sku&select=finished_sku,finished_name,components,missing_skus,updated_at', { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) })
        ]);
        const [good, needsSetup] = await Promise.all([goodResponse.json(), needsSetupResponse.json()]);
        if (!goodResponse.ok) throw new Error(good.message || 'BOM management lookup failed');
        if (!needsSetupResponse.ok) throw new Error(needsSetup.message || 'V1 BOM issue lookup failed');
        return res.status(200).json({ good, needsSetup });
      }
      const templateSku = String(req.query?.bomManagementTemplateSku || '').trim();
      if (templateSku) {
        const sourceResponse = await fetch(supabaseUrl + '/rest/v1/v1_door_bom_sources?finished_sku=eq.' + encodeURIComponent(templateSku) + '&select=finished_sku,finished_name,components,missing_skus&limit=1', { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) });
        const sourceRows = await sourceResponse.json(); if (!sourceResponse.ok) throw new Error(sourceRows.message || 'V1 BOM template lookup failed');
        const source = sourceRows[0]; if (!source) return res.status(404).json({ error: 'v1_bom_template_not_found' });
        const skus = (source.components || []).map(component => String(component.sku || '').trim()).filter(Boolean);
        const quoted = skus.map(sku => '"' + sku.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',');
        const productsResponse = quoted
          ? await fetch(supabaseUrl + '/rest/v1/products?active=eq.true&sku=in.(' + encodeURIComponent(quoted) + ')&select=id,sku,name', { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) })
          : null;
        const products = productsResponse ? await productsResponse.json() : [];
        if (productsResponse && !productsResponse.ok) throw new Error(products.message || 'V1 BOM component lookup failed');
        const bySku = new Map(products.map(product => [String(product.sku).trim().toUpperCase(), product]));
        return res.status(200).json({ template: source, components: (source.components || []).map(component => ({ sku: component.sku, quantity: component.quantity, product: bySku.get(String(component.sku || '').trim().toUpperCase()) || null })) });
      }
      const finishedId = Number(req.query?.bomForProductId);
      const locationId = Number(req.query?.locationId);
      if (finishedId) {
        const q = new URLSearchParams({ finished_product_id: 'eq.' + finishedId, active: 'eq.true', select: 'id,yield_quantity,notes,products!product_boms_finished_product_id_fkey(id,sku,name),product_bom_components(id,component_product_id,quantity_per_yield,products(id,sku,name))', limit: '1' });
        const response = await fetch(supabaseUrl + '/rest/v1/product_boms?' + q, { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) });
        const rows = await response.json(); if (!response.ok) throw new Error(rows.message || 'BOM lookup failed');
        const bom = rows[0] || null;
        if (bom && locationId && allowed.has(locationId)) {
          const ids = (bom.product_bom_components || []).map(c => c.component_product_id).join(',');
          if (ids) {
            const b = await fetch(supabaseUrl + '/rest/v1/inventory_balances?location_id=eq.' + locationId + '&product_id=in.(' + ids + ')&select=product_id,quantity,allocated_quantity', { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) });
            const balances = await b.json(); if (!b.ok) throw new Error('balance lookup failed');
            const map = new Map(balances.map(x => [Number(x.product_id), x]));
            bom.product_bom_components.forEach(c => { c.balance = map.get(Number(c.component_product_id)) || { quantity: 0, allocated_quantity: 0 }; });
          }
        }
        return res.status(200).json({ bom, locations: access.map(x => ({ id:x.location_id,name:x.locations.name,canManage:x.can_manage })) });
      }
      return res.status(400).json({ error: 'bom_query_required' });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    const body = req.body || {}; const action = body.action;
    if (action === 'saveBom') {
      if (auth.user.role !== 'admin') return res.status(403).json({ error: 'admin_required_for_bom_changes' });
      const data = await rpc(supabaseUrl, serviceRoleKey, 'save_v2_product_bom', { p_finished_product_id:Number(body.finishedProductId), p_yield_quantity:Number(body.yieldQuantity), p_components:(body.components || []).map(x => ({ productId: x.component_product_id, quantity: x.quantity_per_yield })), p_notes:String(body.notes || ''), p_user_id:auth.user.id, p_user_name:auth.user.display_name });
      const sourceSku = String(body.sourceSku || '').trim();
      if (sourceSku) {
        const sourceUpdate = await fetch(supabaseUrl + '/rest/v1/v1_door_bom_sources?finished_sku=eq.' + encodeURIComponent(sourceSku), {
          method: 'PATCH',
          headers: { ...jsonHeaders(serviceRoleKey), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ match_status: 'matched', v2_finished_product_id: Number(body.finishedProductId), missing_skus: [], updated_at: new Date().toISOString() }),
          signal: AbortSignal.timeout(8000)
        });
        if (!sourceUpdate.ok) throw new Error('BOM saved, but the V1 source mapping could not be updated');
      }
      return res.status(200).json(data);
    }
    return res.status(400).json({ error: 'unknown_action' });
  } catch (error) { return res.status(400).json({ error: error.message || 'manufacturing_bom_failed' }); }
};
