const preview = require('./inventory-opening-snapshot-preview');
const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

function collect(req) { return new Promise((resolve, reject) => {
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode=code; return this; }, json(body) { this.statusCode >= 400 ? reject(Object.assign(new Error(body.error || 'Preview failed'), { status:this.statusCode })) : resolve(body); } };
  Promise.resolve(preview({ method:'GET', headers:req.headers }, res)).catch(reject);
});}

module.exports = async function openingImport(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'method_not_allowed' });
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok:false, error:auth.error });
  if (!['admin','developer'].includes(auth.user.role)) return res.status(403).json({ ok:false, error:'admin_required' });
  if (req.body?.confirmation !== 'IMPORT_OPENING_BALANCE') return res.status(400).json({ ok:false, error:'confirmation_required' });
  try {
    const data = await collect(req);
    if (data.writesEnabled !== false || data.counts.unmappedNonzeroLevels) throw new Error('Opening preview is not ready');
    const { url, serviceRoleKey } = configuration();
    const response = await fetch(url + '/rest/v1/rpc/apply_opening_inventory_snapshot', { method:'POST', headers:jsonHeaders(serviceRoleKey), body:JSON.stringify({ p_rows:data.importRows, p_user_id:auth.user.id, p_user_name:auth.user.display_name }), signal:AbortSignal.timeout(60000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Opening import failed');
    return res.status(200).json({ ok:true, result, shopifyChanged:false, qoblexChanged:false });
  } catch (error) { return res.status(error.status || 500).json({ ok:false, error:error.message }); }
};