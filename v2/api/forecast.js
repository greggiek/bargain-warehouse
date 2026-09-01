const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

module.exports = async function forecast(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ ok:false,error:'method_not_allowed' }); }
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok:false,error:auth.error });
  try {
    const q = new URL(req.url || '/', 'http://localhost').searchParams;
    const number = (name, fallback) => Number.isFinite(Number(q.get(name))) ? Number(q.get(name)) : fallback;
    const body = {
      p_history_days: Math.max(1, Math.min(120, Math.round(number('historyDays', 90)))),
      p_growth: number('growth', 10) / 100,
      p_coverage_days: Math.max(0, Math.round(number('coverageDays', 90))),
      p_safety_days: Math.max(0, Math.round(number('safetyStockDays', 14))),
      p_category: String(q.get('category') || '').trim() || null
    };
    const { url, serviceRoleKey } = configuration();
    const response = await fetch(url + '/rest/v1/rpc/forecast_v2_read_model', {
      method:'POST', headers:jsonHeaders(serviceRoleKey), body:JSON.stringify(body), signal:AbortSignal.timeout(30000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Forecast read model failed');
    res.setHeader('Cache-Control','private, no-store');
    return res.status(200).json(data);
  } catch (error) { return res.status(500).json({ ok:false,error:error.message || 'forecast_failed' }); }
};