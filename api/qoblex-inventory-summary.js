let cached=null;let cachedAt=0;const TTL=5*60*1000;
module.exports=async function(req,res){
  const key=process.env.QOBLEX_API_KEY;const base=(process.env.QOBLEX_BASE_URL||'https://api.qoblex.com').replace(/\/$/,'');
  if(!key)return res.status(500).json({ok:false,error:'QOBLEX_API_KEY missing'});
  if(cached&&Date.now()-cachedAt<TTL)return res.status(200).json({...cached,cached:true});
  const headers={'qoblex-x-api-key':key,Accept:'application/json'};
  const locs={
    amityville:{name:'Amityville',ids:[16705]},
    bohemia:{name:'Bohemia',ids:[19684]},
    riverhead:{name:'Riverhead',ids:[20249]},
    windham:{name:'Windham',ids:[20947,21323]}
  };
  const idToKey={};Object.entries(locs).forEach(([k,v])=>v.ids.forEach(id=>idToKey[id]=k));
  const blank=()=>({quantity:0,allocated:0,incoming:0,inventoryValue:0,skus:0});
  const totals={amityville:blank(),bohemia:blank(),riverhead:blank(),windham:blank()};
  const skuSets={amityville:new Set(),bohemia:new Set(),riverhead:new Set(),windham:new Set()};
  async function page(n){const u=new URL(base+'/v1/variants');u.searchParams.set('page',String(n));u.searchParams.set('expand','locations');const r=await fetch(u,{headers});if(!r.ok)throw new Error('Qoblex variants page '+n+' returned '+r.status);return r.json()}
  function addRows(rows){for(const v of rows||[]){const cost=Number(v.moving_average_cost||v.purchase_price||0);for(const l of v.locations||[]){const k=idToKey[Number(l.location_id)];if(!k)continue;const q=Number(l.quantity||0),a=Number(l.allocated_quantity||0),inc=Number(l.incoming_quantity||0);totals[k].quantity+=q;totals[k].allocated+=a;totals[k].incoming+=inc;totals[k].inventoryValue+=q*cost;if(q!==0||a!==0||inc!==0)skuSets[k].add(v.sku||v.id)}}}
  try{
    const first=await page(1);const firstRows=first.variants||first.data||[];addRows(firstRows);
    const count=Number(first.filtered_count||first.count||firstRows.length);const per=Math.max(1,firstRows.length||50);const pages=Math.ceil(count/per);
    for(let start=2;start<=pages;start+=8){const ns=[];for(let n=start;n<start+8&&n<=pages;n++)ns.push(n);const chunk=await Promise.all(ns.map(page));chunk.forEach(j=>addRows(j.variants||j.data||[]))}
    Object.keys(totals).forEach(k=>{totals[k].skus=skuSets[k].size;totals[k].inventoryValue=Math.round(totals[k].inventoryValue*100)/100});
    const network=blank();for(const v of Object.values(totals)){network.quantity+=v.quantity;network.allocated+=v.allocated;network.incoming+=v.incoming;network.inventoryValue+=v.inventoryValue}network.skus=new Set([...skuSets.amityville,...skuSets.bohemia,...skuSets.riverhead,...skuSets.windham]).size;network.inventoryValue=Math.round(network.inventoryValue*100)/100;
    const result={ok:true,warehouses:Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,{name:locs[k].name,...v}])),network,source:'Qoblex /v1/variants?expand=locations',updatedAt:new Date().toISOString()};cached=result;cachedAt=Date.now();return res.status(200).json(result);
  }catch(e){return res.status(500).json({ok:false,error:e.message})}
}