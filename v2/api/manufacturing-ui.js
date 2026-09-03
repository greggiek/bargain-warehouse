const {configuration,jsonHeaders}=require('./_lib/auth');
const {requireUser}=require('./_lib/require-user');
const PILOT='BM-MFG-PILOT-001';
const GENERAL=['manufacturing_release_enabled','manufacturing_completion_enabled','manufacturing_inventory_mutations_enabled','manufacturing_shopify_outbound_enabled','manufacturing_transfer_handoff_enabled'];
const PILOT_FLAGS=['manufacturing_pilot_release_enabled','manufacturing_pilot_completion_enabled','manufacturing_pilot_inventory_enabled','manufacturing_pilot_outbound_enabled','manufacturing_pilot_transfer_enabled'];

async function rest(url,key,path){
 const response=await fetch(url+'/rest/v1/'+path,{headers:jsonHeaders(key),signal:AbortSignal.timeout(12000)});
 const data=await response.json().catch(()=>[]);
 if(!response.ok)throw Error(data.message||'Manufacturing read failed');
 return data;
}
const sum=(lines,key)=>(lines||[]).reduce((n,line)=>n+Number(line[key]||0),0);
const action=status=>({Released:'Start','In Production':'Record Progress',Paused:'Resume',Completed:'Review Transfer'}[status]||'View');

module.exports=async function manufacturingUi(req,res){
 if(req.method!=='GET')return res.status(405).json({ok:false,error:'method_not_allowed'});
 const auth=await requireUser(req);
 if(!auth.ok)return res.status(auth.status).json({ok:false,error:auth.error});
 if(process.env.MANUFACTURING_V2_ENABLED!=='true')return res.status(404).json({ok:false,error:'manufacturing_v2_disabled'});
 try{
  const {url,serviceRoleKey}=configuration();
  const beta=await rest(url,serviceRoleKey,`mfg_beta_users?user_id=eq.${Number(auth.user.id)}&select=user_id&limit=1`);
  if(!beta.length)return res.status(403).json({ok:false,error:'manufacturing_beta_access_denied'});
  const view=String(req.query?.view||'planner'),pageSize=Math.min(100,Math.max(1,Number(req.query?.pageSize)||25));
  const [flags,gates,locations,orders,boms]=await Promise.all([
   rest(url,serviceRoleKey,'mfg_feature_flags?select=flag_key,enabled&order=flag_key'),
   rest(url,serviceRoleKey,`manufacturing_pilot_gate?pilot_identifier=eq.${PILOT}&select=pilot_identifier,enabled,approved_work_order_id,approved_finished_product_id,approved_bom_id,origin_location_id,destination_location_id,machine_code`),
   rest(url,serviceRoleKey,'locations?active=eq.true&select=id,name,code&order=name'),
   rest(url,serviceRoleKey,`mfg_work_orders?select=id,work_order_number,status,machine_code,priority,created_at,requested_completion_date,pilot_identifier,pilot_work_order_id,destination:locations!mfg_work_orders_destination_location_id_fkey(id,name),mfg_work_order_lines(id,finished_product_id,planned_quantity,good_quantity,remaining_quantity,products(id,sku,name))&order=created_at.desc&limit=${pageSize}`),
   rest(url,serviceRoleKey,`mfg_bom_versions?select=id,source_bom_id,version_number,status,source_type,created_at,activated_at,finished_product_id,component_hash,products!mfg_bom_versions_finished_product_id_fkey(id,sku,name),mfg_bom_version_components(component_product_id,quantity_per_yield,products(id,sku,name))&order=created_at.desc&limit=${pageSize}`)
  ]);
  const flagMap=Object.fromEntries(flags.map(x=>[x.flag_key,x.enabled===true]));
  if(!flagMap.manufacturing_v2||!flagMap.manufacturing_view_enabled)return res.status(404).json({ok:false,error:'manufacturing_v2_disabled'});
  const gate=gates[0]||null,pilotPaused=Boolean(gate?.approved_work_order_id)&&gate.enabled!==true;
  const controlState={
   pilotIdentifier:PILOT,gateEnabled:gate?.enabled===true,approvedWorkOrderId:gate?.approved_work_order_id||null,pilotPaused,
   pilotCapabilities:Object.fromEntries(PILOT_FLAGS.map(x=>[x,flagMap[x]===true])),
   generalMutations:Object.fromEntries(GENERAL.map(x=>[x,flagMap[x]===true])),
   statusLabel:pilotPaused?`Restricted pilot paused — work order ID ${gate.approved_work_order_id} remains bound.`:gate?.enabled?`Restricted pilot active for work order ID ${gate.approved_work_order_id} only.`:'Manufacturing planning access is available; no restricted pilot is active.'
  };
  const rows=orders.map(w=>{
   const lines=w.mfg_work_order_lines||[],pilotOwned=w.pilot_identifier===PILOT&&Number(w.pilot_work_order_id)===Number(w.id),paused=pilotOwned&&pilotPaused;
   return {id:w.id,number:w.work_order_number,created:String(w.created_at||'').slice(0,10),destination:w.destination?.name||'—',machine:w.machine_code||'Unassigned',
    status:paused?`${w.status} · Pilot paused`:w.status,lifecycleStatus:w.status,planned:sum(lines,'planned_quantity'),good:sum(lines,'good_quantity'),remaining:sum(lines,'remaining_quantity'),
    skus:lines.length,priority:w.priority||'normal',requested:w.requested_completion_date||'—',transferStatus:'Not created',action:paused?'Pilot paused':action(w.status),actionDisabled:paused,pilotOwned};
  });
  const common={ok:true,permissions:['manufacturing_view_planner','manufacturing_view_work_orders','manufacturing_print_packet'],controlState};
  if(view==='board'){
   const active=rows.filter(x=>!['Draft','Cancelled','Closed'].includes(x.lifecycleStatus));
   return res.json({...common,NIGHTHAWK:active.filter(x=>x.machine==='NIGHTHAWK'),TERMINATOR:active.filter(x=>x.machine==='TERMINATOR')});
  }
  if(view==='orders')return res.json({...common,total:rows.length,rows});
  if(view==='boms'){
   const bomRows=boms.map(b=>({id:b.id,sku:b.products?.sku||'—',product:b.products?.name||'—',version:b.version_number||1,status:b.status,
    components:(b.mfg_bom_version_components||[]).length,validation:(b.mfg_bom_version_components||[]).length?'Ready':'Missing',source:b.source_type==='qoblex_import'?'Qoblex import':'BM manual',
    updated:String(b.activated_at||b.created_at||'').slice(0,10),componentHash:b.component_hash,componentRows:(b.mfg_bom_version_components||[]).map(c=>({sku:c.products?.sku||'—',name:c.products?.name||'—',quantity:c.quantity_per_yield,uom:'EA',status:'Active'}))}));
   return res.json({...common,total:bomRows.length,rows:bomRows});
  }
  const destinations=locations.filter(x=>x.code!=='730'),activeBoms=boms.filter(x=>x.status==='active');
  const productIds=[...new Set(activeBoms.map(x=>Number(x.finished_product_id)).filter(Number.isFinite))],locationIds=destinations.map(x=>Number(x.id));
  const [balances,pars]=productIds.length&&locationIds.length?await Promise.all([
   rest(url,serviceRoleKey,`inventory_balances?product_id=in.(${productIds.join(',')})&location_id=in.(${locationIds.join(',')})&select=product_id,location_id,quantity,allocated_quantity`),
   rest(url,serviceRoleKey,`product_par_levels?product_id=in.(${productIds.join(',')})&location_id=in.(${locationIds.join(',')})&select=product_id,location_id,par_quantity`)
  ]):[[],[]];
  const plannerRows=[];
  for(const b of activeBoms)for(const d of destinations){
   const balance=balances.find(x=>Number(x.product_id)===Number(b.finished_product_id)&&Number(x.location_id)===Number(d.id));
   const par=pars.find(x=>Number(x.product_id)===Number(b.finished_product_id)&&Number(x.location_id)===Number(d.id));
   const onHand=Number(balance?.quantity||0),allocated=Number(balance?.allocated_quantity||0),available=onHand-allocated,target=Number(par?.par_quantity||0);
   const inProduction=rows.filter(x=>x.destination===d.name&&!['Cancelled','Closed'].includes(x.lifecycleStatus)).reduce((n,x)=>n+x.remaining,0);
   const suggested=Math.max(target-available-inProduction,0);
   if(target||suggested)plannerRows.push({id:`${d.id}:${b.finished_product_id}`,destination:d.name,sku:b.products?.sku||'—',product:b.products?.name||'—',onHand,allocated,available,par:target,incoming:0,inProduction,suggested,bomStatus:(b.mfg_bom_version_components||[]).length?'Ready':'Missing'});
  }
  return res.json({...common,total:plannerRows.length,destinations:destinations.map(x=>x.name),rows:plannerRows.slice(0,pageSize),kpis:[
   {label:'Destinations needing stock',value:new Set(plannerRows.filter(x=>x.suggested>0).map(x=>x.destination)).size},
   {label:'Finished SKUs below par',value:plannerRows.filter(x=>x.suggested>0).length},
   {label:'Suggested doors to build',value:plannerRows.reduce((n,x)=>n+x.suggested,0)},
   {label:'BOM-ready quantity',value:plannerRows.filter(x=>x.bomStatus==='Ready').reduce((n,x)=>n+x.suggested,0)},
   {label:'Component-blocked quantity',value:0},{label:'Already in production',value:rows.reduce((n,x)=>n+x.remaining,0)}
  ]});
 }catch(error){return res.status(400).json({ok:false,error:error.message||'manufacturing_ui_failed'})}
};
