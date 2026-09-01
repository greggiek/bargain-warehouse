const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const API_VERSION = '2026-07';
const clean = value => String(value || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const stores = () => [
  { key: 'store_1', label: 'Shopify NY', domain: process.env.SHOPIFY_STORE_1_DOMAIN, clientId: process.env.SHOPIFY_STORE_1_CLIENT_ID, clientSecret: process.env.SHOPIFY_STORE_1_CLIENT_SECRET },
  { key: 'store_2', label: 'Shopify CT', domain: process.env.SHOPIFY_STORE_2_DOMAIN, clientId: process.env.SHOPIFY_STORE_2_CLIENT_ID, clientSecret: process.env.SHOPIFY_STORE_2_CLIENT_SECRET }
];

async function gql(store, query, variables, telemetry) {
  const shop = clean(store.domain);
  if (!shop || !store.clientId || !store.clientSecret) throw new Error(store.label + ': Shopify connection is not configured.');
  const tokenResponse = await fetch('https://' + shop + '/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: store.clientId, client_secret: store.clientSecret }),
    signal: AbortSignal.timeout(20000)
  });
  const tokenBody = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenBody.access_token) throw new Error(store.label + ': Shopify token request failed.');

  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch('https://' + shop + '/admin/api/' + API_VERSION + '/graphql.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': tokenBody.access_token },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30000)
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
        throw new Error(body.errors?.map(error => error.message).join('; ') || store.label + ': Shopify request failed.');
      }
      return body.data;
    } catch (error) {
      lastError = error;
      if (attempt === 4) break;
      telemetry.retryEvents++;
      await wait(Math.min(1000 * 2 ** attempt + Math.floor(Math.random() * 500), 10000));
    }
  }
  throw lastError || new Error(store.label + ': Shopify request failed after retries.');
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

async function permission(req) {
  const cron = req.method === 'GET' && Boolean(process.env.CRON_SECRET) &&
    String(req.headers?.authorization || '') === 'Bearer ' + process.env.CRON_SECRET;
  if (cron) return { mode: 'cron' };
  if (req.method !== 'POST') return null;
  const auth = await requireUser(req);
  if (!auth.ok) return { status: auth.status, error: auth.error };
  if (!['admin', 'developer'].includes(auth.user.role)) return { status: 403, error: 'administrator_role_required' };
  return { mode: 'manual' };
}

module.exports = async function shopifyInventorySync(req, res) {
  const allowed = await permission(req);
  if (!allowed) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (allowed.error) return res.status(allowed.status).json({ ok: false, error: allowed.error });

  let job = null;
  let leaseToken = null;
  const telemetry = { throttleEvents: 0, retryEvents: 0 };
  try {
    const { url, serviceRoleKey } = configuration();
    const headers = jsonHeaders(serviceRoleKey);
    const stateResponse = await fetch(url + '/rest/v1/shopify_inventory_sync_state?select=store_key,cursor,cycle_started_at,last_synced_at&order=last_synced_at.asc.nullsfirst&limit=1', {
      headers, signal: AbortSignal.timeout(10000)
    });
    const states = await stateResponse.json().catch(() => []);
    if (!stateResponse.ok || !states[0]) throw new Error('Could not load Shopify inventory sync state.');
    const state = states[0];
    const store = stores().find(entry => entry.key === state.store_key);
    if (!store) throw new Error('Unknown Shopify sync store.');

    const active = await rest(url, serviceRoleKey,
      'shopify_sync_jobs?store_key=eq.' + store.key +
      '&job_type=eq.inventory_snapshot&status=in.(queued,running)&select=*&order=created_at.desc&limit=1');
    job = active[0];
    if (!job) {
      const created = await rest(url, serviceRoleKey, 'rpc/begin_shopify_sync_job', {
        method: 'POST',
        body: JSON.stringify({ p_store_key: store.key, p_job_type: 'inventory_snapshot', p_window_start: null, p_window_end: null })
      });
      const jobId = typeof created === 'string' ? created : created?.[0] || created;
      const loaded = await rest(url, serviceRoleKey, 'shopify_sync_jobs?id=eq.' + encodeURIComponent(jobId) + '&select=*&limit=1');
      job = loaded[0];
    }
    if (!job) throw new Error('Could not create or resume the Shopify inventory job.');

    leaseToken = await rest(url, serviceRoleKey, 'rpc/claim_shopify_sync_job', {
      method: 'POST',
      body: JSON.stringify({ p_job_id: job.id, p_lease_seconds: 240 })
    });

    const started = state.cycle_started_at || new Date().toISOString();
    const cycleKey = started.replace(/[^0-9]/g, '').slice(0, 14);
    const query = `query($after:String) {
      inventoryItems(first:25, after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id sku updatedAt
          variant { id }
          inventoryLevels(first:20) {
            nodes {
              location { id }
              quantities(names:["on_hand","available","committed"]) { name quantity }
            }
          }
        }
      }
    }`;
    const data = await gql(store, query, { after: state.cursor || null }, telemetry);
    const connection = data.inventoryItems;
    if (!connection) throw new Error(store.label + ': inventory page is unavailable.');

    const items = (connection.nodes || []).map(item => ({
      inventoryItemId: item.id,
      variantId: item.variant?.id || null,
      sku: item.sku || '',
      sourceUpdatedAt: item.updatedAt || null,
      levels: (item.inventoryLevels?.nodes || []).map(level => {
        const quantities = Object.fromEntries((level.quantities || []).map(value => [value.name, Number(value.quantity || 0)]));
        return {
          locationId: level.location?.id,
          onHand: quantities.on_hand || 0,
          available: quantities.available || 0,
          committed: quantities.committed || 0
        };
      }).filter(level => level.locationId)
    }));

    const cacheSummary = await rest(url, serviceRoleKey, 'rpc/upsert_shopify_inventory_cache_page', {
      method: 'POST',
      body: JSON.stringify({ p_store_key: store.key, p_items: items })
    });
    const operationalSummary = await rest(url, serviceRoleKey, 'rpc/apply_v2_shopify_inventory_sync_page', {
      method: 'POST',
      body: JSON.stringify({ p_store_key: store.key, p_cycle_key: cycleKey, p_items: items })
    });

    const complete = !connection.pageInfo?.hasNextPage;
    const now = new Date().toISOString();
    const statePatch = {
      cursor: complete ? null : connection.pageInfo.endCursor,
      cycle_started_at: complete ? null : started,
      last_synced_at: now,
      last_error: null,
      updated_at: now
    };
    if (complete) statePatch.last_completed_at = now;
    await rest(url, serviceRoleKey, 'shopify_inventory_sync_state?store_key=eq.' + store.key, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(statePatch)
    });

    const checkpoint = {
      ...(job.checkpoint || {}),
      pagesProcessed: Number(job.checkpoint?.pagesProcessed || 0) + 1,
      unmappedSkus: Number(job.checkpoint?.unmappedSkus || 0) + Number(cacheSummary.unmappedSkus || 0),
      unmappedLocations: Number(job.checkpoint?.unmappedLocations || 0) + Number(cacheSummary.unmappedLocations || 0),
      lastPageAt: now
    };
    await rest(url, serviceRoleKey, 'shopify_sync_jobs?id=eq.' + job.id, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: complete ? 'completed' : 'running',
        cursor: complete ? null : connection.pageInfo.endCursor,
        checkpoint,
        throttle_events: Number(job.throttle_events || 0) + telemetry.throttleEvents,
        retry_events: Number(job.retry_events || 0) + telemetry.retryEvents,
        completed_at: complete ? now : null,
        last_error: null,
        updated_at: now
      })
    });

    await rest(url, serviceRoleKey, 'shopify_inventory_sync_runs', {
      method: 'POST',
      body: JSON.stringify({
        store_key: store.key,
        cycle_key: cycleKey,
        cursor_before: state.cursor || null,
        cursor_after: complete ? null : connection.pageInfo.endCursor,
        scanned_items: items.length,
        applied_levels: Number(cacheSummary.appliedLevels || 0),
        changed_levels: Number(operationalSummary.changedLevels || 0),
        skipped_items: Number(cacheSummary.unmappedSkus || 0) + Number(cacheSummary.unmappedLocations || 0),
        completed_cycle: complete
      })
    });

    await rest(url, serviceRoleKey, 'rpc/release_shopify_sync_job', {
      method: 'POST',
      body: JSON.stringify({ p_job_id: job.id, p_lease_token: leaseToken })
    });
    leaseToken = null;

    return res.json({
      ok: true,
      mode: allowed.mode,
      direction: 'shopify_to_bm_warehouse',
      writesToShopify: false,
      store: store.label,
      scannedItems: items.length,
      cache: cacheSummary,
      operationalBalances: operationalSummary,
      throttleEvents: telemetry.throttleEvents,
      retryEvents: telemetry.retryEvents,
      completedCycle: complete
    });
  } catch (error) {
    console.error('Shopify inventory sync failed', error);
    try {
      if (job?.id) {
        const { url, serviceRoleKey } = configuration();
        await rest(url, serviceRoleKey, 'shopify_sync_jobs?id=eq.' + job.id, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'running',
            last_error: error.message || 'shopify_inventory_sync_failed',
            throttle_events: Number(job.throttle_events || 0) + telemetry.throttleEvents,
            retry_events: Number(job.retry_events || 0) + telemetry.retryEvents,
            updated_at: new Date().toISOString()
          })
        });
        if (leaseToken) {
          await rest(url, serviceRoleKey, 'rpc/release_shopify_sync_job', {
            method: 'POST',
            body: JSON.stringify({ p_job_id: job.id, p_lease_token: leaseToken })
          });
        }
      }
    } catch (patchError) {
      console.error('Could not save Shopify inventory job error', patchError);
    }
    return res.status(500).json({ ok: false, error: error.message || 'shopify_inventory_sync_failed', jobId: job?.id || null, resumable: Boolean(job?.id) });
  }
};
