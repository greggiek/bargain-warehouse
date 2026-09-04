const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = (value, maximum) => String(value || '').trim().slice(0, maximum);
const escapePostgrest = value => value.replace(/[(),.*%]/g, ' ').replace(/\s+/g, ' ').trim();

async function getJson(requestUrl, key) {
  const response = await fetch(requestUrl, {
    headers: jsonHeaders(key),
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || 'V2 inventory lookup failed');
  return data;
}

async function accessForUser(url, key, userId) {
  const rows = await getJson(
    url + '/rest/v1/user_location_access?user_id=eq.' + encodeURIComponent(userId) +
      '&select=location_id,locations(id,name,active)',
    key
  );
  return rows
    .filter(row => row.locations?.active)
    .map(row => ({ id: Number(row.location_id), name: row.locations.name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

async function matchingProducts(url, key, locationIds, category, search) {
  const products = [];
  const locationFilter = 'in.(' + locationIds.join(',') + ')';
  for (let offset = 0; ; offset += 1000) {
    let query = '/rest/v1/products?select=id,sku,name,category,inventory_balances!inner(location_id)' +
      '&inventory_balances.location_id=' + encodeURIComponent(locationFilter) +
      '&order=id.asc&limit=1000&offset=' + offset;
    if (category) query += '&category=eq.' + encodeURIComponent(category);
    if (search) {
      const pattern = '*' + escapePostgrest(search) + '*';
      query += '&or=' + encodeURIComponent('(sku.ilike.' + pattern + ',name.ilike.' + pattern + ',category.ilike.' + pattern + ')');
    }
    const page = await getJson(url + query, key);
    products.push(...page.map(row => ({
      id: Number(row.id),
      sku: text(row.sku, 200) || '—',
      name: text(row.name, 500) || 'Unnamed product',
      category: text(row.category, 200) || 'Uncategorized'
    })));
    if (page.length < 1000) break;
  }
  return products;
}

async function balancesForProducts(url, key, locationIds, productIds, fields = 'product_id,location_id,quantity,allocated_quantity') {
  if (!productIds.length || !locationIds.length) return [];
  const rows = [];
  for (let offset = 0; offset < productIds.length; offset += 200) {
    const ids = productIds.slice(offset, offset + 200);
    const query = '/rest/v1/inventory_balances?select=' + fields +
      '&location_id=' + encodeURIComponent('in.(' + locationIds.join(',') + ')') +
      '&product_id=' + encodeURIComponent('in.(' + ids.join(',') + ')') +
      '&order=product_id.asc,location_id.asc';
    rows.push(...await getJson(url + query, key));
  }
  return rows;
}

function stableProductOrder(a, b) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
    a.sku.localeCompare(b.sku, undefined, { sensitivity: 'base' }) ||
    a.id - b.id;
}

module.exports = async function inventory(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const queryStarted = Date.now();
  try {
    const { url, serviceRoleKey } = configuration();
    const allLocations = await accessForUser(url, serviceRoleKey, auth.user.id);
    const requestedLocationId = Number(req.query?.locationId || 0);
    if (requestedLocationId && !allLocations.some(location => location.id === requestedLocationId)) {
      return res.status(403).json({ ok: false, error: 'You do not have access to that warehouse.' });
    }

    const locations = requestedLocationId
      ? allLocations.filter(location => location.id === requestedLocationId)
      : allLocations;
    const locationIds = locations.map(location => location.id);
    const category = text(req.query?.category, 120);
    const search = text(req.query?.search, 80);
    const requestedSortLocationId = Number(req.query?.sortLocationId || 0);
    if (requestedSortLocationId && !locationIds.includes(requestedSortLocationId)) {
      return res.status(403).json({ ok: false, error: 'You do not have access to that warehouse.' });
    }
    const sortDirection = req.query?.sortDirection === 'asc' ? 'asc' : 'desc';
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(req.query?.pageSize, 10) || DEFAULT_PAGE_SIZE));
    const requestedPage = Math.max(1, Number.parseInt(req.query?.page, 10) || 1);

    let products = locationIds.length
      ? await matchingProducts(url, serviceRoleKey, locationIds, category, search)
      : [];
    const categories = new Map();
    products.forEach(product => {
      const key = product.category;
      const current = categories.get(key) || { category: key, itemCount: 0, locationId: requestedLocationId || null, onHand: 0, committed: 0, available: 0 };
      current.itemCount += 1;
      categories.set(key, current);
    });

    if (requestedSortLocationId && products.length) {
      const sortBalances = await balancesForProducts(
        url,
        serviceRoleKey,
        [requestedSortLocationId],
        products.map(product => product.id),
        'product_id,location_id,quantity'
      );
      const quantityByProduct = new Map(sortBalances.map(row => [Number(row.product_id), number(row.quantity)]));
      products.sort((a, b) => {
        const delta = (quantityByProduct.get(a.id) || 0) - (quantityByProduct.get(b.id) || 0);
        return (sortDirection === 'asc' ? delta : -delta) || stableProductOrder(a, b);
      });
    } else {
      products.sort(stableProductOrder);
    }

    const totalResults = products.length;
    const totalPages = Math.max(1, Math.ceil(totalResults / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const pageProducts = products.slice((page - 1) * pageSize, page * pageSize);
    const pageBalances = await balancesForProducts(url, serviceRoleKey, locationIds, pageProducts.map(product => product.id));
    const balanceByProduct = new Map();
    pageBalances.forEach(balance => {
      const productId = Number(balance.product_id);
      if (!balanceByProduct.has(productId)) balanceByProduct.set(productId, {});
      const onHand = number(balance.quantity);
      const committed = number(balance.allocated_quantity);
      balanceByProduct.get(productId)[Number(balance.location_id)] = {
        onHand,
        committed,
        available: onHand - committed
      };
    });

    const rows = pageProducts.map(product => {
      const inventory = balanceByProduct.get(product.id) || {};
      const quantities = {};
      locations.forEach(location => { quantities[location.id] = inventory[location.id]?.onHand || 0; });
      return { productId: product.id, sku: product.sku, name: product.name, category: product.category, inventory, quantities };
    });

    return res.status(200).json({
      ok: true,
      locations,
      allLocations,
      locationId: requestedLocationId || null,
      category,
      rows,
      categories: [...categories.values()].sort((a, b) => a.category.localeCompare(b.category)),
      page,
      pageSize,
      totalResults,
      totalPages,
      queryTimeMs: Date.now() - queryStarted,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[inventory]', error);
    return res.status(500).json({ ok: false, error: 'Could not load inventory.' });
  }
};
