const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

async function access(url, key, userId) {
  const response = await fetch(url + '/rest/v1/user_location_access?user_id=eq.' + encodeURIComponent(userId) + '&select=location_id,can_manage,locations(id,name,active)', { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Error('location access lookup failed');
  return (await response.json()).filter(row => row.locations?.active);
}
async function rows(url, key, path) {
  const response = await fetch(url + '/rest/v1/' + path, { headers: jsonHeaders(key), signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) throw Error(data.message || 'dashboard lookup failed');
  return data;
}
module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ ok: false, error: 'method_not_allowed' }); }
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  try {
    const { url, serviceRoleKey: key } = configuration();
    const entries = await access(url, key, auth.user.id);
    const managed = entries.filter(row => row.can_manage);
    const selected = managed[0] || entries[0];
    if (!selected) return res.json({ ok: true, purchaseOrders: 0, transfers: 0, cycleReviews: 0, inventorySkus: 0, location: null });
    const locationId = Number(selected.location_id);
    const [poRows, transferRows, balanceRows, cycleRows] = await Promise.all([
      rows(url, key, 'purchase_orders?receiving_location_id=eq.' + locationId + '&status=in.(ordered,partially_received)&select=id'),
      rows(url, key, 'transfers?to_location_id=eq.' + locationId + '&status=in.(allocated,in_transit,partially_received)&select=id'),
      rows(url, key, 'inventory_balances?location_id=eq.' + locationId + '&select=product_id'),
      selected.can_manage ? rows(url, key, 'cycle_count_lines?status=eq.variance&review_status=eq.pending&select=id,cycle_count_runs(location_id)') : Promise.resolve([])
    ]);
    return res.json({
      ok: true,
      location: { id: locationId, name: selected.locations.name },
      purchaseOrders: poRows.length,
      transfers: transferRows.length,
      cycleReviews: cycleRows.filter(row => Number(row.cycle_count_runs?.location_id) === locationId).length,
      inventorySkus: new Set(balanceRows.map(row => row.product_id)).size,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'dashboard_status_failed' });
  }
};