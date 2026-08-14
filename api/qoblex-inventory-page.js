const sleep=ms=>new Promise(r=>setTimeout(r,ms));
module.exports=async function(req,res){
 const key=process.env.QOBLEX_API_KEY,base=(process.env.QOBLEX_BASE_URL||'https://api.qoblex.com').replace(/\/$/,'');
 if(!key)return res.status(500).json({ok:false,error:'QOBLEX_API_KEY missing'});
 const page=Math.max(1,Number(req.query.page||1));const headers={'qoblex-x-api-key':key,Accept:'application/json'};
 const locMap={16705:'amityville',19684:'bohemia',20249:'riverhead',20947:'windham',21323:'annex'};
 try{
  const u=new URL(base+'/v1/variants');u.searchParams.set('page',String(page));u.searchParams.set('expand','locations');
  let r,text;
  for(let attempt=0;attempt<4;attempt++){
   r=await fetch(u,{headers});text=await r.text();
   if(r.ok)break;
   if(r.status!==429)return res.status(r.status).json({ok:false,error:'Qoblex returned '+r.status,detail:text.slice(0,300)});
   const ra=Number(r.headers.get('retry-after')||0);await sleep(ra>0?ra*1000:1200*Math.pow(2,attempt));
  }
  if(!r||!r.ok)return res.status(503).json({ok:false,error:'Qoblex is rate limiting inventory. Retried automatically; try again shortly.'});
  let data;try{data=JSON.parse(text)}catch(e){return res.status(502).json({ok:false,error:'Qoblex returned invalid JSON'})}
  const variants=data.variants||data.data||[];const rows=variants.map(v=>{const x={sku:v.sku||v.supplier_sku||String(v.id),name:v.name||v.product_name||'',total:0,amityville:0,bohemia:0,riverhead:0,windham:0,annex:0};for(const l of v.locations||[]){const k=locMap[Number(l.location_id)];if(k)x[k]+=Number(l.quantity||0)}x.total=x.amityville+x.bohemia+x.riverhead+x.windham+x.annex;return x});
  res.setHeader('Cache-Control','public, s-maxage=120, stale-while-revalidate=300');
  return res.status(200).json({ok:true,page,count:Number(data.count||data.filtered_count||rows.length),filtered_count:Number(data.filtered_count||data.count||rows.length),rows,updatedAt:new Date().toISOString()});
 }catch(e){return res.status(500).json({ok:false,error:e.message})}
}