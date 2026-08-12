let cached=null;let cachedAt=0;let inflight=null;const TTL=15*60*1000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
module.exports=async function(req,res){
 const key=process.env.QOBLEX_API_KEY,base=(process.env.QOBLEX_BASE_URL||'https://api.qoblex.com').replace(/\/$/,'');
 if(!key)return res.status(500).json({ok:false,error:'QOBLEX_API_KEY missing'});
 if(cached&&Date.now()-cachedAt<TTL)return res.status(200).json({...cached,cached:true});
 if(inflight){try{return res.status(200).json({...await inflight,cached:false})}catch(e){return res.status(500).json({ok:false,error:e.message})}}
 const headers={'qoblex-x-api-key':key,Accept:'application/json'};
 inflight=(async()=>{
  const locs={amityville:{name:'Amityville',ids:[16705]},bohemia:{name:'Bohemia',ids:[19684]},riverhead:{name:'Riverhead',ids:[20249]},windham:{name:'Windham',ids:[20947,21323]}};
  const idToKey={};Object.entries(locs).forEach(([k,v])=>v.ids.forEach(id=>idToKey[id]=k));
  const blank=()=>({quantity:0,allocated:0,incoming:0,inventoryValue:0,skus:0}),totals={amityville:blank(),bohemia:blank(),riverhead:blank(),windham:blank()},skuSets={amityville:new Set(),bohemia:new Set(),riverhead:new Set(),windham:new Set()};
  async function page(n){
   const u=new URL(base+'/v1/variants');u.searchParams.set('page',String(n));u.searchParams.set('expand','locations');
   for(let attempt=0;attempt<5;attempt++){
    const r=await fetch(u,{headers});
    if(r.ok)return r.json();
    if(r.status!==429)throw new Error('Qoblex variants page '+n+' returned '+r.status);
    const retry=Number(r.headers.get('retry-after')||0);await sleep(retry?retry*1000:1500*Math.pow(2,attempt));
   }
   throw new Error('Qoblex is rate limiting inventory. Please retry shortly.');
  }
  function add(rows){for(const v of rows||[]){const cost=Number(v.moving_average_cost||v.purchase_price||0);for(const l of v.locations||[]){const k=idToKey[Number(l.location_id)];if(!k)continue;const q=Number(l.quantity||0),a=Number(l.allocated_quantity||0),inc=Number(l.incoming_quantity||0);totals[k].quantity+=q;totals[k].allocated+=a;totals[k].incoming+=inc;totals[k].inventoryValue+=q*cost;if(q||a||inc)skuSets[k].add(v.sku||v.id)}}}
  const first=await page(1),rows=first.variants||first.data||[];add(rows);const count=Number(first.filtered_count||first.count||rows.length),per=Math.max(1,rows.length||50),pages=Math.ceil(count/per);
  for(let n=2;n<=pages;n++){await sleep(350);const j=await page(n);add(j.variants||j.data||[])}
  Object.keys(totals).forEach(k=>{totals[k].skus=skuSets[k].size;totals[k].inventoryValue=Math.round(totals[k].inventoryValue*100)/100});
  const network=blank();for(const v of Object.values(totals)){network.quantity+=v.quantity;network.allocated+=v.allocated;network.incoming+=v.incoming;network.inventoryValue+=v.inventoryValue}network.skus=new Set([...skuSets.amityville,...skuSets.bohemia,...skuSets.riverhead,...skuSets.windham]).size;network.inventoryValue=Math.round(network.inventoryValue*100)/100;
  cached={ok:true,warehouses:Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,{name:locs[k].name,...v}])),network,source:'Qoblex variants + locations',updatedAt:new Date().toISOString()};cachedAt=Date.now();return cached;
 })();
 try{return res.status(200).json({...await inflight,cached:false})}catch(e){if(cached)return res.status(200).json({...cached,cached:true,stale:true,warning:e.message});return res.status(500).json({ok:false,error:e.message})}finally{inflight=null}
}