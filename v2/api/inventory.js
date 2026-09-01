const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;

async function accessForUser(url, key, userId) {
  const response = await fetch(url + '/rest/v1/user_location_access?user_id=eq.' + encodeURIComponent(userId) + '&select=location_id,locations(id,name,active)', { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('location access lookup failed');
  return (await response.json()).filter(x => x.locations?.active).map(x => ({ id: Number(x.location_id), name: x.locations.name }));
}
async function balancesForLocation(url, key, location) {
  const balances = [];
  for (let offset = 0; offset < 20000; offset += 1000) {
    const response = await fetch(url + '/rest/v1/inventory_balances?location_id=eq.' + location.id + '&select=product_id,quantity,allocated_quantity,products(sku,name,category)&order=product_id.asc&limit=1000&offset=' + offset, { headers: jsonHeaders(key), signal: AbortSignal.timeout(10000) });
    const page = await response.json();
    if (!response.ok) throw new Error(page.message || 'V2 inventory lookup failed');
    balances.push(...page.map(x => ({ ...x, locationId: location.id })));
    if (page.length < 1000) break;
  }
  return balances;
}
module.exports = async function inventory(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ ok: false, error: 'method_not_allowed' }); }
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  try {
    const { url, serviceRoleKey } = configuration();
    const locations = await accessForUser(url, serviceRoleKey, auth.user.id);
    const requestedLocationId = Number(req.query?.locationId || 0);
    const selectedLocations = requestedLocationId ? locations.filter(x => x.id === requestedLocationId) : locations;
    if (!selectedLocations.length && locations.length) return res.status(403).json({ ok: false, error: 'You do not have access to that warehouse.' });
    const category = String(req.query?.category || '').trim().slice(0, 120);
    const search = String(req.query?.search || '').trim().toLowerCase().slice(0, 80);
    const balancePages = await Promise.all(selectedLocations.map(location => balancesForLocation(url, serviceRoleKey, location)));
    const normalized = balancePages.flat().map(balance => {
      const product = Array.isArray(balance.products) ? balance.products[0] : balance.products || {};
      return { productId: Number(balance.product_id), locationId: balance.locationId, sku: String(product.sku || '').trim() || '—', name: String(product.name || '').trim() || 'Unnamed product', category: String(product.category || 'Uncategorized'), onHand: number(balance.quantity), committed: number(balance.allocated_quantity), available: number(balance.quantity) - number(balance.allocated_quantity) };
    });
    const allCategoryRows = new Map();
    normalized.forEach(row => {
      const key = row.locationId + '|' + row.category;
      const entry = allCategoryRows.get(key) || { locationId: row.locationId, category: row.category, itemCount: 0, onHand: 0, committed: 0, available: 0 };
      entry.itemCount += 1; entry.onHand += row.onHand; entry.committed += row.committed; entry.available += row.available; allCategoryRows.set(key, entry);
    });
    const grouped = new Map();
    normalized.filter(row => (!category || row.category === category) && (!search || [row.sku,row.name,row.category].join(' ').toLowerCase().includes(search))).forEach(row => {
      const entry = grouped.get(row.productId) || { productId: row.productId, name: row.name, sku: row.sku, category: row.category, quantities: {}, inventory: {} };
      entry.quantities[row.locationId] = (entry.quantities[row.locationId] || 0) + row.onHand;
      const detail = entry.inventory[row.locationId] || { onHand: 0, committed: 0, available: 0 };
      detail.onHand += row.onHand; detail.committed += row.committed; detail.available += row.available; entry.inventory[row.locationId] = detail;
      grouped.set(row.productId, entry);
    });
    const rows = [...grouped.values()].sort((a,b) => a.name.localeCompare(b.name) || a.sku.localeCompare(b.sku)).slice(0, 2500);
    return res.status(200).json({ ok: true, locations: selectedLocations, allLocations: locations, locationId: requestedLocationId || null, category: category || null, rows, categories: [...allCategoryRows.values()].sort((a,b) => a.category.localeCompare(b.category)), generatedAt: new Date().toISOString() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'V2 inventory lookup failed' });
  }
};