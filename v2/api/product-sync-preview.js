const shopifyPreview = require('./shopify-sync-preview');
const { configuration, jsonHeaders } = require('./_lib/auth');

async function collectShopify(req) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      setHeader() {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        if (this.statusCode >= 400) {
          const error = new Error(payload.error || 'Shopify preview failed');
          error.status = this.statusCode;
          error.payload = payload;
          reject(error);
        } else {
          resolve(payload);
        }
      }
    };
    Promise.resolve(shopifyPreview(req, response)).catch(reject);
  });
}

module.exports = async function productSyncPreview(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({
      ok: false,
      mode: 'PREVIEW_ONLY',
      writesEnabled: false,
      error: 'method_not_allowed'
    });
  }

  try {
    const shopify = await collectShopify(req);
    if (shopify.writesEnabled !== false) throw new Error('Shopify safety check failed');

    const { url, serviceRoleKey } = configuration();
    const existingProducts = [];
    for (let offset = 0; ; offset += 1000) {
      const productsResponse = await fetch(
        `${url}/rest/v1/products?select=id,sku,name,barcode,active,purchase_price,moving_average_cost&limit=1000&offset=${offset}`,
        { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(10000) }
      );
      if (!productsResponse.ok) throw new Error('V2 product lookup failed');
      const page = await productsResponse.json();
      existingProducts.push(...page);
      if (page.length < 1000) break;
    }
    const bySku = new Map(
      existingProducts.map(product => [String(product.sku).trim().toUpperCase(), product])
    );

    const candidates = [];
    const warnings = [];
    const barcodeOwners = new Map();
    let insertCount = 0;
    let updateCount = 0;
    let unchangedCount = 0;
    let sourceVariantCount = 0;

    for (const item of shopify.normalized || []) {
      const sku = String(item.sku || '').trim();
      if (!sku) continue;
      const name = String(item.product || sku).trim();
      const category = String(item.category || '').trim();
      const barcodes = Array.from(new Set(
        (item.variants || []).map(variant => String(variant.barcode || '').trim()).filter(Boolean)
      ));
      const barcode = barcodes.length === 1 ? barcodes[0] : null;
      if (barcodes.length > 1) {
        warnings.push({ sku, type: 'multiple_barcodes', values: barcodes });
      }
      if (barcode) {
        const firstSku = barcodeOwners.get(barcode);
        if (firstSku && firstSku !== sku) {
          warnings.push({ sku, type: 'duplicate_barcode', barcode, firstSku });
        } else {
          barcodeOwners.set(barcode, sku);
        }
      }

      const existing = bySku.get(sku.toUpperCase());
      let action = 'insert';
      if (existing) {
        const changed =
          String(existing.name || '') !== name ||
          String(existing.barcode || '') !== String(barcode || '') ||
          existing.active !== true;
        action = changed ? 'update' : 'unchanged';
      }

      if (action === 'insert') insertCount += 1;
      if (action === 'update') updateCount += 1;
      if (action === 'unchanged') unchangedCount += 1;

      const sources = (item.variants || []).map(variant => ({
        storeKey: variant.sourceStore,
        storeLabel: variant.sourceStoreLabel,
        productId: variant.shopifyProductId,
        variantId: variant.shopifyVariantId,
        inventoryItemId: variant.shopifyInventoryItemId || null,
        variantTitle: String(variant.variantTitle || '').trim(),
        sourceSku: String(variant.sourceSku || sku).normalize('NFKC').trim(),
        barcode: String(variant.barcode || '').trim() || null,
        productStatus: String(variant.productStatus || '').toUpperCase(),
        category: String(variant.category || category).trim()
      })).filter(source => source.storeKey && source.productId && source.variantId);
      const variantTitles = Array.from(new Set(sources.map(source => source.variantTitle).filter(title => title && title.toLowerCase() !== 'default title')));
      const variantTitle = variantTitles.join(' · ');
      sourceVariantCount += sources.length;

      candidates.push({
        action,
        sku,
        name,
        variantTitle,
        barcode,
        category,
        uom: 'EA',
        active: sources.some(source => source.productStatus === 'ACTIVE'),
        sourceStores: Array.from(new Set(sources.map(source => source.storeLabel).filter(Boolean))),
        sources
      });
    }

    return res.status(200).json({
      ok: true,
      mode: 'PREVIEW_ONLY',
      writesEnabled: false,
      source: 'shopify',
      qoblexConnected: false,
      counts: {
        shopifySkus: candidates.length,
        existingProducts: existingProducts.length,
        inserts: insertCount,
        updates: updateCount,
        unchanged: unchangedCount,
        warnings: warnings.length,
        sourceVariants: sourceVariantCount
      },
      candidates,
      warnings,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      ok: false,
      mode: 'PREVIEW_ONLY',
      writesEnabled: false,
      qoblexConnected: false,
      error: error.message
    });
  }
};
