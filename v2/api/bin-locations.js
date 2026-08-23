const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const MANAGER_ROLES = new Set(['manager', 'admin', 'developer']);
const clean = (value, max = 240) => String(value || '').trim().slice(0, max);

async function managedLocations(url, key, userId) {
  const response = await fetch(url + '/rest/v1/user_location_access?user_id=eq.' + encodeURIComponent(userId) + '&select=location_id,can_manage,locations(id,name,active)', {
    headers: jsonHeaders(key), signal: AbortSignal.timeout(8000)
  });
  const rows = await response.json();
  if (!response.ok) throw Error(rows.message || 'location access lookup failed');
  return rows.filter(x => x.can_manage && x.locations?.active).map(x => ({ id: Number(x.location_id), name: x.locations.name }));
}
async function query(url, key, path) {
  const response = await fetch(url + '/rest/v1/' + path, { headers: jsonHeaders(key), signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) throw Error(data.message || 'bin location lookup failed');
  return data;
}
async function rpc(url, key, payload) {
  const response = await fetch(url + '/rest/v1/rpc/set_v2_inventory_bin_location', {
    method: 'POST',
    headers: { ...jsonHeaders(key), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.message || data.error || 'Could not save bin location');
  return data;
}

module.exports = async function binLocations(req, res) {
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  if (!MANAGER_ROLES.has(auth.user.role)) return res.status(403).json({ ok: false, error: 'warehouse_manager_access_required' });
  try {
    const { url, serviceRoleKey } = configuration();
    const locations = await managedLocations(url, serviceRoleKey, auth.user.id);
    if (!locations.length) return res.status(403).json({ ok: false, error: 'No managed warehouse location is assigned to you.' });
    const requested = Number(req.query?.locationId || req.body?.locationId || locations[0].id);
    if (!locations.some(location => location.id === requested)) return res.status(403).json({ ok: false, error: 'You can manage bins only at your assigned warehouse.' });

    if (req.method === 'GET') {
      const search = clean(req.query?.search, 80).toLowerCase();
      const [bins, balances] = await Promise.all([
        query(url, serviceRoleKey, 'inventory_bin_locations?location_id=eq.' + requested + '&select=id,product_id,bin_code,note,updated_at,updated_by_name,products(id,sku,name,category)&order=bin_code.asc&limit=5000'),
        query(url, serviceRoleKey, 'inventory_balances?location_id=eq.' + requested + '&select=product_id,quantity,products(id,sku,name,category)&limit=10000')
      ]);
      const needle = search.toLowerCase();
      const filtered = bins.filter(row => !needle || [row.bin_code, row.products?.sku, row.products?.name, row.products?.category].join(' ').toLowerCase().includes(needle));
      const products = [...new Map(balances.map(row => [Number(row.product_id), {
        id: Number(row.product_id), sku: row.products?.sku || '', name: row.products?.name || '', category: row.products?.category || '', quantity: Number(row.quantity || 0)
      }])).values()].sort((a, b) => a.sku.localeCompare(b.sku));
      return res.json({ ok: true, locations, locationId: requested, bins: filtered, products });
    }

    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ ok: false, error: 'method_not_allowed' }); }
    const body = req.body || {};
    const productId = Number(body.productId);
    const binCode = clean(body.binCode, 80);
    if (!Number.isInteger(productId) || !binCode) return res.status(400).json({ ok: false, error: 'Choose an item and enter its bin location.' });
    const productCheck = await query(url, serviceRoleKey, 'inventory_balances?location_id=eq.' + requested + '&product_id=eq.' + productId + '&select=product_id&limit=1');
    if (!productCheck.length) return res.status(400).json({ ok: false, error: 'That item is not in this warehouse inventory.' });
    const bin = await rpc(url, serviceRoleKey, {
      p_location_id: requested, p_product_id: productId, p_bin_code: binCode, p_note: clean(body.note, 500),
      p_user_id: auth.user.id, p_user_name: auth.user.display_name
    });
    return res.status(200).json({ ok: true, bin });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'bin_location_failed' });
  }
};