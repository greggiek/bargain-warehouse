const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');
const API_VERSION='2026-07';
const clean=v=>String(v||'').replace(/^https?:\/\//,'').replace(/\/+$/,'');
const stores=()=>[{key:'store_1',label:'Shopify NY',domain:process.env.SHOPIFY_STORE_1_DOMAIN,clientId:process.env.SHOPIFY_STORE_1_CLIENT_ID,clientSecret:process.env.SHOPIFY_STORE_1_CLIENT_SECRET},{key:'store_2',label:'Shopify CT',domain:process.env.SHOPIFY_STORE_2_DOMAIN,clientId:process.env.SHOPIFY_STORE_2_CLIENT_ID,clientSecret:process.env.SHOPIFY_STORE_2_CLIENT_SECRET}];
async function gql(store,query,variables){
 const shop=clean(store.domain);if(!shop||!store.clientId||!store.clientSecret)throw Error(store.label+': Shopify connection is not configured.');
 const tokenResponse=await fetch('https://'+shop+'/admin/oauth/access_token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:store.clientId,client_secret:store.clientSecret}),signal:AbortSignal.timeout(20000)});
 const tokenBody=await tokenResponse.json().catch(()=>({}));if(!tokenResponse.ok||!tokenBody.access_token)throw Error(store.label+': Shopify token request failed.');
 const response=await fetch('https://'+shop+'/admin/api/'+API_VERSION+'/graphql.json',{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':tokenBody.access_token},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(25000)});
 const body=await response.json().catch(()=>({}));if(!response.ok||body.errors?.length)throw Error(body.errors?.map(x=>x.message).join('; ')||store.label+': Shopify request failed.');return body.data;
}
async function permission(req){
 const cron=req.method==='GET'&&Boolean(process.env.CRON_SECRET)&&String(req.headers?.authorization||'')==='Bearer '+process.env.CRON_SECRET;
 if(cron)return{mode:'cron'};if(req.method!=='POST')return null;
 const auth=await requireUser(req);if(!auth.ok)return{status:auth.status,error:auth.error};if(!['admin','developer'].includes(auth.user.role))return{status:403,error:'administrator_role_required'};return{mode:'manual'};
}
module.exports=async(req,res)=>{
 const allowed=await permission(req);if(!allowed){res.setHeader('Allow','GET, POST');return res.status(405).json({ok:false,error:'method_not_allowed'});}if(allowed.error)return res.status(allowed.status).json({ok:false,error:allowed.error});
 try{
  const {url,serviceRoleKey}=configuration(),headers=jsonHeaders(serviceRoleKey);
  const stateResponse=await fetch(url+'/rest/v1/shopify_inventory_sync_state?select=store_key,cursor,cycle_started_at,last_synced_at&order=last_synced_at.asc.nullsfirst&limit=1',{headers,signal:AbortSignal.timeout(10000)});
  const states=await stateResponse.json().catch(()=>[]);if(!stateResponse.ok||!states[0])throw Error('Could not load Shopify inventory sync state.');const state=states[0],store=stores().find(x=>x.key===state.store_key);if(!store)throw Error('Unknown Shopify sync store.');
  const started=state.cycle_started_at||new Date().toISOString(),cycleKey=started.replace(/[^0-9]/g,'').slice(0,14);
  const query=`query($after:String){inventoryItems(first:25,after:$after){pageInfo{hasNextPage endCursor}nodes{id sku inventoryLevels(first:50){nodes{location{id} quantities(names:[\"on_hand\",\"available\",\"committed\"]){name quantity}}}}}}`;
  const data=await gql(store,query,{after:state.cursor||null}),connection=data.inventoryItems;if(!connection)throw Error(store.label+': inventory page is unavailable.');
  const items=(connection.nodes||[]).map(item=>({inventoryItemId:item.id,sku:item.sku||'',levels:(item.inventoryLevels?.nodes||[]).map(level=>{const q=Object.fromEntries((level.quantities||[]).map(x=>[x.name,Number(x.quantity||0)]));return{locationId:level.location?.id,onHand:q.on_hand||0,available:q.available||0,committed:q.committed||0};}).filter(x=>x.locationId)}));
  const applyResponse=await fetch(url+'/rest/v1/rpc/apply_v2_shopify_inventory_sync_page',{method:'POST',headers,body:JSON.stringify({p_store_key:store.key,p_cycle_key:cycleKey,p_items:items}),signal:AbortSignal.timeout(30000)});
  const summary=await applyResponse.json().catch(()=>({}));if(!applyResponse.ok)throw Error(summary.message||'Could not apply Shopify inventory page.');
  const complete=!connection.pageInfo?.hasNextPage,now=new Date().toISOString(),patch={cursor:complete?null:(connection.pageInfo?.endCursor||null),cycle_started_at:complete?null:started,last_synced_at:now,last_error:null,updated_at:now};if(complete)patch.last_completed_at=now;
  const save=await fetch(url+'/rest/v1/shopify_inventory_sync_state?store_key=eq.'+store.key,{method:'PATCH',headers:{...headers,Prefer:'return=minimal'},body:JSON.stringify(patch),signal:AbortSignal.timeout(10000)});if(!save.ok)throw Error('Could not save Shopify sync checkpoint.');
  await fetch(url+'/rest/v1/shopify_inventory_sync_runs',{method:'POST',headers,body:JSON.stringify({store_key:store.key,cycle_key:cycleKey,cursor_before:state.cursor||null,cursor_after:complete?null:(connection.pageInfo?.endCursor||null),scanned_items:items.length,applied_levels:Number(summary.appliedLevels||0),changed_levels:Number(summary.changedLevels||0),skipped_items:Number(summary.skippedItems||0),completed_cycle:complete}),signal:AbortSignal.timeout(10000)});
  return res.json({ok:true,mode:allowed.mode,direction:'shopify_to_bm_warehouse',writesToShopify:false,store:store.label,scannedItems:items.length,...summary,completedCycle:complete});
 }catch(error){console.error('Shopify inventory sync failed',error);return res.status(500).json({ok:false,error:error.message||'shopify_inventory_sync_failed'});}
};