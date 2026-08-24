const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

async function accessForUser(url, key, userId) {
  const response = await fetch(
    url + '/rest/v1/user_location_access?user_id=eq.' + encodeURIComponent(userId) + '&select=location_id,locations(id,name,active)',
    { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) }
  );
  if (!response.ok) throw new Error('location access lookup failed');
  return (await response.json())
    .filter(entry => entry.locations?.active)
    .map(entry => ({ id: Number(entry.location_id), name: entry.locations.name }));
}

async function balancesForLocation(url, key, location) {
  const balances = [];
  for (let offset = 0; offset < 20000; offset += 1000) {
    const response = await fetch(
      url + '/rest/v1/inventory_balances?location_id=eq.' + location.id +
      '&select=product_id,quantity,allocated_quantity,products(sku,name,category)&order=product_id.asc&limit=1000&offset=' + offset,
      { headers: jsonHeaders(key), signal: AbortSignal.timeout(10000) }
    );
    const page = await response.json();
    if (!response.ok) throw new Error(page.message || 'V2 inventory lookup failed');
    balances.push(...page.map(balance => ({ ...balance, locationId: location.id, location: location.name })));
    if (page.length < 1000) break;
  }
  return balances;
}

module.exports = async function inventory(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const { url, serviceRoleKey } = configuration();
    const locations = await accessForUser(url, serviceRoleKey, auth.user.id);
    if (!locations.length) return res.status(200).json({ ok: true, mode: 'overview', locations: [], warehouses: [], rows: [], summary: {}, generatedAt: new Date().toISOString() });

    const search = String(req.query?.search || '').trim().toLowerCase().slice(0, 80);
    const requestedLocationId = Number(req.query?.locationId || 0);
    const selectedLocations = requestedLocationId
      ? locations.filter(location => location.id === requestedLocationId)
      : locations;
    if (!selectedLocations.length) return res.status(403).json({ ok: false, error: 'You do not have access to that warehouse.' });

    const balancePages = await Promise.all(selectedLocations.map(location => balancesForLocation(url, serviceRoleKey, location)));
    const balances = balancePages.flat();
    const normalized = balances.map(balance => {
      const product = Array.isArray(balance.products) ? balance.products[0] : balance.products || {};
      return {
        productId: Number(balance.product_id), locationId: balance.locationId, location: balance.location,
        sku: String(product.sku || '').trim(), name: String(product.name || ''), category: String(product.category || 'Uncategorized'),
        onHand: number(balance.quantity), allocated: number(balance.allocated_quantity)
      };
    });
    const summary = {
      skuCount: new Set(normalized.map(row => row.productId)).size,
      onHand: normalized.reduce((sum, row) => sum + row.onHand, 0),
      available: normalized.reduce((sum, row) => sum + Math.max(row.onHand - row.allocated, 0), 0),
      warehouses: selectedLocations.length
    };

    if (search.length >= 2) {
      const grouped = new Map();
      normalized
        .filter(row => [row.sku, row.name, row.category].join(' ').toLowerCase().includes(search))
        .forEach(row => {
          if (!grouped.has(row.productId)) grouped.set(row.productId, {
            productId: row.productId, sku: row.sku || '—', name: row.name || '—', category: row.category,
            onHand: 0, allocated: 0, locations: []
          });
          const item = grouped.get(row.productId);
          item.onHand += row.onHand; item.allocated += row.allocated;
          item.locations.push({ location: row.location, onHand: row.onHand, allocated: row.allocated, available: Math.max(row.onHand - row.allocated, 0) });
        });
      const rows = [...grouped.values()]
        .map(item => ({ ...item, available: Math.max(item.onHand - item.allocated, 0) }))
        .sort((a, b) => a.sku.localeCompare(b.sku))
        .slice(0, 100);
      return res.status(200).json({ ok: true, mode: 'lookup', locations, locationId: requestedLocationId || null, rows, summary, generatedAt: new Date().toISOString() });
    }

    const byWarehouse = new Map();
    normalized.forEach(row => {
      if (!byWarehouse.has(row.locationId)) byWarehouse.set(row.locationId, { id: row.locationId, name: row.location, categories: new Map() });
      const warehouse = byWarehouse.get(row.locationId);
      if (!warehouse.categories.has(row.category)) warehouse.categories.set(row.category, { category: row.category, skuCount: 0, onHand: 0, allocated: 0, available: 0, zeroOrNegative: 0 });
      const category = warehouse.categories.get(row.category);
      category.skuCount += 1; category.onHand += row.onHand; category.allocated += row.allocated;
      category.available += Math.max(row.onHand - row.allocated, 0);
      if (row.onHand <= 0) category.zeroOrNegative += 1;
    });
    const warehouses = [...byWarehouse.values()].map(warehouse => ({
      id: warehouse.id, name: warehouse.name,
      categories: [...warehouse.categories.values()].sort((a, b) => b.available - a.available || a.category.localeCompare(b.category))
    })).sort((a, b) => a.name.localeCompare(b.name));

    return res.status(200).json({ ok: true, mode: 'overview', locations, locationId: requestedLocationId || null, warehouses, summary, generatedAt: new Date().toISOString() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'V2 inventory lookup failed' });
  }
};
