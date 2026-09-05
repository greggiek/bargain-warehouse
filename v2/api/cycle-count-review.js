const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');
const ROLES = new Set(['manager', 'admin', 'developer']);
const clean = (value, max = 500) => String(value || '').trim().slice(0, max);

async function locations(url, key, userId) {
  const response = await fetch(url + '/rest/v1/user_location_access?user_id=eq.' + encodeURIComponent(userId) + '&can_manage=eq.true&select=location_id,locations(name,active)', { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Error('location access lookup failed');
  return (await response.json()).filter(row => row.locations?.active).map(row => Number(row.location_id));
}

async function pendingLines(url, key, allowed, lineId = null) {
  const allowedFilter = 'in.(' + allowed.join(',') + ')';
  let query = '/rest/v1/cycle_count_lines?status=eq.variance&review_status=eq.pending&select=id,run_id,product_id,expected_quantity,counted_quantity,counted_by_name,counted_at,note,cycle_count_runs!inner(location_id,business_date,locations(name)),products(sku,name)&cycle_count_runs.location_id=' + encodeURIComponent(allowedFilter) + '&order=counted_at.asc&limit=250';
  if (lineId) query += '&id=eq.' + lineId;
  const response = await fetch(url + query, { headers: { ...jsonHeaders(key), Prefer: 'count=exact' }, signal: AbortSignal.timeout(8000) });
  const data = await response.json().catch(() => []);
  if (!response.ok) throw Error(data.message || 'Could not load cycle count review.');
  const range = response.headers?.get?.('content-range') || '';
  const total = Number(range.split('/')[1]);
  return { lines: data, totalPending: Number.isFinite(total) ? total : data.length };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  if (!ROLES.has(auth.user.role)) return res.status(403).json({ ok: false, error: 'warehouse_manager_access_required' });
  try {
    const { url, serviceRoleKey: key } = configuration(), allowed = await locations(url, key, auth.user.id);
    if (!allowed.length) return res.status(403).json({ ok: false, error: 'No managed warehouse is assigned to you.' });
    if (req.method === 'GET') {
      const pending = await pendingLines(url, key, allowed);
      return res.json({ ok: true, lines: pending.lines, totalPending: pending.totalPending });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ ok: false, error: 'method_not_allowed' }); }
    const lineId = Number(req.body?.lineId), action = clean(req.body?.action, 20), target = await pendingLines(url, key, allowed, lineId), line = target.lines[0];
    if (!line) return res.status(404).json({ ok: false, error: 'Variance not found or not assigned to your warehouse.' });
    const note = clean(req.body?.note);
    if (action === 'approve') {
      const response = await fetch(url + '/rest/v1/rpc/approve_v2_cycle_count_variance', { method: 'POST', headers: { ...jsonHeaders(key), 'Content-Type': 'application/json' }, body: JSON.stringify({ p_line_id: lineId, p_user_id: auth.user.id, p_user_name: auth.user.display_name, p_review_note: note }), signal: AbortSignal.timeout(10000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(data.message || data.error || 'Could not approve adjustment.');
      return res.json({ ok: true, result: data });
    }
    if (!['recount', 'dismiss'].includes(action)) return res.status(400).json({ ok: false, error: 'Choose approve, recount, or dismiss.' });
    const payload = action === 'recount' ? { status: 'pending', counted_quantity: null, counted_by_user_id: null, counted_by_name: null, counted_at: null, note: note || null, review_status: 'pending' } : { review_status: 'dismissed', reviewed_at: new Date().toISOString(), reviewed_by_user_id: auth.user.id, reviewed_by_name: auth.user.display_name, review_note: note || null };
    const response = await fetch(url + '/rest/v1/cycle_count_lines?id=eq.' + lineId, { method: 'PATCH', headers: { ...jsonHeaders(key), 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw Error('Could not update the variance.');
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'cycle_count_review_failed' });
  }
};
