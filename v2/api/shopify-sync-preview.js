const { requireUser } = require('./_lib/require-user');
const complete = require('./full-catalog-dry-run')._internal;
module.exports=async function(req,res){
 if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({ok:false,error:'method_not_allowed',writesEnabled:false})}
 const a=await requireUser(req);if(!a.ok)return res.status(a.status).json({ok:false,error:a.error,writesEnabled:false});
 const telemetry={throttleEvents:0,retryEvents:0};
 try{
  const results=[];for(const store of complete.stores)results.push(await complete.loadStore(store,telemetry));
  if(!results.every(r=>r.end))throw Error('Not every Shopify store reached catalog end');
  const map=new Map();
  for(const r of results)for(const p of r.products)for(const v of p.variants){
   const sku=complete.norm(v.sku);if(!sku)continue;
   if(!map.has(sku))map.set(sku,{sku,product:p.title,category:p.category||'',vendor:p.vendor||'',totalOnHand:0,totalAvailable:0,totalCommitted:0,variants:[],locations:[]});
   map.get(sku).variants.push({sourceStore:r.s.key,sourceStoreLabel:r.s.label,shopifyProductId:p.id,shopifyVariantId:v.id,shopifyInventoryItemId:v.inventoryItem?.id||null,variantTitle:v.title||'',barcode:v.barcode||'',productStatus:p.status,sourceSku:v.sku,category:p.category||'',vendor:p.vendor||'',inventoryTracked:v.inventoryItem?.tracked??null,requiresShipping:v.inventoryItem?.requiresShipping??null});
  }
  const normalized=[...map.values()].sort((x,y)=>x.sku.localeCompare(y.sku));
  return res.status(200).json({ok:true,mode:'READ_ONLY_PREVIEW',writesEnabled:false,stores:results.map(r=>({key:r.s.key,label:r.s.label,productCount:r.products.length,variantCount:r.products.reduce((n,p)=>n+p.variants.length,0),pagesRetrieved:r.pages,firstCursor:r.first,finalCursor:r.final,reachedCatalogEnd:r.end})),normalizedCount:normalized.length,normalized,telemetry,generatedAt:new Date().toISOString()});
 }catch(e){return res.status(500).json({ok:false,mode:'READ_ONLY_PREVIEW',writesEnabled:false,error:e.message,telemetry})}
};
