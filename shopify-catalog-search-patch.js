(() => {
  const warehouseLocations={
    '336 Bayview':['Bayview Warehouse'],
    'Bargain Moulding (Bohemia)':['Bohemia Warehouse'],
    'Outpost - Ronkonkoma':['Outpost - Ronkonkoma'],
    '1133 Old Country (Riverhead)':['Riverhead Warehouse'],
    '730 Windham Rd':['730 Windham Rd'],
    'Annex Warehouse':['Annex (Retail) 730']
  };
  let timer=null,controller=null;
  const cache=new Map();
  const style=document.createElement('style');
  style.textContent=`.shopify-search-wrap{position:relative}.shopify-search-results{position:absolute;z-index:60;top:100%;left:0;right:0;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 16px 40px rgba(15,23,42,.18);max-height:420px;overflow:auto;margin-top:4px}.po-line .shopify-search-results{right:auto;width:min(920px,calc(100vw - 390px));min-width:620px}.shopify-search-item{display:grid;grid-template-columns:150px minmax(280px,1fr) auto;align-items:start;gap:16px;width:100%;padding:14px 16px;border:0;border-bottom:1px solid var(--line);background:#fff;text-align:left}.shopify-search-item:hover{background:#f8fafc}.shopify-search-item:last-child{border-bottom:0}.shopify-search-sku{font-weight:900}.shopify-search-name{color:var(--muted);line-height:1.35;overflow-wrap:anywhere}.shopify-search-qty{font-weight:900;white-space:nowrap}.shopify-search-status{padding:16px;color:var(--muted);font-size:13px}@media(max-width:900px){.po-line .shopify-search-results{width:min(680px,calc(100vw - 48px));min-width:0}}@media(max-width:700px){.shopify-search-item{grid-template-columns:1fr;gap:5px}.shopify-search-qty{text-align:left}.po-line .shopify-search-results{position:fixed;left:16px;right:16px;top:20%;width:auto;max-height:65vh}}`;
  document.head.appendChild(style);

  async function search(term){
    const key=term.trim().toLowerCase();if(cache.has(key))return cache.get(key);
    if(controller)controller.abort();controller=new AbortController();
    const token=await window.bmGoogleAuth?.accessToken();if(!token)throw new Error('Sign in with your Bargain Moulding Google account.');
    const response=await fetch(`/api/shopify-catalog-search?q=${encodeURIComponent(term)}`,{signal:controller.signal,headers:{Authorization:`Bearer ${token}`}});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Shopify search failed');if(data.writesEnabled!==false)throw new Error('Shopify safety check failed');cache.set(key,data.items||[]);return data.items||[];
  }
  function atWarehouse(item,warehouse){const names=warehouseLocations[warehouse]||[warehouse];return(item.locations||[]).filter(l=>names.includes(l.locationName)).reduce((s,l)=>s+Number(l.onHand||0),0)}
  function attach(input,mode){
    if(input.dataset.shopifySearch==='1')return;input.dataset.shopifySearch='1';
    const label=input.closest('label')||input.parentElement;label.classList.add('shopify-search-wrap');
    const box=document.createElement('div');box.className='shopify-search-results hidden';label.appendChild(box);
    input.setAttribute('autocomplete','off');input.placeholder=mode==='po'?'Search Shopify by SKU, barcode, or name':'Search Shopify material';
    input.addEventListener('input',()=>{clearTimeout(timer);const term=input.value.trim();if(term.length<2){box.classList.add('hidden');return}box.classList.remove('hidden');box.innerHTML='<div class="shopify-search-status">Searching both Shopify stores…</div>';timer=setTimeout(async()=>{try{const items=await search(term);render(items)}catch(error){if(error.name!=='AbortError')box.innerHTML=`<div class="shopify-search-status">${esc(error.message)}</div>`}},300)});
    input.addEventListener('keydown',e=>{if(e.key==='Escape')box.classList.add('hidden')});
    function render(items){
      if(!items.length){box.innerHTML='<div class="shopify-search-status">No Shopify items found.</div>';return}
      box.innerHTML=items.map((item,i)=>{const qty=mode==='transfer'?atWarehouse(item,state.location):item.totalOnHand;return`<button type="button" class="shopify-search-item" data-result="${i}"><span class="shopify-search-sku">${esc(item.sku)}</span><span class="shopify-search-name">${esc(item.product)}${item.barcode?` · ${esc(item.barcode)}`:''}</span><span class="shopify-search-qty">${qty.toLocaleString()} on hand${mode==='transfer'?' here':' total'}</span></button>`}).join('');
      box.querySelectorAll('[data-result]').forEach(button=>button.onclick=()=>select(items[Number(button.dataset.result)]));
    }
    function select(item){
      input.value=item.sku;box.classList.add('hidden');
      if(mode==='po'){const row=input.closest('.po-line');row.querySelector('[data-field=name]').value=item.product||''}
      else{const onHand=atWarehouse(item,state.location);products[item.sku]={sku:item.sku,name:item.product||item.sku,barcode:item.barcode||item.sku,onHand,cost:0};notify(`${item.sku} selected · ${onHand.toLocaleString()} on hand at ${state.location}`)}
    }
  }
  function enhance(){document.querySelectorAll('.po-line [data-field=sku]').forEach(input=>attach(input,'po'));const transfer=document.getElementById('transferSku');if(transfer)attach(transfer,'transfer')}
  const observer=new MutationObserver(enhance);observer.observe(document.documentElement,{childList:true,subtree:true});enhance();
})();
