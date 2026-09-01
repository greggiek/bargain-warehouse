const { randomUUID } = require('crypto');
const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const isoDate = date => date.toISOString().slice(0, 10);

async function readUiStatus(url, serviceRoleKey) {
  const through = new Date();
  through.setUTCDate(through.getUTCDate() - 1);
  const start = new Date(through);
  start.setUTCDate(start.getUTCDate() - 119);
  const endpoint = new URL(url + '/rest/v1/shopify_sales_coverage');
  endpoint.searchParams.set('select', 'store_key,sales_date,status,last_synchronized_at');
  endpoint.searchParams.set('sales_date', 'gte.' + isoDate(start));
  endpoint.searchParams.set('order', 'sales_date.asc');
  const response = await fetch(endpoint, {
    headers: jsonHeaders(serviceRoleKey),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('Forecast freshness status failed');
  const rows = await response.json();
  const stores = [...new Set(rows.map(row => row.store_key))];
  const completed = rows.filter(row => String(row.status || '').startsWith('completed_'));
  const dateStores = new Map();
  completed.forEach(row => {
    if (!dateStores.has(row.sales_date)) dateStores.set(row.sales_date, new Set());
    dateStores.get(row.sales_date).add(row.store_key);
  });
  const commonDates = [...dateStores.entries()]
    .filter(([, represented]) => stores.length && represented.size === stores.length)
    .map(([date]) => date)
    .sort();
  const storeSync = stores.map(storeKey => {
    const timestamps = completed
      .filter(row => row.store_key === storeKey && row.last_synchronized_at)
      .map(row => row.last_synchronized_at)
      .sort();
    return {
      storeKey,
      label: storeKey === 'store_1' ? 'Shopify NY' : storeKey === 'store_2' ? 'Shopify CT' : storeKey,
      lastSynchronizedAt: timestamps.at(-1) || null
    };
  });
  return {
    dataCurrentThrough: commonDates.at(-1) || null,
    cacheCoverageDays: commonDates.length,
    cacheCoverageTarget: 120,
    storeSync
  };
}

module.exports = async function forecast(req, res) {
  const requestId = randomUUID();
  const started = Date.now();
  res.setHeader('X-Request-Id', requestId);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed', requestId });
  }
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error, requestId });

  try {
    const q = new URL(req.url || '/', 'http://localhost').searchParams;
    const num = (key, fallback) => Number.isFinite(Number(q.get(key))) ? Number(q.get(key)) : fallback;
    const common = {
      p_history_days: Math.max(1, Math.min(120, Math.round(num('historyDays', 90)))),
      p_growth: num('growth', 10) / 100,
      p_coverage_days: Math.max(0, Math.round(num('coverageDays', 90))),
      p_safety_days: Math.max(0, Math.round(num('safetyStockDays', 14)))
    };
    const detail = String(q.get('detailSku') || '').trim();
    const body = detail
      ? { ...common, p_sku: detail }
      : {
          ...common,
          p_category: String(q.get('category') || '').trim() || null,
          p_search: String(q.get('search') || '').trim() || null,
          p_sort: String(q.get('sort') || 'suggested_desc'),
          p_page: Math.max(1, Math.round(num('page', 1))),
          p_page_size: Math.max(1, Math.min(100, Math.round(num('pageSize', 25))))
        };
    const rpc = detail ? 'forecast_v2_bulk_detail' : 'forecast_v2_page';
    const { url, serviceRoleKey } = configuration();
    const dbStarted = Date.now();
    const forecastRequest = fetch(url + '/rest/v1/rpc/' + rpc, {
      method: 'POST',
      headers: jsonHeaders(serviceRoleKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    const [response, uiStatus] = detail
      ? [await forecastRequest, null]
      : await Promise.all([forecastRequest, readUiStatus(url, serviceRoleKey)]);
    const raw = await response.text();
    const dbMs = Date.now() - dbStarted;
    if (!response.ok) {
      let message = 'Forecast read failed';
      try { message = JSON.parse(raw).message || message; } catch {}
      throw new Error(message);
    }
    const data = JSON.parse(raw);
    const payloadBytes = Buffer.byteLength(raw);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Forecast-Db-Ms', String(dbMs));
    res.setHeader('X-Forecast-Bytes', String(payloadBytes));
    console.log('[forecast]', {
      requestId,
      rpc,
      dbMs,
      bytes: payloadBytes,
      rows: Array.isArray(data.items) ? data.items.length : 1,
      totalMs: Date.now() - started
    });
    return res.status(200).json(detail
      ? { ok: true, item: data, requestId }
      : { ...data, uiStatus, requestId, metrics: { dbMs, payloadBytes } });
  } catch (error) {
    console.error('[forecast]', { requestId, error: String(error), totalMs: Date.now() - started });
    return res.status(500).json({ ok: false, error: error.message || 'forecast_failed', requestId });
  }
};
