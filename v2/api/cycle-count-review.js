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

async function authorizedLine(url, key, allowed, lineId) {
  const allowedFilter = 'in.(' + allowed.join(',') + ')';
  const query = '/rest/v1/cycle_count_lines?id=eq.' + lineId + '&select=id,run_id,cycle_count_runs!inner(location_id)&cycle_count_runs.location_id=' + encodeURIComponent(allowedFilter) + '&limit=1';
  const response = await fetch(url + query, { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  const rows = await response.json().catch(() => []);
  if (!response.ok) throw Error(rows.message || 'Could not verify this variance.');
  return rows[0] || null;
}

async function attemptHistory(url, key, lineId) {
  const query = '/rest/v1/activity_events?document_type=eq.cycle_count&metadata->>cycleCountLineId=eq.' + lineId + '&select=id,action_type,user_name,description,status,metadata,created_at&order=created_at.asc,id.asc&limit=100';
  const response = await fetch(url + query, { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  const rows = await response.json().catch(() => []);
  if (!response.ok) throw Error(rows.message || 'Could not load count history.');
  return rows;
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
      const historyLineId = Number(req.query?.historyLineId);
      if (Number.isInteger(historyLineId) && historyLineId > 0) {
        if (!await authorizedLine(url, key, allowed, historyLineId)) return res.status(404).json({ ok: false, error: 'Count item not found or not assigned to your warehouse.' });
        return res.json({ ok: true, lineId: historyLineId, history: await attemptHistory(url, key, historyLineId) });
      }
      const pending = await pendingLines(url, key, allowed);
      return res.json({ ok: true, lines: pending.lines, totalPending: pending.totalPending });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ ok: false, error: 'method_not_allowed' }); }
    const lineId = Number(req.body?.lineId), action = clean(req.body?.action, 20), line = await authorizedLine(url, key, allowed, lineId);
    if (!line) return res.status(404).json({ ok: false, error: 'Variance not found or not assigned to your warehouse.' });
    const note = clean(req.body?.note), idempotencyKey = clean(req.body?.idempotencyKey, 160);
    if (!['approve', 'recount', 'dismiss'].includes(action)) return res.status(400).json({ ok: false, error: 'Choose approve, recount, or dismiss.' });
    if (!idempotencyKey) return res.status(400).json({ ok: false, error: 'Resolution request identity is required.' });
    if (action !== 'approve' && !note) return res.status(400).json({ ok: false, error: action === 'recount' ? 'A recount reason is required.' : 'A dismissal reason is required.' });
    const rpc = action === 'approve' ? 'approve_v2_cycle_count_variance' : action === 'recount' ? 'request_v2_cycle_count_recount' : 'dismiss_v2_cycle_count_variance';
    const payload = action === 'approve'
      ? { p_line_id: lineId, p_actor_user_id: auth.user.id, p_actor_name: auth.user.display_name, p_review_note: note || null, p_idempotency_key: idempotencyKey }
      : { p_line_id: lineId, p_actor_user_id: auth.user.id, p_reason: note, p_idempotency_key: idempotencyKey };
    const response = await fetch(url + '/rest/v1/rpc/' + rpc, { method: 'POST', headers: { ...jsonHeaders(key), 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.message || data.error || 'Could not resolve the variance.');
    return res.json({ ok: true, result: data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'cycle_count_review_failed' });
  }
};
