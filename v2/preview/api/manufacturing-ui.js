const fixtures={
 planner:{total:6,destinations:['Amityville','Bohemia','Riverhead','Annex'],kpis:[['Destinations needing stock',4],['Finished SKUs below par',6],['Suggested doors to build',88],['BOM-ready quantity',54],['Component-blocked quantity',22],['Already in production',12]].map(([label,value])=>({label,value})),rows:[
  {id:'p1',destination:'Amityville',sku:'2PSR36SNRH',product:'SYNTHETIC · 2 Panel Brogan 36 in · Satin Nickel · RH',onHand:-4,allocated:0,available:-4,par:18,incoming:0,inProduction:0,suggested:22,bomStatus:'Ready'},
  {id:'p2',destination:'Amityville',sku:'CD3080PHRHSN2P',product:'SYNTHETIC · Carrara prehung 30 × 80 · RH',onHand:3,allocated:8,available:-5,par:14,incoming:2,inProduction:0,suggested:17,bomStatus:'Ready'},
  {id:'p3',destination:'Bohemia',sku:'2PSR32SNLH',product:'SYNTHETIC · 2 Panel Brogan 32 in · Satin Nickel · LH',onHand:2,allocated:1,available:1,par:12,incoming:0,inProduction:4,suggested:7,bomStatus:'Shortage'},
  {id:'p4',destination:'Riverhead',sku:'5PSR32SNLH',product:'SYNTHETIC · 5 Panel Shaker 32 in · Satin Nickel · LH',onHand:0,allocated:0,available:0,par:10,incoming:3,inProduction:2,suggested:5,bomStatus:'Ready'},
  {id:'p5',destination:'Annex',sku:'2PCA30MBRH',product:'SYNTHETIC · Carrara 30 in · Matte Black · RH',onHand:4,allocated:0,available:4,par:16,incoming:0,inProduction:6,suggested:6,bomStatus:'Missing'},
  {id:'p6',destination:'Bohemia',sku:'6P33SNRH',product:'SYNTHETIC · 6 Panel Hollow Core 33 in · RH',onHand:5,allocated:0,available:5,par:36,incoming:0,inProduction:0,suggested:31,bomStatus:'Shortage'}]},
 board:{NIGHTHAWK:[
  {id:101,number:'TEST-MWO-000101',destination:'Amityville',priority:'urgent',requested:'Sep 4',skus:3,planned:48,good:18,remaining:30,status:'In Production',action:'Record Progress'},
  {id:102,number:'TEST-MWO-000102',destination:'Riverhead',priority:'normal',requested:'Sep 5',skus:2,planned:24,good:0,remaining:24,status:'Released',action:'Start'},
  {id:105,number:'TEST-MWO-000105',destination:'Bohemia',priority:'high',requested:'Sep 5',skus:2,planned:20,good:6,remaining:14,status:'Paused',action:'Resume'}],TERMINATOR:[
  {id:103,number:'TEST-MWO-000103',destination:'Bohemia',priority:'high',requested:'Sep 4',skus:4,planned:56,good:40,remaining:16,status:'Partially Completed',action:'Record Progress'},
  {id:104,number:'TEST-MWO-000104',destination:'Annex',priority:'normal',requested:'Sep 6',skus:1,planned:12,good:12,remaining:0,status:'Completed',action:'Review Transfer'}]},
 orders:{total:7,rows:[
  {id:106,number:'TEST-MWO-000106',created:'Sep 2',destination:'Annex',machine:'Nighthawk',status:'Draft',planned:18,good:0,remaining:18,transferStatus:'Transfer pending',requested:'Sep 7'},
  {id:102,number:'TEST-MWO-000102',created:'Sep 2',destination:'Riverhead',machine:'Nighthawk',status:'Released',planned:24,good:0,remaining:24,transferStatus:'Transfer pending',requested:'Sep 5'},
  {id:101,number:'TEST-MWO-000101',created:'Sep 2',destination:'Amityville',machine:'Nighthawk',status:'In Production',planned:48,good:18,remaining:30,transferStatus:'Transfer pending',requested:'Sep 4'},
  {id:105,number:'TEST-MWO-000105',created:'Sep 2',destination:'Bohemia',machine:'Nighthawk',status:'Paused',planned:20,good:6,remaining:14,transferStatus:'Transfer pending',requested:'Sep 5'},
  {id:103,number:'TEST-MWO-000103',created:'Sep 2',destination:'Bohemia',machine:'Terminator',status:'Partially Completed',planned:56,good:40,remaining:16,transferStatus:'Transfer pending',requested:'Sep 4'},
  {id:104,number:'TEST-MWO-000104',created:'Sep 1',destination:'Annex',machine:'Terminator',status:'Completed',planned:12,good:12,remaining:0,transferStatus:'Transfer created',requested:'Sep 6'},
  {id:100,number:'TEST-MWO-000100',created:'Sep 1',destination:'Riverhead',machine:'Nighthawk',status:'Closed',planned:30,good:29,remaining:0,transferStatus:'Transfer created',requested:'Sep 3'}]},
 boms:{total:3,rows:[
  {id:201,sku:'2PSR36SNRH',product:'SYNTHETIC · 2 Panel Brogan 36 in · RH',version:3,status:'Active',components:7,validation:'Ready',source:'Qoblex import',updated:'Sep 1',componentRows:[{sku:'SLAB-2P36',name:'2 Panel slab 36 in',quantity:1,uom:'EA',status:'Active'},{sku:'JAMB-496',name:'4-9/16 primed jamb',quantity:17,uom:'LF',status:'Active'},{sku:'HINGE-SN',name:'Satin nickel hinge',quantity:3,uom:'EA',status:'Active'}]},
  {id:202,sku:'CD3080PHRHSN2P',product:'SYNTHETIC · Carrara prehung 30 × 80 · RH',version:2,status:'Active',components:8,validation:'Ready',source:'Qoblex import',updated:'Aug 30',componentRows:[{sku:'SLAB-CAR30',name:'Carrara slab 30 in',quantity:1,uom:'EA',status:'Active'}]},
  {id:203,sku:'2PCA30MBRH',product:'SYNTHETIC · Carrara 30 in · Matte Black · RH',version:0,status:'Draft',components:0,validation:'Missing',source:'Manual review',updated:'Sep 2',componentRows:[]}]}
};
module.exports=async function previewManufacturingUi(req,res){
 if(req.method!=='GET')return res.status(405).json({ok:false,error:'method_not_allowed'});
 const view=String(req.query?.view||'planner');
 return res.status(200).json({ok:true,fixture:true,testEnvironment:true,previewUser:'Phase 3 Test Manager',permissions:['manufacturing_view_planner','manufacturing_view_work_orders','manufacturing_print_packet','manufacturing_create_draft','manufacturing_release','manufacturing_record_progress'],...(fixtures[view]||fixtures.planner)});
};
