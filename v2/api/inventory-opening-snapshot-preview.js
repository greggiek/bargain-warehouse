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

    return res.status(200).json({
      ok: true,
      mode: 'OPENING_SNAPSHOT_PREVIEW',
      writesEnabled: false,
      qoblexConnected: false,
      counts: {
        sourceLevels,
        mappedBalances: rows.length,
        unmappedLevels: unmapped.length,
        negativeBalances: negativeRows
      },
      rows: rows.slice(0, 250),
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
