const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

async function access(url, key, userId) {
  const r = await fetch(url + '/rest/v1/user_location_access?user_id=eq.' + encodeURIComponent(userId) + '&select=location_id,can_manage,locations(id,name,active)', {
    headers: jsonHeaders(key), signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw Error('location access lookup failed');
  return (await r.json()).filter(x => x.locations?.active);
}
async function rows(url, key, path) {
  const r = await fetch(url + '/rest/v1/' + path, { headers: jsonHeaders(key), signal: AbortSignal.timeout(10000) });
  const data = await r.json();
  if (!r.ok) throw Error(data.message || 'dashboard lookup failed');
  return data;
}
module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ ok: false, error: 'method_not_allowed' }); }
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  try {
    const { url, serviceRoleKey: key } = configuration();
    const entries = await access(url, key, auth.user.id);
    const readable = entries.map(x => Number(x.location_id));
    const managed = entries.filter(x => x.can_manage).map(x => Number(x.location_id));
    if (!readable.length) return res.json({ ok: true, purchaseOrders: 0, transfers: 0, cycleReviews: 0, inventorySkus: 0, locations: [] });

    const ids = readable.join(',');
    const [poRows, transferRows, balanceRows, cycleRows] = await Promise.all([
      rows(url, key, 'purchase_orders?receiving_location_id=in.(' + ids + ')&status=in.(ordered,partially_received)&select=receiving_location_id'),
      rows(url, key, 'transfers?to_location_id=in.(' + ids + ')&status=in.(allocated,in_transit,partially_received)&select=to_location_id'),
      rows(url, key, 'inventory_balances?location_id=in.(' + ids + ')&select=location_id,product_id'),
      managed.length ? rows(url, key, 'cycle_count_lines?status=eq.variance&review_status=eq.pending&select=id,cycle_count_runs(location_id)') : Promise.resolve([])
    ]);
    const cycleReviews = cycleRows.filter(x => managed.includes(Number(x.cycle_count_runs?.location_id))).length;
    const byLocation = new Map(entries.map(x => [Number(x.location_id), {
      id: Number(x.location_id), name: x.locations.name, purchaseOrders: 0, transfers: 0, inventorySkus: 0
    }]));
    poRows.forEach(x => { const item = byLocation.get(Number(x.receiving_location_id)); if (item) item.purchaseOrders++; });
    transferRows.forEach(x => { const item = byLocation.get(Number(x.to_location_id)); if (item) item.transfers++; });
    balanceRows.forEach(x => { const item = byLocation.get(Number(x.location_id)); if (item) item.inventorySkus++; });

    return res.json({
      ok: true,
      purchaseOrders: poRows.length,
      transfers: transferRows.length,
      cycleReviews,
      inventorySkus: new Set(balanceRows.map(x => x.product_id)).size,
      locations: [...byLocation.values()],
      generatedAt: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'dashboard_status_failed' });
  }
};