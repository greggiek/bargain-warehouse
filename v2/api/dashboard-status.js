const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');
const VIEW_ALL_ROLES = new Set(['admin', 'developer']);
async function access(url, key, userId, viewAll) {
  const endpoint = viewAll ? '/rest/v1/locations?active=eq.true&select=id,name,active&order=name.asc' : '/rest/v1/user_location_access?user_id=eq.' + encodeURIComponent(userId) + '&select=location_id,can_manage,locations(id,name,active)';
  const response = await fetch(url + endpoint, { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Error('location access lookup failed');
  const data = await response.json();
  return viewAll ? data.map(x => ({ id: Number(x.id), name: x.name, canManage: true })) : data.filter(x => x.locations?.active).map(x => ({ id: Number(x.location_id), name: x.locations.name, canManage: Boolean(x.can_manage) }));
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
    const canViewAll = VIEW_ALL_ROLES.has(auth.user.role);
    const locations = await access(url, key, auth.user.id, canViewAll);
    const requested = String(req.query?.locationId || '').trim();
    const defaultLocation = locations.find(x => x.canManage) || locations[0] || null;
    const chosen = requested === 'all' && canViewAll ? locations : locations.filter(x => x.id === Number(requested));
    const scope = chosen.length ? chosen : (defaultLocation ? [defaultLocation] : []);
    if (!scope.length) return res.json({ ok: true, purchaseOrders: 0, transfers: 0, cycleReviews: 0, inventorySkus: 0, location: null, locations, canViewAll });
    const ids = scope.map(x => x.id), idList = ids.join(',');
    const [poRows, transferRows, balanceRows, cycleRows] = await Promise.all([
      rows(url, key, 'purchase_orders?receiving_location_id=in.(' + idList + ')&status=in.(ordered,partially_received)&select=id'),
      rows(url, key, 'transfers?to_location_id=in.(' + idList + ')&status=in.(allocated,in_transit,partially_received)&select=id'),
      rows(url, key, 'inventory_balances?location_id=in.(' + idList + ')&select=product_id'),
      rows(url, key, 'cycle_count_lines?status=eq.variance&review_status=eq.pending&select=id,cycle_count_runs(location_id)')
    ]);
    const isAll = requested === 'all' && canViewAll;
    return res.json({ ok: true, location: isAll ? { id: 'all', name: 'All locations' } : { id: scope[0].id, name: scope[0].name }, locations, canViewAll, purchaseOrders: poRows.length, transfers: transferRows.length, cycleReviews: cycleRows.filter(x => ids.includes(Number(x.cycle_count_runs?.location_id))).length, inventorySkus: new Set(balanceRows.map(x => x.product_id)).size, generatedAt: new Date().toISOString() });
  } catch (error) { return res.status(500).json({ ok: false, error: error.message || 'dashboard_status_failed' }); }
};