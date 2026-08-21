const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');
const number = value => Number(value || 0);
const isoDate = offset => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);

module.exports = async function forecast(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ ok: false, error: 'method_not_allowed' }); }
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  try {
    const query = new URL(req.url || '/', 'http://localhost').searchParams;
    const category = String(query.get('category') || '').trim();
    const { url, serviceRoleKey } = configuration();
    const headers = jsonHeaders(serviceRoleKey);
    if (query.get('mode') === 'categories') {
      const response = await fetch(url + '/rest/v1/products?select=category&sku=not.is.null&category=not.is.null&order=category.asc&limit=10000', { headers, signal: AbortSignal.timeout(10000) });
      const rows = await response.json();
      if (!response.ok) throw new Error('category lookup failed');
      return res.status(200).json({ ok: true, categories: [...new Set(rows.map(row => String(row.category || '').trim()).filter(Boolean))] });
    }
    if (!category) return res.status(400).json({ ok: false, error: 'Choose a category before loading a forecast.' });
    const encodedCategory = encodeURIComponent(category);
    const [locationResponse, balanceResponse, parResponse, salesResponse] = await Promise.all([
      fetch(url + '/rest/v1/locations?active=eq.true&select=id,code,name', { headers, signal: AbortSignal.timeout(10000) }),
      fetch(url + '/rest/v1/inventory_balances?select=location_id,product_id,quantity,allocated_quantity,products!inner(sku,name,category)&products.category=eq.' + encodedCategory + '&limit=10000', { headers, signal: AbortSignal.timeout(12000) }),
      fetch(url + '/rest/v1/product_par_levels?select=location_id,product_id,par_quantity&limit=10000', { headers, signal: AbortSignal.timeout(10000) }),
      fetch(url + '/rest/v1/shopify_sales_daily?sales_date=gte.' + isoDate(91) + '&select=sales_date,product_id,quantity_sold,last_synced_at,products!inner(category)&products.category=eq.' + encodedCategory + '&limit=10000', { headers, signal: AbortSignal.timeout(12000) })
    ]);
    const [locations, balances, pars, sales] = await Promise.all([locationResponse.json(), balanceResponse.json(), parResponse.json(), salesResponse.json()]);
    if (![locationResponse, balanceResponse, parResponse, salesResponse].every(response => response.ok)) throw new Error('forecast data lookup failed');
    const hub = locations.find(location => String(location.code || '').trim() === '730') || locations.find(location => /730\s+windham/i.test(location.name || ''));
    if (!hub) throw new Error('730 Windham distribution hub was not found');
    const parByKey = new Map(pars.map(row => [String(row.location_id) + '|' + String(row.product_id), number(row.par_quantity)]));
    const byProduct = new Map();
    balances.forEach(balance => {
      if (!byProduct.has(balance.product_id)) byProduct.set(balance.product_id, { productId: balance.product_id, sku: balance.products?.sku || '—', product: balance.products?.name || 'Unnamed product', category: balance.products?.category || category, hubOnHand: 0, hubAllocated: 0, retailShortage: 0 });
      const row = byProduct.get(balance.product_id), par = parByKey.get(String(balance.location_id) + '|' + String(balance.product_id)) || 0;
      if (Number(balance.location_id) === Number(hub.id)) { row.hubOnHand = number(balance.quantity); row.hubAllocated = number(balance.allocated_quantity); }
      else row.retailShortage += Math.max(par - number(balance.quantity), 0);
    });
    const windows = [30, 60, 90], cutoffs = Object.fromEntries(windows.map(days => [days, isoDate(days)]));
    const latest = sales.reduce((date, row) => !date || row.last_synced_at > date ? row.last_synced_at : date, null);
    sales.forEach(sale => {
      if (!byProduct.has(sale.product_id)) return;
      const row = byProduct.get(sale.product_id);
      windows.forEach(days => { if (sale.sales_date >= cutoffs[days]) row['sales' + days] = number(row['sales' + days]) + number(sale.quantity_sold); });
    });
    const items = [...byProduct.values()].map(row => {
      const sales30 = number(row.sales30), sales60 = number(row.sales60), sales90 = number(row.sales90);
      const monthlyRunRate = Math.max(sales30, sales60 / 2, sales90 / 3);
      const hubAvailable = Math.max(row.hubOnHand - row.hubAllocated, 0);
      const hubBackstockTarget = Math.ceil(monthlyRunRate);
      const purchaseRecommendation = Math.max(0, Math.ceil(hubBackstockTarget + row.retailShortage - hubAvailable));
      return { ...row, sales30, sales60, sales90, hubAvailable, hubBackstockTarget, monthlyRunRate, purchaseRecommendation };
    }).filter(row => row.sales90 > 0 || row.retailShortage > 0).sort((a, b) => b.purchaseRecommendation - a.purchaseRecommendation || b.sales30 - a.sales30).slice(0, 250);
    const sum = key => items.reduce((total, item) => total + number(item[key]), 0);
    return res.status(200).json({ ok: true, category, hub: { id: hub.id, name: hub.name, code: hub.code }, lastSyncedAt: latest, items, summary: { sales30: sum('sales30'), sales60: sum('sales60'), sales90: sum('sales90'), hubBackstockTarget: sum('hubBackstockTarget'), hubAvailable: sum('hubAvailable'), purchasePieces: sum('purchaseRecommendation'), purchaseSkus: items.filter(item => item.purchaseRecommendation > 0).length } });
  } catch (error) { return res.status(500).json({ ok: false, error: error.message || 'forecast_failed' }); }
};