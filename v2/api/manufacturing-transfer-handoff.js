const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const API_VERSION = '2026-07';
const clean = value => String(value || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const stores = () => [
  { key:'store_1',label:'Shopify NY',domain:process.env.SHOPIFY_STORE_1_DOMAIN,clientId:process.env.SHOPIFY_STORE_1_CLIENT_ID,clientSecret:process.env.SHOPIFY_STORE_1_CLIENT_SECRET },
  { key:'store_2',label:'Shopify CT',domain:process.env.SHOPIFY_STORE_2_DOMAIN,clientId:process.env.SHOPIFY_STORE_2_CLIENT_ID,clientSecret:process.env.SHOPIFY_STORE_2_CLIENT_SECRET }
];

async function rest(url,key,path,options={}) {
  const response=await fetch(url+'/rest/v1/'+path,{...options,headers:{...jsonHeaders(key),...(options.headers||{})},signal:AbortSignal.timeout(options.timeout||30000)});
  const body=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(body.message||body.error||'manufacturing_transfer_handoff_database_error');
  return body;
}
const rpc=(url,key,name,body)=>rest(url,key,'rpc/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

async function tokenFor(store){
  const shop=clean(store.domain);
  if(!shop||!store.clientId||!store.clientSecret) throw new Error(store.label+': Shopify connection is not configured.');
  const response=await fetch('https://'+shop+'/admin/oauth/access_token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'client_credentials',client_id:store.clientId,client_secret:store.clientSecret}),signal:AbortSignal.timeout(20000)});
  const body=await response.json().catch(()=>({}));
  if(!response.ok||!body.access_token) throw new Error(store.label+': Shopify token request failed.');
  return {shop,token:body.access_token};
}
async function graphql(store,query,variables){
  const {shop,token}=await tokenFor(store);
  const response=await fetch('https://'+shop+'/admin/api/'+API_VERSION+'/graphql.json',{method:'POST',
    headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(30000)});
  const body=await response.json().catch(()=>({}));
  if(!response.ok||body.errors?.length) throw new Error(body.errors?.map(x=>x.message).join('; ')||store.label+': Shopify request failed.');
  return body.data;
}

// This is the same supported mutation and link workflow used by
// shopify-transfer-preview.js. This worker always uses the persisted handoff key.
const createNativeTransferMutation=`mutation CreateNativeTransfer($input: InventoryTransferCreateInput!, $idempotencyKey: String!) {
 inventoryTransferCreate(input: $input) @idempotent(key: $idempotencyKey) {
  inventoryTransfer { id name status referenceName }
  userErrors { field message }
 }
}`;

async function authorized(req){
  if(req.method==='GET'&&process.env.CRON_SECRET&&req.headers?.authorization==='Bearer '+process.env.CRON_SECRET) return true;
  if(req.method!=='POST') return false;
  const auth=await requireUser(req);
  return auth.ok&&['admin','developer'].includes(auth.user.role);
}

module.exports=async function manufacturingTransferHandoff(req,res){
  if(!(await authorized(req))) return res.status(['GET','POST'].includes(req.method)?403:405).json({ok:false,error:'manufacturing_transfer_handoff_not_authorized'});
  const {url,serviceRoleKey}=configuration();
  const claim=await rpc(url,serviceRoleKey,'claim_mfg_transfer_handoff',{p_lease_seconds:120});
  if(!claim) return res.status(200).json({ok:true,processed:false});
  try{
    const link=await rpc(url,serviceRoleKey,'begin_mfg_transfer_handoff_link',{p_handoff_id:claim.id,p_lease_token:claim.leaseToken});
    if(link.existingShopifyTransferId){
      const result=await rpc(url,serviceRoleKey,'finish_mfg_transfer_handoff',{
        p_handoff_id:claim.id,p_lease_token:claim.leaseToken,p_shopify_transfer_id:link.existingShopifyTransferId,p_shopify_name:link.bmReference
      });
      return res.status(200).json({ok:true,processed:true,reconciledExisting:true,result});
    }
    const store=stores().find(x=>x.key===claim.storeKey);
    if(!store) throw new Error('Manufacturing transfer Shopify store mapping is unavailable.');
    const data=await graphql(store,createNativeTransferMutation,{
      input:{originLocationId:claim.sourceShopifyLocationId,destinationLocationId:claim.destinationShopifyLocationId,
        lineItems:link.lines.map(line=>({inventoryItemId:line.inventoryItemId,quantity:Number(line.quantity)})),
        referenceName:link.bmReference,note:'Manufacturing output from '+claim.workOrderNumber+'. Draft only; no inventory moved.',
        tags:['BM Warehouse','Manufacturing']},
      idempotencyKey:claim.idempotencyKey
    });
    const payload=data.inventoryTransferCreate||{};
    if(payload.userErrors?.length) throw new Error(payload.userErrors.map(x=>x.message).join('; '));
    if(!payload.inventoryTransfer?.id) throw new Error('Shopify did not return a native transfer ID.');
    const result=await rpc(url,serviceRoleKey,'finish_mfg_transfer_handoff',{
      p_handoff_id:claim.id,p_lease_token:claim.leaseToken,p_shopify_transfer_id:payload.inventoryTransfer.id,
      p_shopify_name:payload.inventoryTransfer.name||link.bmReference
    });
    return res.status(200).json({ok:true,processed:true,reconciledExisting:false,result});
  }catch(error){
    await rpc(url,serviceRoleKey,'fail_mfg_transfer_handoff',{p_handoff_id:claim.id,p_lease_token:claim.leaseToken,
      p_error:error.message||'manufacturing_transfer_handoff_failed',p_permanent:false}).catch(leaseError=>
      console.error('Manufacturing transfer handoff lease release failed',leaseError));
    console.error('Manufacturing native transfer handoff failed',{handoffId:claim.id,attempt:claim.attempt,error:error.message});
    return res.status(503).json({ok:false,error:error.message||'manufacturing_transfer_handoff_failed',retryable:true,handoffId:claim.id});
  }
};
