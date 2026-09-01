const { randomUUID } = require('crypto');
const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');
module.exports=async function forecast(req,res){
 const requestId=randomUUID();const started=Date.now();
 res.setHeader('X-Request-Id',requestId);
 if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({ok:false,error:'method_not_allowed',requestId})}
 const auth=await requireUser(req);if(!auth.ok)return res.status(auth.status).json({ok:false,error:auth.error,requestId});
 try{
  const q=new URL(req.url||'/','http://localhost').searchParams,num=(k,d)=>Number.isFinite(Number(q.get(k)))?Number(q.get(k)):d;
  const common={p_history_days:Math.max(1,Math.min(120,Math.round(num('historyDays',90)))),p_growth:num('growth',10)/100,p_coverage_days:Math.max(0,Math.round(num('coverageDays',90))),p_safety_days:Math.max(0,Math.round(num('safetyStockDays',14)))};
  const detail=String(q.get('detailSku')||'').trim();
  const body=detail?{...common,p_sku:detail}:{...common,p_category:String(q.get('category')||'').trim()||null,p_search:String(q.get('search')||'').trim()||null,p_sort:String(q.get('sort')||'suggested_desc'),p_page:Math.max(1,Math.round(num('page',1))),p_page_size:Math.max(1,Math.min(100,Math.round(num('pageSize',50))))};
  const rpc=detail?'forecast_v2_bulk_detail':'forecast_v2_page',{url,serviceRoleKey}=configuration();
  const dbStarted=Date.now(),response=await fetch(url+'/rest/v1/rpc/'+rpc,{method:'POST',headers:jsonHeaders(serviceRoleKey),body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const raw=await response.text(),dbMs=Date.now()-dbStarted;
  if(!response.ok){let message='Forecast read failed';try{message=JSON.parse(raw).message||message}catch{}throw new Error(message)}
  const data=JSON.parse(raw);res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Forecast-Db-Ms',String(dbMs));res.setHeader('X-Forecast-Bytes',String(Buffer.byteLength(raw)));
  console.log('[forecast]',{requestId,rpc,dbMs,bytes:Buffer.byteLength(raw),rows:Array.isArray(data.items)?data.items.length:1,totalMs:Date.now()-started});
  return res.status(200).json(detail?{ok:true,item:data,requestId}:{...data,requestId,metrics:{dbMs,payloadBytes:Buffer.byteLength(raw)}});
 }catch(error){console.error('[forecast]',{requestId,error:String(error),totalMs:Date.now()-started});return res.status(500).json({ok:false,error:error.message||'forecast_failed',requestId})}
};