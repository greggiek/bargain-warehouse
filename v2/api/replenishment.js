const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

async function accessForUser(url, key, userId) {
  const r = await fetch(url + '/rest/v1/user_location_access?user_id=eq.' + encodeURIComponent(userId) + '&select=location_id,can_manage,locations(id,name,active)', {
    headers: jsonHeaders(key), signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error('location access lookup failed');
  return (await r.json()).filter(x => x.locations?.active);
}

module.exports = async function replenishment(req, res) {
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  try {
    const { url, serviceRoleKey } = configuration();
    const access = await accessForUser(url, serviceRoleKey, auth.user.id);
    const ids = access.map(x => x.location_id).join(',');
    if (!ids) return res.status(200).json({ ok: true, items: [], recommendations: [], locations: [], board: [], summary: {} });

    const q = 'location_id=in.(' + ids + ')&select=location_id,product_id,quantity,allocated_quantity,products(sku,name,category,barcode),locations(id,name)&limit=10000';
    const [a, b, c] = await Promise.all([
      fetch(url + '/rest/v1/inventory_balances?' + q, { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(12000) }),
      fetch(url + '/rest/v1/location_category_par_levels?location_id=in.(' + ids + ')&select=location_id,category,par_quantity', { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) }),
      fetch(url + '/rest/v1/product_par_levels?location_id=in.(' + ids + ')&select=location_id,product_id,par_quantity', { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) })
    ]);
    const [balances, categoryPars, productPars] = await Promise.all([a.json(), b.json(), c.json()]);
    if (!a.ok) throw new Error(balances.message || 'replenishment lookup failed');
    if (!b.ok || !c.ok) throw new Error('par level lookup failed');

    const cp = new Map(categoryPars.map(x => [x.location_id + '|' + String(x.category || '').trim().toLowerCase(), Number(x.par_quantity)]));
    const pp = new Map(productPars.map(x => [x.location_id + '|' + x.product_id, Number(x.par_quantity)]));
    const rows = balances.map(x => {
      const locationId = Number(x.location_id);
      const productId = Number(x.product_id);
      const category = x.products?.category || 'Other';
      const onHand = Number(x.quantity);
      const allocated = Number(x.allocated_quantity || 0);
      const parQuantity = pp.get(locationId + '|' + productId) ?? cp.get(locationId + '|' + category.trim().toLowerCase()) ?? 0;
      return {
        locationId, location: x.locations?.name || 'Warehouse', productId,
        sku: x.products?.sku || '—', product: x.products?.name || 'Unnamed product',
        category, barcode: x.products?.barcode || '', onHand, parQuantity,
        shortage: Math.max(parQuantity - onHand, 0),
        available: Math.max(onHand - allocated - parQuantity, 0), allocated
      };
    });

    const mainLocation = access
      .map(x => ({ id: Number(x.location_id), name: x.locations?.name || '' }))
      .find(x => /windham/i.test(x.name)) || null;
    const byProductLocation = new Map(rows.map(x => [x.productId + '|' + x.locationId, x]));
    const items = rows.filter(x => x.shortage > 0).map(x => {
      const main = mainLocation ? byProductLocation.get(x.productId + '|' + mainLocation.id) : null;
      const availableSources = rows
        .filter(source => source.productId === x.productId && source.locationId !== x.locationId && source.available > 0)
        .sort((a, b) => b.available - a.available || a.location.localeCompare(b.location))
        .map(source => ({ locationId: source.locationId, location: source.location, available: source.available }));
      return {
        ...x,
        mainWarehouseName: mainLocation?.name || 'Main warehouse',
        mainWarehouseOnHand: main ? main.onHand : null,
        mainWarehouseAvailable: main ? main.available : null,
        availableSources
      };
    });

    const boardMap = new Map();
    rows.forEach(x => {
      const key = x.locationId + '|' + x.category;
      if (!boardMap.has(key)) boardMap.set(key, { locationId: x.locationId, location: x.location, category: x.category, below: 0, deficit: 0 });
      if (x.shortage > 0) {
        const item = boardMap.get(key);
        item.below += 1;
        item.deficit += x.shortage;
      }
    });
    const board = [...boardMap.values()].sort((a, b) => b.below - a.below || b.deficit - a.deficit || a.location.localeCompare(b.location));

    const byProduct = new Map();
    rows.forEach(x => {
      if (!byProduct.has(x.productId)) byProduct.set(x.productId, []);
      byProduct.get(x.productId).push({ ...x });
    });
    const recommendations = [];
    byProduct.forEach(group => {
      const sources = group.filter(x => x.available > 0).sort((a, b) => b.available - a.available);
      group.filter(x => x.shortage > 0).sort((a, b) => b.shortage - a.shortage).forEach(dest => {
        let need = dest.shortage;
        sources.forEach(source => {
          if (!need || source.locationId === dest.locationId) return;
          const quantity = Math.min(need, source.available);
          if (quantity > 0) {
            recommendations.push({ sku: dest.sku, product: dest.product, productId: dest.productId, from: source.location, to: dest.location, fromLocationId: source.locationId, toLocationId: dest.locationId, quantity, remainingNeed: need - quantity });
            source.available -= quantity;
            need -= quantity;
          }
        });
      });
    });

    return res.status(200).json({
      ok: true, items, recommendations,
      locations: access.map(x => ({ id: x.location_id, name: x.locations.name, canManage: x.can_manage })),
      board,
      summary: {
        shortageSkus: items.length,
        shortagePieces: items.reduce((n, x) => n + x.shortage, 0),
        warehousesAffected: new Set(items.map(x => x.locationId)).size,
        mainWarehouse: mainLocation?.name || null
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};