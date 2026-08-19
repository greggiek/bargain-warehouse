const shopifyPreview = require('./shopify-sync-preview');
const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const LOCATION_RULES = [
  { match: ['amityville'], warehouseCode: 'AMT' },
  { match: ['bohemia'], warehouseCode: 'BOH' },
  { match: ['outpost', 'ronkonkoma'], warehouseCode: 'OUT' },
  { match: ['riverhead'], warehouseCode: 'RIV' },
  { match: ['annex'], warehouseCode: 'WIN', locationCode: 'ANNEX' },
  { match: ['windham'], warehouseCode: 'WIN', locationCode: '730' }
];

function normalized(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function collectShopify(req) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(payload) {
        if (this.statusCode >= 400) {
          const error = new Error(payload.error || 'Shopify inventory preview failed');
          error.status = this.statusCode;
          reject(error);
        } else {
          resolve(payload);
        }
      }
    };
    Promise.resolve(shopifyPreview({ method: 'GET', headers: req.headers }, response)).catch(reject);
  });
}

function mapLocation(level, locations) {
  const key = normalized(level.locationName);
  const rule = LOCATION_RULES.find(candidate =>
    candidate.match.some(term => key.includes(normalized(term)))
  );
  if (!rule) return null;
  const matched = locations.filter(location =>
    location.warehouses?.code === rule.warehouseCode &&
    (!rule.locationCode || location.code === rule.locationCode)
  );
  return matched.length === 1 ? matched[0] : null;
}

module.exports = async function inventoryOpeningSnapshotPreview(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, writesEnabled: false, error: 'method_not_allowed' });
  }

  const authorization = await requireUser(req);
  if (!authorization.ok) {
    return res.status(authorization.status).json({ ok: false, writesEnabled: false, error: authorization.error });
  }

  try {
    const shopify = await collectShopify(req);
    if (shopify.writesEnabled !== false) throw new Error('Shopify safety check failed');

    const { url, serviceRoleKey } = configuration();
    const locationsResponse = await fetch(
      `${url}/rest/v1/locations?select=id,name,code,warehouses(code,name)&order=id.asc`,
      { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(10000) }
    );
    if (!locationsResponse.ok) throw new Error('V2 location lookup failed');
    const locations = await locationsResponse.json();

    const balances = new Map();
    const unmapped = [];
    let sourceLevels = 0;
    let negativeRows = 0;

    for (const item of shopify.normalized || []) {
      for (const level of item.locations || []) {
        sourceLevels += 1;
        const location = mapLocation(level, locations);
        if (!location) {
          unmapped.push({
            shopifyStore: level.sourceStoreLabel,
            shopifyLocation: level.locationName,
            sku: item.sku,
            onHand: Number(level.onHand || 0)
          });
          continue;
        }

        const onHand = Number(level.onHand || 0);
        if (onHand < 0) negativeRows += 1;
        const key = `${location.id}:${item.sku}`;
        const existing = balances.get(key) || {
          v2LocationId: location.id,
          v2Location: location.name,
          warehouse: location.warehouses?.name || '',
          sku: item.sku,
          product: item.product,
          onHand: 0,
          sourceStores: new Set()
        };
        existing.onHand += onHand;
        existing.sourceStores.add(level.sourceStoreLabel);
        balances.set(key, existing);
      }
    }

    const rows = Array.from(balances.values())
      .map(row => ({ ...row, sourceStores: Array.from(row.sourceStores).sort() }))
      .sort((a, b) => (a.onHand < 0 ? -1 : b.onHand < 0 ? 1 : a.sku.localeCompare(b.sku)));

    const unmappedByLocation = new Map();
    for (const row of unmapped) {
      const key = `${row.shopifyStore}:${row.shopifyLocation}`;
      const group = unmappedByLocation.get(key) || {
        shopifyStore: row.shopifyStore,
        shopifyLocation: row.shopifyLocation,
        levels: 0,
        nonzeroLevels: 0,
        netOnHand: 0,
        examples: []
      };
      group.levels += 1;
      group.netOnHand += row.onHand;
      if (row.onHand !== 0) group.nonzeroLevels += 1;
      if (group.examples.length < 4) group.examples.push(`${row.sku} (${row.onHand})`);
      unmappedByLocation.set(key, group);
    }

    const negativeByLocation = new Map();
    for (const row of rows) {
      if (row.onHand >= 0) continue;
      const key = String(row.v2LocationId);
      const group = negativeByLocation.get(key) || {
        warehouse: row.warehouse,
        v2Location: row.v2Location,
        negativeSkus: 0,
        totalDeficit: 0,
        worstOnHand: 0,
        examples: []
      };
      group.negativeSkus += 1;
      group.totalDeficit += Math.abs(row.onHand);
      group.worstOnHand = Math.min(group.worstOnHand, row.onHand);
      if (group.examples.length < 4) group.examples.push(`${row.sku} (${row.onHand})`);
      negativeByLocation.set(key, group);
    }

    return res.status(200).json({
      ok: true,
      mode: 'OPENING_SNAPSHOT_PREVIEW',
      writesEnabled: false,
      qoblexConnected: false,
      counts: {
        sourceLevels,
        mappedBalances: rows.length,
        unmappedLevels: unmapped.length,
        unmappedNonzeroLevels: unmapped.filter(row => row.onHand !== 0).length,
        negativeBalances: negativeRows,
        negativeDeficit: rows.filter(row => row.onHand < 0).reduce((sum, row) => sum + Math.abs(row.onHand), 0)
      },
      rows: rows.slice(0, 250),
      unmappedLocations: Array.from(unmappedByLocation.values())
        .sort((a, b) => b.nonzeroLevels - a.nonzeroLevels || b.levels - a.levels),
      negativeLocations: Array.from(negativeByLocation.values())
        .sort((a, b) => b.totalDeficit - a.totalDeficit),
      unmapped: unmapped.slice(0, 100),
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      ok: false,
      mode: 'OPENING_SNAPSHOT_PREVIEW',
      writesEnabled: false,
      qoblexConnected: false,
      error: error.message
    });
  }
};
