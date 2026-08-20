const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

module.exports = async (req, res) => {
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  if (auth.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Administrator access is required.' });
  const { url, serviceRoleKey } = configuration();
  try {
    if (req.method === 'GET') {
      const response = await fetch(url + "/rest/v1/products?or=(sku.is.null,sku.eq.)&select=id,name,barcode,category,active,created_at&order=created_at.asc&limit=250", { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) });
      const products = await response.json();
      if (!response.ok) throw new Error(products.message || 'SKU fix queue lookup failed');
      return res.status(200).json({ ok: true, products });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const id = Number(req.body?.productId), sku = String(req.body?.sku || '').trim().toUpperCase();
    if (!Number.isInteger(id) || !sku) return res.status(400).json({ ok: false, error: 'A product and SKU are required.' });
    const duplicate = await fetch(url + '/rest/v1/products?sku=eq.' + encodeURIComponent(sku) + '&id=neq.' + id + '&select=id&limit=1', { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) });
    const matches = await duplicate.json(); if (!duplicate.ok) throw new Error('SKU uniqueness check failed'); if (matches.length) return res.status(409).json({ ok: false, error: 'That SKU is already in use.' });
    const update = await fetch(url + '/rest/v1/products?id=eq.' + id, { method: 'PATCH', headers: { ...jsonHeaders(serviceRoleKey), 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ sku, updated_at: new Date().toISOString() }), signal: AbortSignal.timeout(8000) });
    const product = await update.json(); if (!update.ok) throw new Error(product.message || 'SKU update failed');
    return res.status(200).json({ ok: true, product: product[0] });
  } catch (error) { return res.status(400).json({ ok: false, error: error.message || 'sku_fix_failed' }); }
};
