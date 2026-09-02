async function rpc(url,key,name,body){
  const response=await fetch(url+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:key,authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const result=await response.json().catch(()=>false);
  if(!response.ok)throw new Error(result.message||result.error||'manufacturing_feature_gate_failed');
  return result;
}

async function requireManufacturingFeature(url,key,userId,flag){
  const enabled=await rpc(url,key,'mfg_feature_enabled_for_user',{p_actor_user_id:Number(userId),p_flag_key:flag});
  if(enabled!==true){const error=new Error('manufacturing_shadow_mode_blocked:'+flag);error.status=403;throw error;}
}

async function manufacturingFeatureEnabled(url,key,flag){
  const response=await fetch(url+'/rest/v1/mfg_feature_flags?flag_key=eq.'+encodeURIComponent(flag)+'&enabled=eq.true&select=flag_key&limit=1',{headers:{apikey:key,authorization:'Bearer '+key},signal:AbortSignal.timeout(10000)});
  const rows=await response.json().catch(()=>[]);
  return response.ok&&Array.isArray(rows)&&rows.length===1;
}

module.exports={requireManufacturingFeature,manufacturingFeatureEnabled};
