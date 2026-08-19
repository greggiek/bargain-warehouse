const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');
async function accessForUser(url,key,userId) {
  const r=await fetch(url+'/rest/v1/user_location_access?user_id=eq.'+encodeURIComponent(userId)+'&select=location_id,can_manage,locations(id,name,active)',{headers:jsonHeaders(key),signal:AbortSignal.timeout(8000)});
  if(!r.ok) throw new Error('location access lookup failed');
  return (await r.json()).filter(x=>x.locations?.active);
}
module.exports=async function replenishment(req,res) {
  const auth=await requireUser(req);
  if(!auth.ok) return res.status(auth.status).json({ok:false,error:auth.error});
  try {
    const {url,serviceRoleKey}=configuration();
    const access=await accessForUser(url,serviceRoleKey,auth.user.id);
    const ids=access.map(x=>x.location_id).join(',');
    if(!ids) return res.status(200).json({ok:true,items:[],locations:[]});
    const q='location_id=in.('+ids+')&quantity=lt.0&select=location_id,product_id,quantity,allocated_quantity,products(sku,name,category,barcode),locations(id,name)&order=quantity.asc&limit=1000';
    const r=await fetch(url+'/rest/v1/inventory_balances?'+q,{headers:jsonHeaders(serviceRoleKey),signal:AbortSignal.timeout(10000)});
    const items=await r.json(); if(!r.ok) throw new Error(items.message||'replenishment lookup failed');
    const rows=items.map(x=>({locationId:x.location_id,location:x.locations?.name||'Warehouse',productId:x.product_id,sku:x.products?.sku||'—',product:x.products?.name||'Unnamed product',category:x.products?.category||'',barcode:x.products?.barcode||'',onHand:Number(x.quantity),shortage:Math.abs(Number(x.quantity)),allocated:Number(x.allocated_quantity||0)}));
    const locations=access.map(x=>({id:x.location_id,name:x.locations.name,canManage:x.can_manage}));
    return res.status(200).json({ok:true,items:rows,locations});
  } catch(e) { return res.status(500).json({ok:false,error:e.message}); }
};