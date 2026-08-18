const productPreview = require('./product-sync-preview');
const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

async function collectPreview(req) {
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
          const error = new Error(payload.error || 'Product preview failed');
          error.status = this.statusCode;
          reject(error);
        } else {
          resolve(payload);
        }
      }
    };
    Promise.resolve(productPreview({ ...req, method: 'GET' }, response)).catch(reject);
  });
}

module.exports = async function productCatalogImport(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const authorization = await requireUser(req);
  if (!authorization.ok) {
    return res.status(authorization.status).json({ ok: false, error: authorization.error });
  }
  if (!['admin', 'developer'].includes(authorization.user.role)) {
    return res.status(403).json({ ok: false, error: 'administrator_role_required' });
  }
  if (req.body?.confirmation !== 'IMPORT_PRODUCTS') {
    return res.status(400).json({ ok: false, error: 'import_confirmation_required' });
  }

  try {
    const preview = await collectPreview(req);
    if (!preview.ok || preview.mode !== 'PREVIEW_ONLY' || preview.writesEnabled !== false) {
      throw new Error('Product preview safety check failed');
    }

    const products = preview.candidates.map(candidate => ({
      sku: candidate.sku,
      name: candidate.name,
      barcode: candidate.barcode,
      uom: candidate.uom,
      active: candidate.active,
      purchase_price: candidate.purchasePrice,
      moving_average_cost: candidate.movingAverageCost
    }));

    const { url, serviceRoleKey } = configuration();
    const response = await fetch(`${url}/rest/v1/rpc/import_product_catalog`, {
      method: 'POST',
      headers: jsonHeaders(serviceRoleKey),
      body: JSON.stringify({
        p_products: products,
        p_user_id: authorization.user.id,
        p_user_name: authorization.user.display_name,
        p_user_email: authorization.user.email || authorization.authUser.email
      }),
      signal: AbortSignal.timeout(30000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Product import failed');

    const summary = Array.isArray(result) ? result[0] : result;
    return res.status(200).json({
      ok: true,
      source: 'shopify',
      qoblexConnected: false,
      imported: {
        inserted: Number(summary.inserted_count || 0),
        updated: Number(summary.updated_count || 0),
        warnings: preview.counts.warnings
      }
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      ok: false,
      qoblexConnected: false,
      error: error.message
    });
  }
};
