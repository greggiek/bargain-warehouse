const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');
const { createShopifyNativeDraftTransfer } = require('./_lib/shopify-native-transfer');
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
async function requireControl(url,key,flag){const rows=await rest(url,key,`mfg_feature_flags?flag_key=eq.${encodeURIComponent(flag)}&enabled=eq.true&select=flag_key&limit=1`);if(!rows.length)throw new Error(`manufacturing_control_disabled:${flag}`);}

async function authorized(req){
  if(req.method==='GET'&&process.env.CRON_SECRET&&req.headers?.authorization==='Bearer '+process.env.CRON_SECRET) return true;
  if(req.method!=='POST') return false;
  const auth=await requireUser(req);
  return auth.ok&&['admin','developer'].includes(auth.user.role);
}

module.exports=async function manufacturingTransferHandoff(req,res){
  if(!(await authorized(req))) return res.status(['GET','POST'].includes(req.method)?403:405).json({ok:false,error:'manufacturing_transfer_handoff_not_authorized'});
  const {url,serviceRoleKey}=configuration();
  try{await requireControl(url,serviceRoleKey,'manufacturing_transfer_handoff_enabled');await requireControl(url,serviceRoleKey,'manufacturing_shopify_outbound_enabled');}
  catch(error){return res.status(403).json({ok:false,error:error.message});}
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
    const transfer=await createShopifyNativeDraftTransfer({store,
      input:{originLocationId:claim.sourceShopifyLocationId,destinationLocationId:claim.destinationShopifyLocationId,
        lineItems:link.lines.map(line=>({inventoryItemId:line.inventoryItemId,quantity:Number(line.quantity)})),
        referenceName:link.bmReference,note:'Manufacturing output from '+claim.workOrderNumber+'. Draft only; no inventory moved.',
        tags:['BM Warehouse','Manufacturing']},
      idempotencyKey:claim.idempotencyKey
    });
    const result=await rpc(url,serviceRoleKey,'finish_mfg_transfer_handoff',{
      p_handoff_id:claim.id,p_lease_token:claim.leaseToken,p_shopify_transfer_id:transfer.id,
      p_shopify_name:transfer.name||link.bmReference
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
