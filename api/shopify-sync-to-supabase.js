const crypto = require('node:crypto');

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireConfig(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

module.exports = async function (req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'POST required' });
  }

  try {
    const syncSecret = requireConfig('SHOPIFY_SYNC_SECRET');
    const suppliedSecret = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

    if (!safeEqual(suppliedSecret, syncSecret)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const supabaseUrl = requireConfig('SUPABASE_URL').replace(/\/+$/, '');
    const serviceKey =
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!serviceKey) {
      throw new Error('Missing SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY');
    }

    const origin = `https://${req.headers.host}`;
    const previewResponse = await fetch(`${origin}/api/shopify-sync-preview`, {
      headers: { Accept: 'application/json' }
    });
    const preview = await previewResponse.json();

    if (!previewResponse.ok || !preview.ok) {
      throw new Error(preview.error || 'Shopify preview failed');
    }
    if (preview.writesEnabled !== false) {
      throw new Error('Safety check failed: Shopify source is not marked read-only');
    }

    const snapshotRows = [];

    for (const item of preview.normalized || []) {
      for (const variant of item.variants || []) {
        const locations = (item.locations || []).filter(
          location => location.sourceStore === variant.sourceStore
        );

        for (const location of locations) {
          snapshotRows.push({
            source_store: variant.sourceStore,
            source_store_label: variant.sourceStoreLabel,
            shopify_product_id: variant.shopifyProductId,
            shopify_variant_id: variant.shopifyVariantId,
            shopify_inventory_item_id: variant.shopifyInventoryItemId,
            shopify_location_id: location.shopifyLocationId,
            location_name: location.locationName,
            sku: item.sku,
            product_name: item.product,
            barcode: variant.barcode || '',
            on_hand: Number(location.onHand || 0),
            available: Number(location.available || 0),
            committed: Number(location.committed || 0),
            raw: null
          });
        }
      }
    }

    const rpcResponse = await fetch(
      `${supabaseUrl}/rest/v1/rpc/replace_shopify_inventory_snapshot`,
      {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          p_rows: snapshotRows,
          p_stores_seen: (preview.stores || []).length,
          p_normalized_skus: Number(preview.normalizedCount || 0),
          p_metadata: {
            source: 'vercel',
            shopify_mode: preview.mode,
            shopify_generated_at: preview.generatedAt
          }
        })
      }
    );

    const result = await rpcResponse.json();
    if (!rpcResponse.ok) {
      throw new Error(result.message || result.error || 'Supabase snapshot import failed');
    }

    return res.status(200).json({
      ok: true,
      mode: 'READ_ONLY_IMPORT',
      shopifyWritesEnabled: false,
      storesSeen: (preview.stores || []).length,
      normalizedSkus: Number(preview.normalizedCount || 0),
      snapshotRows: result[0]?.snapshot_rows ?? snapshotRows.length,
      syncRunId: result[0]?.sync_run_id ?? null,
      completedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      mode: 'READ_ONLY_IMPORT',
      shopifyWritesEnabled: false,
      error: error.message
    });
  }
};
