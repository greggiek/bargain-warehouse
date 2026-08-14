const API_VERSION='2026-07';
const tokenCache=new Map();
const ALLOWED_EMAILS=new Set(['greg@bargainmoulding.com','edwin@bargainmoulding.com','justin@bargainmoulding.com','matt@bargainmoulding.com','evener.umanzor@bargainmoulding.com']);
const STORES=[
  {key:'store_1',label:'Bargain Moulding',domain:'SHOPIFY_STORE_1_DOMAIN',clientId:'SHOPIFY_STORE_1_CLIENT_ID',clientSecret:'SHOPIFY_STORE_1_CLIENT_SECRET'},
  {key:'store_2',label:'Bargain Moulding CT',domain:'SHOPIFY_STORE_2_DOMAIN',clientId:'SHOPIFY_STORE_2_CLIENT_ID',clientSecret:'SHOPIFY_STORE_2_CLIENT_SECRET'}
];
const LOCATION_NAMES={'Bayview Warehouse':'336 Bayview','Bohemia Warehouse':'Bargain Moulding (Bohemia)','Riverhead Warehouse':'1133 Old Country (Riverhead)','Annex (Retail) 730':'Annex Warehouse'};

function cleanDomain(value){return String(value||'').replace(/^https?:\/\//,'').replace(/\/+$/,'')}
function serviceBase(value){const base=String(value||'').trim().replace(/\/+$/,'');if(!base)return'';return /^https?:\/\//i.test(base)?base:`https://${base}`}
async function authorizedUser(req){const bearer=String(req.headers.authorization||'');if(!bearer.startsWith('Bearer '))return null;const base=serviceBase(process.env.BM_WAREHOUSE_SUPABASE_URL),key=process.env.BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY;if(!cleanDomain(base)||!key)throw new Error('Warehouse authentication is not configured');const response=await fetch(`${base}/auth/v1/user`,{headers:{apikey:key,Authorization:bearer}});if(!response.ok)return null;const user=await response.json(),email=String(user.email||'').trim().toLowerCase();return ALLOWED_EMAILS.has(email)?user:null}
async function access(store){const cached=tokenCache.get(store.key);if(cached&&cached.expiresAt>Date.now()+60000)return cached;const shop=cleanDomain(process.env[store.domain]),clientId=process.env[store.clientId],clientSecret=process.env[store.clientSecret];if(!shop||!clientId||!clientSecret)throw new Error(`${store.label}: Shopify connection is not configured`);const response=await fetch(`https://${shop}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams({grant_type:'client_credentials',client_id:clientId,client_secret:clientSecret})}),data=await response.json().catch(()=>null);if(!response.ok||!data?.access_token)throw new Error(`${store.label}: Shopify token failed (${response.status})`);const value={shop,token:data.access_token,expiresAt:Date.now()+Math.max(300,Number(data.expires_in||3600))*1000};tokenCache.set(store.key,value);return value}
function classify(method){const value=String(method||'').trim();if(!value)return'review';return value.toLowerCase()==='in store'?'willcall':'delivery'}
function mapOrder(store,order){
  const method=String(order.shippingLine?.title||order.shippingLine?.code||'').trim(),lines=[];
  for(const line of order.lineItems?.nodes||[]){const sku=String(line.sku||'').trim(),remaining=Number(line.unfulfilledQuantity||0);if(!sku||remaining<=0)continue;const existing=lines.find(item=>item.sku.toUpperCase()===sku.toUpperCase());if(existing)existing.expected+=remaining;else lines.push({sku,name:line.name||sku,barcode:line.variant?.barcode||sku,expected:remaining})}
  const retailName=order.retailLocation?.name||'',warehouse=LOCATION_NAMES[retailName]||retailName,bucket=classify(method);
  return{ref:String(order.name||'').toUpperCase(),shopifyOrderId:order.id,sourceStore:store.key,sourceStoreLabel:store.label,customer:order.customer?.displayName||order.shippingAddress?.name||order.billingAddress?.name||'Customer',job:order.note||'',warehouse,deliveryMethod:method,bucket,status:'Unfulfilled',createdAt:order.createdAt,financialStatus:order.displayFinancialStatus,lines,reviewReason:!method?'Delivery method is blank':!warehouse?'Warehouse assignment is blank':''}
}
async function ordersForStore(store){
  const{shop,token}=await access(store),query=`query BMUnfulfilledOrders($after:String){orders(first:40,after:$after,reverse:true,query:"status:open fulfillment_status:unfulfilled"){pageInfo{hasNextPage endCursor}nodes{id name createdAt displayFinancialStatus displayFulfillmentStatus note customer{displayName} billingAddress{name} shippingAddress{name} retailLocation{name} shippingLine{title code deliveryCategory} lineItems(first:50){nodes{name sku unfulfilledQuantity variant{barcode}}}}}}`;
  const orders=[];let after=null;
  for(let page=0;page<4;page++){
    const response=await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query,variables:{after}})}),payload=await response.json().catch(()=>null);
    if(!response.ok||!payload)throw new Error(`${store.label}: order query failed (${response.status})`);
    if(payload.errors?.length)throw new Error(`${store.label}: ${payload.errors.map(error=>error.message).join('; ')}`);
    const connection=payload.data?.orders;orders.push(...(connection?.nodes||[]));
    if(!connection?.pageInfo?.hasNextPage||!connection.pageInfo.endCursor)break;
    after=connection.pageInfo.endCursor;
  }
  return orders.filter(order=>order.displayFulfillmentStatus!=='FULFILLED').map(order=>mapOrder(store,order))
}

module.exports=async function(req,res){res.setHeader('Cache-Control','private, max-age=20');try{const user=await authorizedUser(req);if(!user)return res.status(401).json({ok:false,error:'Sign in with your Bargain Moulding Google account.'});const settled=await Promise.allSettled(STORES.map(ordersForStore)),orders=settled.flatMap(result=>result.status==='fulfilled'?result.value:[]),warnings=settled.filter(result=>result.status==='rejected').map(result=>result.reason.message);if(!orders.length&&warnings.length===STORES.length)throw new Error(warnings.join('; '));return res.status(200).json({ok:true,mode:'SHOPIFY_READ_ONLY_ORDERS',writesEnabled:false,orders,counts:{willcall:orders.filter(order=>order.bucket==='willcall').length,delivery:orders.filter(order=>order.bucket==='delivery').length,review:orders.filter(order=>order.bucket==='review').length},warnings})}catch(error){return res.status(500).json({ok:false,mode:'SHOPIFY_READ_ONLY_ORDERS',writesEnabled:false,error:error.message})}}
