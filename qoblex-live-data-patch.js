/* Live Qoblex product catalog adapter */
(function(){
  const live={ready:false,loading:false,error:null,bySku:new Map(),byBarcode:new Map(),products:[]};
  function normalizeVariant(v,p){
    const sku=String(v?.sku||v?.code||v?.item_code||'').trim();
    const barcode=String(v?.barcode||v?.barcode_value||v?.upc||v?.ean||'').trim();
    return {id:v?.id,productId:p?.id,sku,barcode,name:v?.name||p?.name||sku,raw:v};
  }
  function indexPayload(payload){
    const rows=payload?.products||payload?.data||payload||[];
    live.products=Array.isArray(rows)?rows:[];live.bySku.clear();live.byBarcode.clear();
    for(const p of live.products){
      const variants=Array.isArray(p?.variants)&&p.variants.length?p.variants:[p];
      for(const v of variants){const n=normalizeVariant(v,p);if(n.sku)live.bySku.set(n.sku.toUpperCase(),n);if(n.barcode)live.byBarcode.set(n.barcode,n)}
    }
    live.ready=true;live.error=null;
  }
  async function loadAll(){
    if(live.loading)return;live.loading=true;
    try{
      let page=1;let all=[];let expected=null;
      while(page<=40){
        const r=await fetch('/api/qoblex-products?page='+page+'&page_size=50',{cache:'no-store'});if(!r.ok)throw new Error('Qoblex products '+r.status);
        const j=await r.json();const rows=j.products||j.data||[];if(expected==null)expected=j.count||j.total||null;if(!Array.isArray(rows)||!rows.length)break;all.push(...rows);if(rows.length<50||(expected&&all.length>=expected))break;page++;
      }
      indexPayload({products:all});
      try{window.products=window.products||{};for(const n of live.bySku.values()){window.products[n.sku]={...(window.products[n.sku]||{}),sku:n.sku,name:n.name,barcode:n.barcode||n.sku,qoblexId:n.id,live:true};if(n.barcode)window.products[n.barcode]=window.products[n.sku]}}catch(e){}
      document.dispatchEvent(new CustomEvent('qoblex-live-ready',{detail:{products:live.products.length,skus:live.bySku.size}}));
    }catch(e){live.error=e;console.error('Qoblex live catalog failed',e)}finally{live.loading=false}
  }
  function find(code){const q=String(code||'').trim();return live.byBarcode.get(q)||live.bySku.get(q.toUpperCase())||null}
  window.qoblexLive={loadAll,find,state:live};
  loadAll();
})();