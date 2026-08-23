const { requireUser } = require('./_lib/require-user');
const API_VERSION = '2026-07';
const clean = value => String(value || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const stores = () => [
  { key:'store_1', label:'Shopify NY', domain:process.env.SHOPIFY_STORE_1_DOMAIN, clientId:process.env.SHOPIFY_STORE_1_CLIENT_ID, clientSecret:process.env.SHOPIFY_STORE_1_CLIENT_SECRET },
  { key:'store_2', label:'Shopify CT', domain:process.env.SHOPIFY_STORE_2_DOMAIN, clientId:process.env.SHOPIFY_STORE_2_CLIENT_ID, clientSecret:process.env.SHOPIFY_STORE_2_CLIENT_SECRET }
];
async function client(store) {
  const shop = clean(store.domain);
  if (!shop || !store.clientId || !store.clientSecret) throw Error(store.label + ': Shopify connection is not configured');
  const response = await fetch('https://' + shop + '/admin/oauth/access_token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({grant_type:'client_credentials', client_id:store.clientId, client_secret:store.clientSecret}) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw Error(store.label + ': Shopify token request failed');
  return { shop, token:body.access_token };
}
async function graphql(store, query, variables) {
  const { shop, token } = await client(store);
  const response = await fetch('https://' + shop + '/admin/api/' + API_VERSION + '/graphql.json', { method:'POST', headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token}, body:JSON.stringify({query,variables}), signal:AbortSignal.timeout(30000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) throw Error(body.errors?.map(x => x.message).join('; ') || store.label + ': Shopify request failed');
  return body.data;
}
// Receipt lookup stays intentionally read-only. It avoids fulfillmentOrders,
// which requires a separate Shopify scope and is not needed to open a pick ticket.
const orderQuery = `query WarehouseOrder($query:String!){orders(first:1,query:$query){nodes{id name cancelledAt customer{displayName phone} shippingLines(first:10){nodes{title code}} lineItems(first:100){nodes{id name sku quantity fulfillableQuantity}}}}}`;
const number = value => { const found=String(value || '').match(/\d+/g); return found ? found.join('') : ''; };
const normal = value => String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
function format(order, store) {
  const deliveryMethod = (order.shippingLines?.nodes || []).map(line => line.title || line.code).filter(Boolean).join(' / ') || 'Local delivery';
  const route = ['in store','pickup in store'].includes(normal(deliveryMethod)) ? 'will_call' : 'local_delivery';
  return {
    id:order.id, number:order.name, storeKey:store.key, storeLabel:store.label,
    customer:order.customer?.displayName || 'Walk-in customer', phone:order.customer?.phone || '', route, deliveryMethod,
    lines:(order.lineItems?.nodes || []).map(x => ({id:x.id, sku:x.sku || '', name:x.name, quantity:x.quantity, remaining:x.fulfillableQuantity})).filter(x => x.remaining > 0)
  };
}
module.exports = async function(req, res) {
  const auth = await requireUser(req); if (!auth.ok) return res.status(auth.status).json({ok:false,error:auth.error});
  if (req.method !== 'GET') return res.status(405).json({ok:false,error:'read_only_sales_order_lookup'});
  try {
    const scanned = number(req.query?.scan); if (!scanned) return res.status(400).json({ok:false,error:'Scan or enter a receipt order number.'});
    const found = [];
    for (const store of stores()) {
      const data = await graphql(store, orderQuery, {query:'name:' + scanned + ' status:any'});
      for (const order of data.orders?.nodes || []) {
        const ticket = format(order, store);
        if (!order.cancelledAt && number(order.name) === scanned && ticket.lines.length) found.push(ticket);
      }
    }
    if (!found.length) return res.status(404).json({ok:false,error:'No unfulfilled Shopify order matches #' + scanned + '.'});
    if (found.length > 1) return res.status(409).json({ok:false,error:'More than one store returned #' + scanned + '. Choose the order from the queue.'});
    return res.status(200).json({ok:true,order:found[0]});
  } catch (error) { return res.status(500).json({ok:false,error:error.message || 'sales_order_failed'}); }
};
