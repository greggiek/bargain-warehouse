const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');
async function accessForUser(url,key,userId){const r=await fetch(url+'/rest/v1/user_location_access?user_id=eq.'+encodeURIComponent(userId)+'&select=location_id,can_manage,locations(id,name,active)',{headers:jsonHeaders(key),signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error('location access lookup failed');return (await r.json()).filter(x=>x.locations?.active);}
module.exports=async function replenishment(req,res){
 const auth=await requireUser(req);if(!auth.ok)return res.status(auth.status).json({ok:false,error:auth.error});
 try{
  const {url,serviceRoleKey}=configuration(),access=await accessForUser(url,serviceRoleKey,auth.user.id),ids=access.map(x=>x.location_id).join(',');
  if(!ids)return res.status(200).json({ok:true,items:[],recommendations:[],locations:[]});
  const q='location_id=in.('+ids+')&select=location_id,product_id,quantity,allocated_quantity,products(sku,name,category,barcode),locations(id,name)&limit=10000';
  const r=await fetch(url+'/rest/v1/inventory_balances?'+q,{headers:jsonHeaders(serviceRoleKey),signal:AbortSignal.timeout(12000)}),balances=await r.json();if(!r.ok)throw new Error(balances.message||'replenishment lookup failed');
  const rows=balances.map(x=>({locationId:Number(x.location_id),location:x.locations?.name||'Warehouse',productId:Number(x.product_id),sku:x.products?.sku||'—',product:x.products?.name||'Unnamed product',category:x.products?.category||'',barcode:x.products?.barcode||'',onHand:Number(x.quantity),shortage:Math.max(-Number(x.quantity),0),available:Math.max(Number(x.quantity)-Number(x.allocated_quantity||0),0),allocated:Number(x.allocated_quantity||0)}));
  const boardMap=new Map();rows.forEach(x=>{const category=x.category||'Other',key=x.locationId+'|'+category;if(!boardMap.has(key))boardMap.set(key,{locationId:x.locationId,location:x.location,category,below:0,deficit:0});const item=boardMap.get(key);if(x.shortage>0){item.below+=1;item.deficit+=x.shortage;}});const board=[...boardMap.values()].sort((a,b)=>a.location.localeCompare(b.location)||a.category.localeCompare(b.category));
  const items=rows.filter(x=>x.shortage>0),byProduct=new Map();
  rows.forEach(x=>{if(!byProduct.has(x.productId))byProduct.set(x.productId,[]);byProduct.get(x.productId).push({...x});});
  const recommendations=[];
  byProduct.forEach(group=>{
    const sources=group.filter(x=>x.available>0).sort((a,b)=>b.available-a.available);
    group.filter(x=>x.shortage>0).sort((a,b)=>b.shortage-a.shortage).forEach(dest=>{
      let need=dest.shortage;
      sources.forEach(source=>{if(!need||source.locationId===dest.locationId)return;const qty=Math.min(need,source.available);if(qty>0){recommendations.push({sku:dest.sku,product:dest.product,productId:dest.productId,from:source.location,to:dest.location,fromLocationId:source.locationId,toLocationId:dest.locationId,quantity:qty,remainingNeed:need-qty});source.available-=qty;need-=qty;}});
    });
  });
  const locations=access.map(x=>({id:x.location_id,name:x.locations.name,canManage:x.can_manage}));
  return res.status(200).json({ok:true,items,recommendations,locations,board});
 }catch(e){return res.status(500).json({ok:false,error:e.message});}
};