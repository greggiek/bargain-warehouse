const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const DAILY_COUNT_ROLES = new Set(['warehouse', 'manager', 'admin', 'developer']);
const clean = (value, max = 500) => String(value || '').trim().slice(0, max);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

async function authorizedLocations(url, key, userId) {
  const response = await fetch(url + '/rest/v1/user_location_access?user_id=eq.' + encodeURIComponent(userId) + '&select=location_id,locations(id,name,active)', { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Error('location access lookup failed');
  return (await response.json()).filter(row => row.locations?.active).map(row => ({ id: Number(row.location_id), name: row.locations.name })).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

async function findRun(url, key, locationId, businessDate) {
  const response = await fetch(url + '/rest/v1/cycle_count_runs?location_id=eq.' + locationId + '&business_date=eq.' + encodeURIComponent(businessDate) + '&select=id&order=id.desc&limit=1', { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  const rows = await response.json().catch(() => []);
  if (!response.ok) throw Error(rows.message || 'Could not look up today’s cycle count.');
  return rows.length ? Number(rows[0].id) : null;
}

async function openRun(url, key, locationId, user, businessDate) {
  const response = await fetch(url + '/rest/v1/rpc/open_v2_daily_cycle_count', { method: 'POST', headers: { ...jsonHeaders(key), 'Content-Type': 'application/json' }, body: JSON.stringify({ p_location_id: locationId, p_business_date: businessDate, p_target_count: 5, p_user_id: user.id, p_user_name: user.display_name }), signal: AbortSignal.timeout(10000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.message || data.error || 'Could not start today’s cycle count.');
  return Number(data);
}

async function runPayload(url, key, runId) {
  const response = await fetch(url + '/rest/v1/cycle_count_runs?id=eq.' + runId + '&select=id,location_id,business_date,status,target_count,submitted_at,reviewed_at,reviewed_by_name,locations(name),cycle_count_lines(id,product_id,expected_quantity,counted_quantity,status,review_status,counted_by_name,counted_at,note,current_attempt_id,products(sku,name,barcode))&limit=1', { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  const rows = await response.json().catch(() => []);
  if (!response.ok || !rows.length) throw Error(rows.message || 'Cycle count not found.');
  const run = rows[0];
  run.lines = (run.cycle_count_lines || []).sort((a, b) => (a.products?.sku || '').localeCompare(b.products?.sku || ''));
  delete run.cycle_count_lines;
  return run;
}

module.exports = async (req, res) => {
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  if (!DAILY_COUNT_ROLES.has(auth.user.role)) return res.status(403).json({ ok: false, error: 'daily_count_access_required' });
  try {
    const { url, serviceRoleKey: key } = configuration();
    const locations = await authorizedLocations(url, key, auth.user.id);
    if (!locations.length) return res.status(403).json({ ok: false, error: 'No active warehouse location is assigned to you.' });
    const requested = Number(req.query?.locationId || req.body?.locationId || locations[0].id);
    if (!locations.some(location => location.id === requested)) return res.status(403).json({ ok: false, error: 'You can count only at an assigned active warehouse.' });
    const businessDate = today();
    const existingRunId = await findRun(url, key, requested, businessDate);
    if (req.method === 'GET') return res.json({ ok: true, locations, businessDate, run: existingRunId ? await runPayload(url, key, existingRunId) : null });
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ ok: false, error: 'method_not_allowed' }); }
    const action = clean(req.body?.action, 20);
    if (action === 'start') {
      const runId = existingRunId || await openRun(url, key, requested, auth.user, businessDate);
      return res.json({ ok: true, locations, businessDate, run: await runPayload(url, key, runId) });
    }
    if (action !== 'save') return res.status(400).json({ ok: false, error: 'Choose start or save.' });
    if (!existingRunId) return res.status(409).json({ ok: false, error: 'Start today’s count before saving.' });
    const lineId = Number(req.body?.lineId), counted = Number(req.body?.countedQuantity), note = clean(req.body?.note), idempotencyKey = clean(req.body?.idempotencyKey, 160);
    if (!Number.isInteger(lineId) || !Number.isFinite(counted) || counted < 0) return res.status(400).json({ ok: false, error: 'Enter a physical count of zero or more.' });
    if (!idempotencyKey) return res.status(400).json({ ok: false, error: 'Save request identity is required.' });
    const response = await fetch(url + '/rest/v1/rpc/submit_v2_cycle_count_attempt', {
      method: 'POST',
      headers: { ...jsonHeaders(key), 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_line_id: lineId, p_counted_quantity: counted, p_note: note || null, p_actor_user_id: auth.user.id, p_idempotency_key: idempotencyKey }),
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(result.message || result.error || 'Could not save physical count.');
    if (Number(result.runId) !== existingRunId) throw Error('Saved count belongs to a different run.');
    return res.json({ ok: true, locations, businessDate, run: await runPayload(url, key, existingRunId), result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'daily_cycle_count_failed' });
  }
};
