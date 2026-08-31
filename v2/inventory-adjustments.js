(() => {
  const $ = id => document.getElementById(id);
  let loaded = false; let products = [];
  const set = (text, error=false) => { $('adjustmentStatus').textContent=text; $('adjustmentStatus').classList.toggle('error',error); };
  const key = () => 'adjust-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  function renderProducts() {
    const term=$('adjustmentProductSearch').value.trim().toLowerCase(), host=$('adjustmentProductOptions');
    host.replaceChildren();
    products.filter(p => !term || (p.sku+' '+p.name).toLowerCase().includes(term)).slice(0,12).forEach(p => {
      const option=document.createElement('button'); option.type='button'; option.className='product-suggestion';
      option.innerHTML='<strong>'+p.sku+'</strong> · '+p.name+'<small>On hand: '+p.quantity+' · Allocated: '+p.allocatedQuantity+'</small>';
      option.onclick=()=>{ $('adjustmentProductId').value=p.id; $('adjustmentProductSearch').value=p.sku+' · '+p.name; host.hidden=true; };
      host.append(option);
    });
    host.hidden=!host.childNodes.length;
  }
  function renderLedger(rows) {
    const body=$('adjustmentLedgerRows'); body.replaceChildren();
    if(!rows.length){body.innerHTML='<tr><td colspan="8">No damage or missing-stock adjustments at this warehouse yet.</td></tr>';return;}
    rows.forEach(row=>{const tr=document.createElement('tr'), adjustmentReason=row.metadata?.adjustmentReason, reason=adjustmentReason === 'damage' ? 'Damaged' : adjustmentReason === 'added_stock' ? 'Added stock' : 'Missing stock';
      [new Date(row.created_at).toLocaleString(),row.products?.sku||'—',row.products?.name||'—',reason,(Number(row.quantity_delta)>0?'+':'')+String(Number(row.quantity_delta)),String(row.quantity_before)+' → '+String(row.quantity_after),row.performed_by_name||'—',row.metadata?.note||'—'].forEach(value=>{const td=document.createElement('td');td.textContent=value;tr.append(td)});body.append(tr);
    });
  }
  async function load() {
    const locationId=$('adjustmentLocation').value;
    set('Loading items…');
    const response=await fetch('/api/inventory-adjustments?locationId='+encodeURIComponent(locationId)+'&search='+encodeURIComponent($('adjustmentProductSearch').value),{credentials:'same-origin'});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(data.error||'Could not load inventory adjustments.');
    const location=$('adjustmentLocation'); if(!loaded){ location.replaceChildren(); data.locations.forEach(item=>{const option=document.createElement('option');option.value=item.id;option.textContent=item.name;location.append(option)});location.value=data.locationId;loaded=true; }
    products=data.products||[]; set('Choose an item and enter the quantity.');
  }
  function open(){ $('inventoryAdjustmentDialog').showModal(); load().catch(error=>set(error.message,true)); }
  async function save(){
    const productId=Number($('adjustmentProductId').value), quantity=Number($('adjustmentQuantity').value);
    if(!productId||!quantity||quantity<=0)throw Error('Choose an item and enter a quantity greater than zero.');
    const response=await fetch('/api/inventory-adjustments',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({locationId:Number($('adjustmentLocation').value),productId,quantity,reason:$('adjustmentReason').value,note:$('adjustmentNote').value,idempotencyKey:key()})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(data.error||'Inventory adjustment failed.');
    $('adjustmentProductId').value='';$('adjustmentProductSearch').value='';$('adjustmentQuantity').value='';$('adjustmentNote').value='';
    await load(); set((data.adjustment.reason==='added_stock'?'Added ':'Recorded ')+data.adjustment.quantity+' of '+data.adjustment.sku+(data.adjustment.reason==='damage'?' as damaged.':data.adjustment.reason==='missing_stock'?' as missing stock.':' to on-hand inventory.'));
  }
  window.BMWarehouseQuickAdjustment = open;
  $('overviewInventoryAdjustment').onclick=open;
  $('adjustmentLocation').onchange=()=>load().catch(error=>set(error.message,true));
  $('adjustmentProductSearch').oninput=renderProducts;
  $('adjustmentProductSearch').onfocus=renderProducts;
  $('adjustmentSave').onclick=()=>save().catch(error=>set(error.message,true));
})();