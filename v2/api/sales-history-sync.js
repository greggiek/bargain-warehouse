const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');
const API_VERSION = '2026-07';
const cleanDomain = value => String(value || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');

async function tokenFor(store) {
  const shop = cleanDomain(store.domain); if (!shop || !store.clientId || !store.clientSecret) throw new Error(`${store.key}: missing Shopify environment variables`);
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type:'client_credentials', client_id:store.clientId, client_secret:store.clientSecret }) });
  const body = await response.json().catch(() => ({})); if (!response.ok || !body.access_token) throw new Error(`${store.key}: Shopify token request failed`); return { shop, token: body.access_token };
}
async function graphql(shop, token, query, variables) {
  const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, { method:'POST', headers:{ 'Content-Type':'application/json', Accept:'application/json', 'X-Shopify-Access-Token':token }, body:JSON.stringify({query,variables}), signal:AbortSignal.timeout(30000) });
  const body = await response.json().catch(() => ({})); if (!response.ok || body.errors?.length) throw new Error(body.errors?.map(x => x.message).join('; ') || `Shopify GraphQL request failed (${response.status})`); return body.data;
}
async function collectSales(store, startDate, endDate) {
  const { shop, token } = await tokenFor(store), totals = new Map(); let cursor = null, page = 0, orders = 0, lines = 0, hasNextPage = true;
  const query = `query BMSales($cursor: String, $query: String!) { orders(first: 100, after: $cursor, query: $query, sortKey: PROCESSED_AT) { pageInfo { hasNextPage endCursor } nodes { processedAt cancelledAt lineItems(first: 250) { nodes { sku quantity originalUnitPriceSet { shopMoney { amount } } } } } } }`;
  while (hasNextPage && page++ < 100) {
    const data = await graphql(shop, token, query, { cursor, query: 'processed_at:>=' + startDate + ' processed_at:<' + endDate + ' status:any' }); const connection = data.orders; if (!connection) throw new Error(`${store.key}: orders connection missing`);
    for (const order of connection.nodes || []) { if (order.cancelledAt || !order.processedAt) continue; orders++; const date = order.processedAt.slice(0, 10); for (const line of order.lineItems?.nodes || []) { const sku = String(line.sku || '').trim().toUpperCase(); if (!sku || Number(line.quantity || 0) <= 0) continue; const key = `${date}|${sku}`, old = totals.get(key) || { sales_date:date, sku, quantity_sold:0, order_count:0, gross_sales:0 }; old.quantity_sold += Number(line.quantity); old.order_count += 1; old.gross_sales += Number(line.originalUnitPriceSet?.shopMoney?.amount || 0) * Number(line.quantity); totals.set(key, old); lines++; } }
    hasNextPage = Boolean(connection.pageInfo?.hasNextPage); cursor = connection.pageInfo?.endCursor || null;
  }
  if (hasNextPage) throw new Error(`${store.key}: Shopify order history exceeded safe page limit`); return { totals:[...totals.values()], orders, lines };
}
module.exports = async function salesHistorySync(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow','POST'); return res.status(405).json({ok:false,error:'method_not_allowed'}); }
  const auth = await requireUser(req); if (!auth.ok) return res.status(auth.status).json({ok:false,error:auth.error}); if (!['admin','developer'].includes(auth.user.role)) return res.status(403).json({ok:false,error:'administrator_role_required'});
  try {
    const mode = String(req.body?.mode || 'daily');
    const days = Number(req.body?.days) === 3 ? 3 : 1;
    const isDate = value => /^\\d{4}-\\d{2}-\\d{2}$/.test(String(value || ''));
    const shiftDate = (value, offset) => new Date(new Date(value + 'T00:00:00Z').getTime() + offset * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const { url, serviceRoleKey } = configuration(), headers = jsonHeaders(serviceRoleKey);
    let endDate = isDate(req.body?.endDate) ? String(req.body.endDate) : today;
    if (mode === 'next') {
      const progressResponse = await fetch(url + '/rest/v1/shopify_sales_sync_windows?status=eq.completed&select=window_start&order=window_start.asc&limit=1', { headers, signal: AbortSignal.timeout(10000) });
      const progress = await progressResponse.json();
      if (!progressResponse.ok) throw new Error('Could not load sales backfill progress');
      endDate = progress[0]?.window_start || today;
    }
    const startDate = shiftDate(endDate, -days);
    if (startDate >= endDate) throw new Error('Invalid sales sync window');
    const stores = [{key:'store_1',domain:process.env.SHOPIFY_STORE_1_DOMAIN,clientId:process.env.SHOPIFY_STORE_1_CLIENT_ID,clientSecret:process.env.SHOPIFY_STORE_1_CLIENT_SECRET},{key:'store_2',domain:process.env.SHOPIFY_STORE_2_DOMAIN,clientId:process.env.SHOPIFY_STORE_2_CLIENT_ID,clientSecret:process.env.SHOPIFY_STORE_2_CLIENT_SECRET}];
    const results = []; for (const store of stores) results.push({ store, ...(await collectSales(store, startDate, endDate)) });
    const products = []; for (let offset=0;;offset+=1000) { const response = await fetch(`${url}/rest/v1/products?select=id,sku&limit=1000&offset=${offset}`,{headers,signal:AbortSignal.timeout(12000)}); const page=await response.json(); if(!response.ok) throw new Error('V2 product lookup failed'); products.push(...page); if(page.length<1000) break; }
    const bySku = new Map(products.map(p=>[String(p.sku).trim().toUpperCase(),p.id])), rows=[]; let skipped=0;
    results.forEach(result => result.totals.forEach(total => { const productId = bySku.get(total.sku); if(!productId){skipped++;return;} rows.push({sales_date:total.sales_date,product_id:productId,store_key:result.store.key,quantity_sold:total.quantity_sold,order_count:total.order_count,gross_sales:total.gross_sales,last_synced_at:new Date().toISOString()}); }));
    const purge = await fetch(url + '/rest/v1/shopify_sales_daily?sales_date=gte.' + startDate + '&sales_date=lt.' + endDate, {method:'DELETE',headers,signal:AbortSignal.timeout(15000)}); if(!purge.ok) throw new Error('Could not refresh sales mirror');
    for(let i=0;i<rows.length;i+=500){ const response=await fetch(`${url}/rest/v1/shopify_sales_daily?on_conflict=sales_date,product_id,store_key`,{method:'POST',headers:{...headers,Prefer:'resolution=merge-duplicates'},body:JSON.stringify(rows.slice(i,i+500)),signal:AbortSignal.timeout(30000)}); if(!response.ok) throw new Error('Could not save Shopify sales mirror'); }
    const orders = results.reduce((n,x)=>n+x.orders,0), lines = results.reduce((n,x)=>n+x.lines,0);
    const checkpoint = await fetch(url + '/rest/v1/shopify_sales_sync_windows?on_conflict=window_start,window_end', { method:'POST', headers:{...headers,Prefer:'resolution=merge-duplicates'}, body:JSON.stringify([{window_start:startDate,window_end:endDate,status:'completed',orders,lines,mirrored:rows.length,completed_at:new Date().toISOString()}]), signal:AbortSignal.timeout(15000) });
    if (!checkpoint.ok) throw new Error('Could not save sales backfill progress');
    return res.status(200).json({ok:true,mode,days,startDate,endDate,orders,lines,mirrored:rows.length,skipped});
  } catch(error) { console.error('Shopify sales history sync failed',error); return res.status(500).json({ok:false,error:error.message||'sales_sync_failed'}); }
};
