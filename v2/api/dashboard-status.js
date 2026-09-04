const { performance } = require('perf_hooks');
const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const VIEW_ALL_ROLES = new Set(['admin', 'developer']);

async function request(url, key, path, { count = false } = {}) {
  const headers = jsonHeaders(key);
  if (count) headers.Prefer = 'count=exact';
  const response = await fetch(url + '/rest/v1/' + path, { headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Error(error.message || 'dashboard lookup failed');
  }
  if (count) {
    const range = response.headers.get('content-range') || '*/0';
    return Number(range.split('/')[1] || 0);
  }
  return response.json();
}

async function locationAccess(url, key, userId, viewAll) {
  const path = viewAll
    ? 'locations?active=eq.true&select=id,name,active&order=name.asc'
    : 'user_location_access?user_id=eq.' + encodeURIComponent(userId) + '&select=location_id,can_manage,locations(id,name,active)';
  const data = await request(url, key, path);
  return viewAll
    ? data.map(row => ({ id: Number(row.id), name: row.name, canManage: true }))
    : data.filter(row => row.locations?.active).map(row => ({ id: Number(row.location_id), name: row.locations.name, canManage: Boolean(row.can_manage) }));
}

function lowStockCount(balances, categoryPars, productPars) {
  const category = new Map(categoryPars.map(row => [row.location_id + '|' + String(row.category || '').trim().toLowerCase(), Number(row.par_quantity)]));
  const product = new Map(productPars.map(row => [row.location_id + '|' + row.product_id, Number(row.par_quantity)]));
  return balances.reduce((count, row) => {
    const locationId = Number(row.location_id);
    const productId = Number(row.product_id);
    const par = product.get(locationId + '|' + productId)
      ?? category.get(locationId + '|' + String(row.products?.category || '').trim().toLowerCase())
      ?? 0;
    return count + (par > Number(row.quantity) ? 1 : 0);
  }, 0);
}

module.exports = async function dashboardStatus(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const started = performance.now();
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  try {
    const { url, serviceRoleKey: key } = configuration();
    const canViewAll = VIEW_ALL_ROLES.has(auth.user.role);
    const locations = await locationAccess(url, key, auth.user.id, canViewAll);
    const requested = String(req.query?.locationId || '').trim();
    const defaultLocation = locations.find(row => row.canManage) || locations[0] || null;
    const chosen = requested === 'all' && canViewAll ? locations : locations.filter(row => row.id === Number(requested));
    const scope = chosen.length ? chosen : (defaultLocation ? [defaultLocation] : []);
    if (!scope.length) return res.json({ ok: true, purchaseOrders: 0, transfers: 0, cycleReviews: 0, inventorySkus: 0, lowStock: 0, location: null, locations, canViewAll });

    const idList = scope.map(row => row.id).join(',');
    const countSuffix = '&select=id&limit=1';
    const queryStarted = performance.now();
    const [purchaseOrders, transfers, cycleReviews, inventoryProducts, balances, categoryPars, productPars] = await Promise.all([
      request(url, key, 'purchase_orders?receiving_location_id=in.(' + idList + ')&status=in.(ordered,partially_received)' + countSuffix, { count: true }),
      request(url, key, 'transfers?to_location_id=in.(' + idList + ')&status=in.(allocated,in_transit,partially_received)' + countSuffix, { count: true }),
      request(url, key, 'cycle_count_lines?status=eq.variance&review_status=eq.pending&cycle_count_runs.location_id=in.(' + idList + ')&select=id,cycle_count_runs!inner(location_id)&limit=1', { count: true }),
      request(url, key, 'inventory_balances?location_id=in.(' + idList + ')&select=product_id&limit=10000'),
      request(url, key, 'inventory_balances?location_id=in.(' + idList + ')&select=location_id,product_id,quantity,products(category)&limit=10000'),
      request(url, key, 'location_category_par_levels?location_id=in.(' + idList + ')&select=location_id,category,par_quantity'),
      request(url, key, 'product_par_levels?location_id=in.(' + idList + ')&select=location_id,product_id,par_quantity')
    ]);
    const dbMs = Math.round(performance.now() - queryStarted);
    const isAll = requested === 'all' && canViewAll;
    const payload = {
      ok: true,
      location: isAll ? { id: 'all', name: 'All locations' } : { id: scope[0].id, name: scope[0].name },
      locations,
      canViewAll,
      purchaseOrders,
      transfers,
      cycleReviews,
      inventorySkus: new Set(inventoryProducts.map(row => Number(row.product_id))).size,
      lowStock: lowStockCount(balances, categoryPars, productPars),
      generatedAt: new Date().toISOString()
    };
    const totalMs = Math.round(performance.now() - started);
    res.setHeader('Server-Timing', `db;dur=${dbMs}, total;dur=${totalMs}`);
    res.setHeader('X-Request-Id', String(req.headers?.['x-request-id'] || ''));
    console.info(JSON.stringify({ event: 'dashboard_status', dbMs, totalMs, payloadBytes: Buffer.byteLength(JSON.stringify(payload)) }));
    return res.json(payload);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'dashboard_status_failed' });
  }
};
