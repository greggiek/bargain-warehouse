const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const API_VERSION = '2026-07';
const BUSINESS_TIME_ZONE = 'America/New_York';
const clean = value => String(value || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const stores = () => [
  { key: 'store_1', label: 'Shopify NY', domain: process.env.SHOPIFY_STORE_1_DOMAIN, clientId: process.env.SHOPIFY_STORE_1_CLIENT_ID, clientSecret: process.env.SHOPIFY_STORE_1_CLIENT_SECRET },
  { key: 'store_2', label: 'Shopify CT', domain: process.env.SHOPIFY_STORE_2_DOMAIN, clientId: process.env.SHOPIFY_STORE_2_CLIENT_ID, clientSecret: process.env.SHOPIFY_STORE_2_CLIENT_SECRET }
];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const dateInZone = value => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value));
  const get = type => parts.find(part => part.type === type)?.value;
  return get('year') + '-' + get('month') + '-' + get('day');
};
const shiftDate = (value, offset) =>
  new Date(new Date(value + 'T12:00:00Z').getTime() + offset * 86400000).toISOString().slice(0, 10);
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

async function accessToken(store) {
  const shop = clean(store.domain);
  if (!shop || !store.clientId || !store.clientSecret) throw new Error(store.label + ': Shopify connection is not configured.');
  const response = await fetch('https://' + shop + '/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: store.clientId, client_secret: store.clientSecret }),
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(store.label + ': Shopify token request failed.');
  return { shop, token: body.access_token };
}

async function graphql(shop, token, query, variables, telemetry) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch('https://' + shop + '/admin/api/' + API_VERSION + '/graphql.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(45000)
      });
      const body = await response.json().catch(() => ({}));
      const throttled = response.status === 429 || body.errors?.some(error => error.extensions?.code === 'THROTTLED');
      if (throttled) {
        telemetry.throttleEvents++;
        telemetry.retryEvents++;
        await wait(Math.min(1000 * 2 ** attempt + Math.floor(Math.random() * 500), 10000));
        continue;
      }
      if (!response.ok || body.errors?.length) {
        throw new Error(body.errors?.map(error => error.message).join('; ') || 'Shopify GraphQL request failed (' + response.status + ')');
      }
      const throttle = body.extensions?.cost?.throttleStatus;
      if (throttle && Number(throttle.currentlyAvailable) < 100) {
        telemetry.throttleEvents++;
        const restoreRate = Math.max(Number(throttle.restoreRate || 50), 1);
        await wait(Math.min(Math.ceil((100 - Number(throttle.currentlyAvailable)) / restoreRate * 1000), 5000));
      }
      return body.data;
    } catch (error) {
      lastError = error;
      if (attempt === 4) break;
      telemetry.retryEvents++;
      await wait(Math.min(1000 * 2 ** attempt + Math.floor(Math.random() * 500), 10000));
    }
  }
  throw lastError || new Error('Shopify request failed after retries.');
}

async function rest(url, key, path, options = {}) {
  const response = await fetch(url + '/rest/v1/' + path, {
    ...options,
    headers: { ...jsonHeaders(key), ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeout || 30000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || 'Database request failed: ' + path);
  return body;
}

async function patchJob(url, key, id, patch) {
  await rest(url, key, 'shopify_sync_jobs?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  });
}

function fulfillmentRows(orders, windowStart, windowEnd) {
  const rows = [];
  for (const order of orders || []) {
    if (order.cancelledAt) continue;
    for (const fulfillment of order.fulfillments || []) {
      if (fulfillment.status !== 'SUCCESS' || !fulfillment.createdAt) continue;
      const salesDate = dateInZone(fulfillment.createdAt);
      if (salesDate < windowStart || salesDate >= windowEnd) continue;
      for (const line of fulfillment.fulfillmentLineItems?.nodes || []) {
        const sku = String(line.lineItem?.sku || '').trim().toUpperCase();
        const quantity = Number(line.quantity || 0);
        if (!sku || quantity <= 0 || !line.id) continue;
        rows.push({
          shopifyOrderId: order.id,
          shopifyLineId: line.id,
          salesDate,
          sku,
          grossFulfilledQuantity: quantity,
          shopifyUpdatedAt: fulfillment.updatedAt || order.updatedAt
        });
      }
    }
  }
  return rows;
}

module.exports = async function salesCacheSync(req, res) {
  const cron = req.method === 'GET' && Boolean(process.env.CRON_SECRET) &&
    String(req.headers?.authorization || '') === 'Bearer ' + process.env.CRON_SECRET;
  if (!cron && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!cron) {
    const auth = await requireUser(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    if (!['admin', 'developer'].includes(auth.user.role)) {
      return res.status(403).json({ ok: false, error: 'administrator_role_required' });
    }
  }

  const input = req.method === 'GET'
    ? new URL(req.url || '/', 'http://localhost').searchParams
    : req.body || {};
  const get = name => input instanceof URLSearchParams ? input.get(name) : input[name];
  const storeKey = String(get('storeKey') || '').trim();
  const jobType = String(get('jobType') || 'sales_backfill').trim();
  const store = stores().find(entry => entry.key === storeKey);
  if (!store) return res.status(400).json({ ok: false, error: 'Choose store_1 or store_2.' });
  if (!['sales_backfill', 'sales_incremental'].includes(jobType)) {
    return res.status(400).json({ ok: false, error: 'Unsupported sales sync job type.' });
  }

  const today = dateInZone(new Date());
  const defaultStart = shiftDate(today, -120);
  const windowStart = validDate(get('windowStart')) ? String(get('windowStart')) : defaultStart;
  const windowEnd = validDate(get('windowEnd')) ? String(get('windowEnd')) : today;
  if (windowStart >= windowEnd) return res.status(400).json({ ok: false, error: 'Invalid synchronization window.' });

  const telemetry = { throttleEvents: 0, retryEvents: 0 };
  let job;
  let leaseToken = null;
  try {
    const { url, serviceRoleKey } = configuration();
    const active = await rest(url, serviceRoleKey,
      'shopify_sync_jobs?store_key=eq.' + storeKey + '&job_type=eq.' + jobType +
      '&status=in.(queued,running)&select=*&order=created_at.desc&limit=1');
    job = active[0];

    if (!job && jobType === 'sales_backfill') {
      const completedCoverage = await rest(url, serviceRoleKey,
        'shopify_sales_coverage?store_key=eq.' + storeKey +
        '&sales_date=gte.' + windowStart + '&sales_date=lt.' + windowEnd +
        '&status=in.(completed_with_sales,completed_zero_sales)&select=sales_date');
      const requiredDays = Math.round((new Date(windowEnd + 'T00:00:00Z') - new Date(windowStart + 'T00:00:00Z')) / 86400000);
      if (completedCoverage.length >= requiredDays) {
        return res.status(200).json({
          ok: true,
          store: store.label,
          storeKey,
          windowStart,
          windowEnd,
          completed: true,
          alreadyComplete: true,
          completedDays: completedCoverage.length
        });
      }
    }

    if (!job) {
      const created = await rest(url, serviceRoleKey, 'rpc/begin_shopify_sync_job', {
        method: 'POST',
        body: JSON.stringify({
          p_store_key: storeKey,
          p_job_type: jobType,
          p_window_start: windowStart,
          p_window_end: windowEnd
        })
      });
      const jobId = typeof created === 'string' ? created : created?.[0] || created;
      const loaded = await rest(url, serviceRoleKey, 'shopify_sync_jobs?id=eq.' + encodeURIComponent(jobId) + '&select=*&limit=1');
      job = loaded[0];
      const coverage = [];
      for (let day = windowStart; day < windowEnd; day = shiftDate(day, 1)) {
        coverage.push({ store_key: storeKey, sales_date: day, status: 'pending', last_synchronized_at: new Date().toISOString() });
      }
      for (let i = 0; i < coverage.length; i += 100) {
        await rest(url, serviceRoleKey, 'shopify_sales_coverage?on_conflict=store_key,sales_date', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(coverage.slice(i, i + 100))
        });
      }
    }

    if (!job) throw new Error('Could not create or resume the Shopify sales job.');
    if (job.window_start !== windowStart || job.window_end !== windowEnd) {
      return res.status(409).json({
        ok: false,
        error: 'An active job already exists with a different date window.',
        job: { id: job.id, windowStart: job.window_start, windowEnd: job.window_end }
      });
    }

    leaseToken = await rest(url, serviceRoleKey, 'rpc/claim_shopify_sync_job', {
      method: 'POST',
      body: JSON.stringify({ p_job_id: job.id, p_lease_seconds: 300 })
    });

    const { shop, token } = await accessToken(store);
    const query = `query BMFulfilledSales($cursor: String, $query: String!) {
      orders(first: 100, after: $cursor, query: $query, sortKey: UPDATED_AT) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id updatedAt cancelledAt
          fulfillments(first: 100) {
            id status createdAt updatedAt
            fulfillmentLineItems(first: 250) {
              nodes { id quantity lineItem { id sku } }
            }
          }
        }
      }
    }`;
    const shopifyQuery = 'updated_at:>=' + shiftDate(job.window_start, -2) + ' status:any';
    const data = await graphql(shop, token, query, { cursor: job.cursor || null, query: shopifyQuery }, telemetry);
    const connection = data.orders;
    if (!connection) throw new Error(store.label + ': Shopify orders connection was unavailable.');

    const orders = connection.nodes || [];
    const lines = fulfillmentRows(orders, job.window_start, job.window_end);
    let ingestion = { inserted: 0, updated: 0, duplicatesPrevented: 0, unmappedSkus: 0 };
    if (lines.length) {
      ingestion = await rest(url, serviceRoleKey, 'rpc/upsert_shopify_sales_dedup_page', {
        method: 'POST',
        body: JSON.stringify({ p_store_key: storeKey, p_rows: lines })
      });
    }

    const oldCheckpoint = job.checkpoint || {};
    const checkpoint = {
      ...oldCheckpoint,
      pagesProcessed: Number(oldCheckpoint.pagesProcessed || 0) + 1,
      unmappedSkus: Number(oldCheckpoint.unmappedSkus || 0) + Number(ingestion.unmappedSkus || 0),
      lastPageAt: new Date().toISOString()
    };
    const hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
    await patchJob(url, serviceRoleKey, job.id, {
      status: 'running',
      cursor: hasNextPage ? connection.pageInfo.endCursor : null,
      checkpoint,
      processed_orders: Number(job.processed_orders || 0) + orders.length,
      processed_fulfillment_lines: Number(job.processed_fulfillment_lines || 0) + lines.length,
      duplicate_records_prevented: Number(job.duplicate_records_prevented || 0) + Number(ingestion.duplicatesPrevented || 0),
      throttle_events: Number(job.throttle_events || 0) + telemetry.throttleEvents,
      retry_events: Number(job.retry_events || 0) + telemetry.retryEvents,
      last_error: null
    });

    let finalization = null;
    if (!hasNextPage) {
      finalization = await rest(url, serviceRoleKey, 'rpc/finalize_shopify_sales_sync_job', {
        method: 'POST',
        body: JSON.stringify({ p_job_id: job.id })
      });
    }

    await rest(url, serviceRoleKey, 'rpc/release_shopify_sync_job', {
      method: 'POST',
      body: JSON.stringify({ p_job_id: job.id, p_lease_token: leaseToken })
    });
    leaseToken = null;

    return res.status(200).json({
      ok: true,
      store: store.label,
      storeKey,
      jobId: job.id,
      windowStart: job.window_start,
      windowEnd: job.window_end,
      pageOrders: orders.length,
      pageFulfillmentLines: lines.length,
      ingestion,
      throttleEvents: telemetry.throttleEvents,
      retryEvents: telemetry.retryEvents,
      hasNextPage,
      nextCursor: hasNextPage ? connection.pageInfo.endCursor : null,
      completed: !hasNextPage,
      finalization
    });
  } catch (error) {
    console.error('Lean Shopify sales cache sync failed', error);
    try {
      if (job?.id) {
        const { url, serviceRoleKey } = configuration();
        await patchJob(url, serviceRoleKey, job.id, {
          status: 'running',
          last_error: error.message || 'sales_cache_sync_failed',
          throttle_events: Number(job.throttle_events || 0) + telemetry.throttleEvents,
          retry_events: Number(job.retry_events || 0) + telemetry.retryEvents
        });
        if (leaseToken) {
          await rest(url, serviceRoleKey, 'rpc/release_shopify_sync_job', {
            method: 'POST',
            body: JSON.stringify({ p_job_id: job.id, p_lease_token: leaseToken })
          });
          leaseToken = null;
        }
      }
    } catch (patchError) {
      console.error('Could not save Shopify sales job error', patchError);
    }
    return res.status(500).json({
      ok: false,
      error: error.message || 'sales_cache_sync_failed',
      jobId: job?.id || null,
      resumable: Boolean(job?.id)
    });
  }
};
