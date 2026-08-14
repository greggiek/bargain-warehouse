const API_VERSION = '2026-07';
const tokenCache = new Map();
const ALLOWED_EMAILS = new Set(['greg@bargainmoulding.com','edwin@bargainmoulding.com','justin@bargainmoulding.com','matt@bargainmoulding.com','evener.umanzor@bargainmoulding.com']);

async function authorizedUser(req){const bearer=String(req.headers.authorization||'');if(!bearer.startsWith('Bearer '))return null;const base=String(process.env.BM_WAREHOUSE_SUPABASE_URL||'').replace(/\/+$/,''),key=process.env.BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY;if(!base||!key)throw new Error('Warehouse authentication is not configured');const response=await fetch(`${base}/auth/v1/user`,{headers:{apikey:key,Authorization:bearer}});if(!response.ok)return null;const user=await response.json(),email=String(user.email||'').trim().toLowerCase();return ALLOWED_EMAILS.has(email)?user:null}

const STORES = [
  { key:'store_1', label:'Bargain Moulding', domain:'SHOPIFY_STORE_1_DOMAIN', clientId:'SHOPIFY_STORE_1_CLIENT_ID', clientSecret:'SHOPIFY_STORE_1_CLIENT_SECRET' },
  { key:'store_2', label:'Bargain Moulding CT', domain:'SHOPIFY_STORE_2_DOMAIN', clientId:'SHOPIFY_STORE_2_CLIENT_ID', clientSecret:'SHOPIFY_STORE_2_CLIENT_SECRET' }
];

function cleanDomain(value){return String(value||'').replace(/^https?:\/\//,'').replace(/\/+$/,'')}
async function access(store){
  const cached=tokenCache.get(store.key);if(cached&&cached.expiresAt>Date.now()+60000)return cached;
  const shop=cleanDomain(process.env[store.domain]),clientId=process.env[store.clientId],clientSecret=process.env[store.clientSecret];
  if(!shop||!clientId||!clientSecret)throw new Error(`${store.label}: Shopify connection is not configured`);
  const response=await fetch(`https://${shop}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams({grant_type:'client_credentials',client_id:clientId,client_secret:clientSecret})});
  const data=await response.json().catch(()=>null);if(!response.ok||!data?.access_token)throw new Error(`${store.label}: Shopify token failed (${response.status})`);
  const value={shop,token:data.access_token,expiresAt:Date.now()+Math.max(300,Number(data.expires_in||3600))*1000};tokenCache.set(store.key,value);return value;
}
async function searchStore(store,term){
  const {shop,token}=await access(store);
  const query=`query BMCatalogSearch($search:String!){productVariants(first:25,query:$search){nodes{id sku barcode title product{id title status} inventoryItem{id inventoryLevels(first:30){nodes{location{id name} quantities(names:["on_hand","available","committed"]){name quantity}}}}}}}`;
  const response=await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query,variables:{search:term}})});
  const payload=await response.json().catch(()=>null);if(!response.ok||!payload)throw new Error(`${store.label}: catalog search failed (${response.status})`);
  if(payload.errors?.length)throw new Error(payload.errors.map(e=>e.message).join('; '));
  return (payload.data?.productVariants?.nodes||[]).map(v=>({sourceStore:store.key,sourceStoreLabel:store.label,shopifyProductId:v.product?.id,shopifyVariantId:v.id,sku:String(v.sku||'').trim(),barcode:String(v.barcode||'').trim(),product:v.product?.title||v.title||'',status:v.product?.status||'',locations:(v.inventoryItem?.inventoryLevels?.nodes||[]).map(level=>{const q=Object.fromEntries((level.quantities||[]).map(x=>[x.name,Number(x.quantity||0)]));return{locationName:level.location?.name||'',onHand:q.on_hand||0,available:q.available||0,committed:q.committed||0}})}));
}
function normalize(all){
  const map=new Map();
  for(const item of all){if(!item.sku)continue;const key=item.sku.toUpperCase();if(!map.has(key))map.set(key,{sku:item.sku,product:item.product,barcode:item.barcode,totalOnHand:0,totalAvailable:0,locations:[],sources:[]});const row=map.get(key);if(!row.barcode&&item.barcode)row.barcode=item.barcode;row.sources.push(item.sourceStoreLabel);for(const l of item.locations){row.locations.push({...l,sourceStore:item.sourceStore,sourceStoreLabel:item.sourceStoreLabel});row.totalOnHand+=l.onHand;row.totalAvailable+=l.available}}
  return [...map.values()].sort((a,b)=>a.sku.localeCompare(b.sku));
}
async function addCosts(items){
  if(!items.length)return items;
  const base=String(process.env.BM_WAREHOUSE_SUPABASE_URL||'').replace(/\/+$/,''),key=process.env.BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY;
  if(!base||!key)return items;
  const values=items.map(item=>encodeURIComponent(item.sku)).join(',');
  const response=await fetch(`${base}/rest/v1/products?select=sku,purchase_price,moving_average_cost&sku=in.(${values})`,{headers:{apikey:key,Authorization:`Bearer ${key}`,Accept:'application/json'}});
  if(!response.ok)return items;
  const rows=await response.json(),costs=new Map(rows.map(row=>[String(row.sku).toUpperCase(),row]));
  return items.map(item=>{const cost=costs.get(item.sku.toUpperCase())||{};return{...item,purchasePrice:Number(cost.purchase_price||0),movingAverageCost:Number(cost.moving_average_cost||0)}});
}

module.exports=async function(req,res){
  res.setHeader('Cache-Control','private, max-age=15');
  try{
    const user=await authorizedUser(req);if(!user)return res.status(401).json({ok:false,error:'Sign in with your Bargain Moulding Google account.'});
    const term=String(req.query?.q||'').trim();if(term.length<2)return res.status(400).json({ok:false,error:'Enter at least 2 characters.'});if(term.length>80)return res.status(400).json({ok:false,error:'Search is too long.'});
    const settled=await Promise.allSettled(STORES.map(store=>searchStore(store,term)));
    const items=settled.flatMap(x=>x.status==='fulfilled'?x.value:[]),errors=settled.filter(x=>x.status==='rejected').map(x=>x.reason.message);
    if(!items.length&&errors.length===STORES.length)throw new Error(errors.join('; '));
    const normalized=normalize(items).slice(0,40);
    return res.status(200).json({ok:true,mode:'SHOPIFY_READ_ONLY_SEARCH',writesEnabled:false,items:await addCosts(normalized),warnings:errors});
  }catch(error){return res.status(500).json({ok:false,mode:'SHOPIFY_READ_ONLY_SEARCH',writesEnabled:false,error:error.message})}
};
