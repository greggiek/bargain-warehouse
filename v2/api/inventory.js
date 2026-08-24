const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const number = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

async function accessForUser(url, key, userId) {
  const response = await fetch(
    url + '/rest/v1/user_location_access?user_id=eq.' + encodeURIComponent(userId) + '&select=location_id,locations(id,name,active)',
    { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) }
  );
  if (!response.ok) throw new Error('location access lookup failed');
  return (await response.json()).filter(entry => entry.locations?.active)
    .map(entry => ({ id: Number(entry.location_id), name: entry.locations.name }));
}

async function balancesForLocation(url, key, locationId) {
  const balances = [];
  const pageSize = 1000;
  for (let offset = 0; offset < 20000; offset += pageSize) {
    const response = await fetch(
      url + '/rest/v1/inventory_balances?location_id=eq.' + locationId +
      '&select=product_id,quantity,allocated_quantity,products(sku,name,category)' +
      '&order=product_id.asc&limit=' + pageSize + '&offset=' + offset,
      { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) }
    );
    const page = await response.json();
    if (!response.ok) throw new Error(page.message || 'V2 inventory lookup failed');
    balances.push(...page);
    if (page.length < pageSize) return balances;
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

  const { url, serviceRoleKey } = configuration();
  try {
    const locations = await accessForUser(url, serviceRoleKey, auth.user.id);
    if (!locations.length) return res.status(200).json({ ok: true, locations: [], rows: [], total: 0, page: 1, pageSize: 75, summary: { skuCount: 0, onHand: 0, zeroOrNegative: 0 }, generatedAt: new Date().toISOString() });

    const requestedLocationId = number(req.query?.locationId, locations[0].id);
    if (!locations.some(location => location.id === requestedLocationId)) {
      return res.status(403).json({ ok: false, error: 'You can view inventory only at your assigned warehouse.' });
    }

    const search = String(req.query?.search || '').trim().toLowerCase().slice(0, 80);
    const pageSize = Math.min(100, Math.max(25, Math.floor(number(req.query?.pageSize, 75))));
    const page = Math.max(1, Math.floor(number(req.query?.page, 1)));
    const balances = await balancesForLocation(url, serviceRoleKey, requestedLocationId);
    const rows = [...new Map(balances.map(balance => {
      const product = balance.products || {};
      const productId = Number(balance.product_id);
      return [productId, {
        productId,
        sku: String(product.sku || '').trim(),
        name: String(product.name || ''),
        category: String(product.category || 'Uncategorized'),
        onHand: number(balance.quantity),
        allocated: number(balance.allocated_quantity)
      }];
    })).values()]
      .filter(row => !search || (row.sku + ' ' + row.name + ' ' + row.category).toLowerCase().includes(search))
      .sort((a, b) => a.sku.localeCompare(b.sku));

    const total = rows.length;
    const start = (page - 1) * pageSize;
    const summary = {
      skuCount: total,
      onHand: rows.reduce((sum, row) => sum + row.onHand, 0),
      zeroOrNegative: rows.filter(row => row.onHand <= 0).length
    };

    return res.status(200).json({
      ok: true,
      locations,
      locationId: requestedLocationId,
      rows: rows.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      summary,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'V2 inventory lookup failed' });
  }
};
