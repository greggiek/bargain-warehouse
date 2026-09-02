module.exports=async function previewManufacturingCommand(req,res){
  if(req.method!=='POST')return res.status(405).json({ok:false,error:'method_not_allowed'});
  return res.status(200).json({ok:true,previewSimulation:true,result:{action:String(req.body?.action||'preview'),simulated:true,inventoryEffect:false,externalEffect:false}});
};
