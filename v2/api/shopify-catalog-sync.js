const productPreview = require('./product-sync-preview');
const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

async function collectPreview(req) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(payload) {
        if (this.statusCode >= 400) {
          const error = new Error(payload.error || 'Shopify preview failed');
          error.status = this.statusCode;
          reject(error);
        } else {
          resolve(payload);
        }
      }
    };
    Promise.resolve(productPreview({ method: 'GET', headers: req.headers }, response)).catch(reject);
  });
}

module.exports = async function shopifyCatalogSync(req, res) {
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
  if (req.body?.confirmation !== 'SYNC_SHOPIFY_CATALOG') {
    return res.status(400).json({ ok: false, error: 'catalog_sync_confirmation_required' });
  }

  try {
    const preview = await collectPreview(req);
    if (!preview.ok || preview.mode !== 'PREVIEW_ONLY' || preview.writesEnabled !== false) {
      throw new Error('Shopify preview safety check failed');
    }

    const catalog = preview.candidates.map(candidate => ({
      sku: candidate.sku,
      name: candidate.name,
      barcode: candidate.barcode,
      sources: candidate.sources
    }));

    const { url, serviceRoleKey } = configuration();
    const response = await fetch(`${url}/rest/v1/rpc/sync_shopify_catalog_mirror`, {
      method: 'POST',
      headers: jsonHeaders(serviceRoleKey),
      body: JSON.stringify({
        p_catalog: catalog,
        p_user_id: authorization.user.id,
        p_user_name: authorization.user.display_name,
        p_user_email: authorization.user.email || authorization.authUser.email
      }),
      signal: AbortSignal.timeout(30000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Shopify catalog sync failed');

    const summary = Array.isArray(result) ? result[0] : result;
    return res.status(200).json({
      ok: true,
      direction: 'shopify_to_v2',
      source: 'shopify',
      qoblexConnected: false,
      synced: {
        created: Number(summary.created_count || 0),
        refreshed: Number(summary.refreshed_count || 0),
        sourceVariants: Number(summary.source_variant_count || 0),
        warnings: preview.counts.warnings
      }
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      ok: false,
      direction: 'shopify_to_v2',
      qoblexConnected: false,
      error: error.message
    });
  }
};
