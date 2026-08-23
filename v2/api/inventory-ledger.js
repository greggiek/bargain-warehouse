const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

async function accessibleLocations(url,key,userId){
  const r=await fetch(url+'/rest/v1/user_location_access?user_id=eq.'+encodeURIComponent(userId)+'&select=location_id,locations(id,name,active)',{headers:jsonHeaders(key),signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw Error('location access lookup failed');
  return (await r.json()).filter(x=>x.locations?.active).map(x=>({id:Number(x.location_id),name:x.locations.name}));
}
module.exports=async(req,res)=>{
  if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({ok:false,error:'method_not_allowed'});}
  const auth=await requireUser(req);if(!auth.ok)return res.status(auth.status).json({ok:false,error:auth.error});
  try{
    const {url,serviceRoleKey}=configuration(),locations=await accessibleLocations(url,serviceRoleKey,auth.user.id);
    if(!locations.length)return res.json({ok:true,locations:[],employees:[],movements:[]});
    const wanted=String(req.query?.locationId||'all');
    const allowed=wanted==='all'?locations:locations.filter(x=>x.id===Number(wanted));
    if(!allowed.length)return res.status(403).json({ok:false,error:'Warehouse is not assigned to you.'});
    const movementType=String(req.query?.movementType||''),employee=String(req.query?.employee||''),search=String(req.query?.search||'').trim().toLowerCase(),from=String(req.query?.from||''),to=String(req.query?.to||'');
    const movementUrl=url+'/rest/v1/inventory_movements?location_id=in.('+allowed.map(x=>x.id).join(',')+')&select=id,created_at,movement_type,quantity_delta,quantity_before,quantity_after,unit_cost,reference_type,reference_id,reason,performed_by_name,metadata,products(sku,name),locations(name)&order=created_at.desc&limit=1000';
    const response=await fetch(movementUrl,{headers:jsonHeaders(serviceRoleKey),signal:AbortSignal.timeout(10000)});const rows=await response.json();
    if(!response.ok)throw Error(rows.message||'Could not load inventory ledger');
    const filtered=rows.filter(row=>{
      if(movementType&&row.movement_type!==movementType)return false;
      if(employee&&row.performed_by_name!==employee)return false;
      const date=row.created_at.slice(0,10);if(from&&date<from)return false;if(to&&date>to)return false;
      return !search||[row.products?.sku,row.products?.name,row.reason,row.reference_id].join(' ').toLowerCase().includes(search);
    });
    const employees=[...new Set(rows.map(row=>row.performed_by_name).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    const types=[...new Set(rows.map(row=>row.movement_type).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    return res.json({ok:true,locations,employees,types,movements:filtered});
  }catch(error){return res.status(500).json({ok:false,error:error.message||'inventory_ledger_failed'});}
};