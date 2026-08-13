(() => {
  const originalRenderReceive = renderReceive;
  let poReference = null;

  renderReceive = function () {
    originalRenderReceive();
    const section = app.querySelector('.section-head') || app.querySelector('.panel');
    if (!section || document.getElementById('createPoBtn')) return;
    const button = document.createElement('button');
    button.id = 'createPoBtn'; button.className = 'primary'; button.textContent = '+ Create Purchase Order';
    button.onclick = renderCreatePurchaseOrder;
    section.appendChild(button);
  };

  const css = document.createElement('style');
  css.textContent = `.po-create{max-width:1000px;margin:auto}.po-head-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.po-head-grid label,.po-line label{display:grid;gap:6px;font-weight:700}.po-line{display:grid;grid-template-columns:1fr 2fr 90px 90px 110px auto;gap:10px;align-items:end;border:1px solid var(--line);padding:12px;border-radius:14px;margin:10px 0}.po-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}.po-total{font-size:22px;font-weight:900;text-align:right;margin-top:14px}@media(max-width:760px){.po-head-grid,.po-line{grid-template-columns:1fr}.po-actions{flex-direction:column}.po-actions button{width:100%}}`;
  document.head.appendChild(css);

  function defaultPoNumber() {
    const d = new Date(), day = d.toISOString().slice(0,10).replaceAll('-','');
    return `PO-${day}-${String(Date.now()).slice(-4)}`;
  }
  async function loadReference() {
    if (poReference) return poReference;
    const response = await fetch('/api/warehouse?action=po-reference', { cache: 'no-store' });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not load PO setup.');
    poReference = data; return data;
  }
  async function renderCreatePurchaseOrder() {
    pageTitle.textContent = 'Create Purchase Order';
    app.innerHTML = '<section class="panel po-create"><h2>Create Purchase Order</h2><p class="muted">Loading vendors and warehouses…</p></section>';
    try {
      const ref = await loadReference();
      app.innerHTML = `<section class="panel po-create"><div class="section-head"><div><div class="eyebrow">RECEIVING</div><h2>New Purchase Order</h2></div><button id="cancelPo" class="secondary">Back</button></div>
        <div class="po-head-grid">
          <label>PO Number<input id="poNumber" value="${esc(defaultPoNumber())}"></label>
          <label>Supplier Reference Number<input id="poSupplierReference" maxlength="100" placeholder="Vendor confirmation / order number"></label>
          <label>Vendor<select id="poVendor"><option value="">Choose vendor…</option>${ref.vendors.map(v=>`<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></label>
          <label>Destination Warehouse<select id="poDestination"><option value="">Choose warehouse…</option>${ref.locations.map(l=>`<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label>
          <label>Expected Date<input id="poExpected" type="date"></label>
          <label>Shipping Cost<input id="poShipping" type="number" min="0" step="0.01" value="0.00"></label>
        </div>
        <label style="display:grid;gap:6px;font-weight:700;margin-top:12px">Notes<textarea id="poNotes" style="min-height:80px;border:1px solid var(--line);border-radius:12px;padding:12px;font:inherit"></textarea></label>
        <div class="section-head" style="margin-top:22px"><div><div class="eyebrow">MATERIAL</div><h3>PO Lines</h3></div><button id="addPoLine" class="secondary">+ Add Line</button></div>
        <div id="poLines"></div><div id="poTotal" class="po-total">Material: $0.00 · Shipping: $0.00 · PO Total: $0.00</div>
        <div class="po-actions"><button id="savePoDraft" class="secondary">Save Draft</button><button id="openPo" class="success">Save & Open for Receiving</button></div>
        <p class="permission-note">A BM Time manager PIN is required only when saving.</p></section>`;
      document.getElementById('cancelPo').onclick=()=>go('receive');
      document.getElementById('addPoLine').onclick=addLine;
      document.getElementById('savePoDraft').onclick=()=>savePo('draft');
      document.getElementById('openPo').onclick=()=>savePo('open');
      document.getElementById('poShipping').oninput=updateTotal;
      addLine();
    } catch (error) { app.querySelector('.po-create').innerHTML=`<h2>Could not open PO creator</h2><p>${esc(error.message)}</p><button class="secondary" onclick="go('receive')">Back</button>`; }
  }
  function addLine() {
    const row = document.createElement('div'); row.className='po-line';
    row.innerHTML=`<label>SKU<input data-field="sku" placeholder="SKU / barcode"></label><label>Description<input data-field="name" placeholder="Material description"></label><label>UOM<select data-field="uom"><option>EA</option><option>LF</option><option>PK</option><option>BDL</option></select></label><label>Qty<input data-field="qty" type="number" min="0.01" step="0.01" value="1"></label><label>Unit Cost<input data-field="cost" type="number" min="0" step="0.01" value="0.00"></label><button class="danger" data-remove>Remove</button>`;
    row.querySelector('[data-remove]').onclick=()=>{row.remove();updateTotal()};
    row.querySelectorAll('input').forEach(i=>i.oninput=updateTotal);
    document.getElementById('poLines').appendChild(row); updateTotal();
  }
  function collectLines() {
    return [...document.querySelectorAll('.po-line')].map(row=>({sku:row.querySelector('[data-field=sku]').value.trim(),name:row.querySelector('[data-field=name]').value.trim(),uom:row.querySelector('[data-field=uom]').value,orderedQty:Number(row.querySelector('[data-field=qty]').value),unitCost:Number(row.querySelector('[data-field=cost]').value)})).filter(l=>l.sku||l.name);
  }
  function updateTotal(){const material=collectLines().reduce((s,l)=>s+(l.orderedQty||0)*(l.unitCost||0),0),shipping=Math.max(0,Number(document.getElementById('poShipping')?.value||0)),total=material+shipping;const money=n=>n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});const el=document.getElementById('poTotal');if(el)el.textContent=`Material: $${money(material)} · Shipping: $${money(shipping)} · PO Total: $${money(total)}`}
  async function managerUnlock() {
    const pin = window.prompt('Manager approval required. Enter your BM Time manager PIN:');
    if (!pin) throw new Error('Save cancelled.');
    const response = await fetch('/api/warehouse?action=login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});
    const data=await response.json(); if(!response.ok) throw new Error(data.error||'Manager PIN not recognized.');
    if(data.employee?.role!=='Manager') throw new Error('A manager PIN is required.');
    return data.employee;
  }
  async function savePo(status) {
    const lines=collectLines();
    if(!document.getElementById('poVendor').value||!document.getElementById('poDestination').value)return notify('Choose a vendor and destination warehouse');
    if(!lines.length||lines.some(l=>!l.sku||!(l.orderedQty>0)))return notify('Every line needs a SKU and quantity');
    const draftBtn=document.getElementById('savePoDraft'),openBtn=document.getElementById('openPo');draftBtn.disabled=openBtn.disabled=true;
    try{
      await managerUnlock();
      const response=await fetch('/api/warehouse?action=create-po',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({poNumber:document.getElementById('poNumber').value,supplierReferenceNumber:document.getElementById('poSupplierReference').value,vendorId:document.getElementById('poVendor').value,destinationLocationId:document.getElementById('poDestination').value,expectedDate:document.getElementById('poExpected').value||null,shippingCost:Number(document.getElementById('poShipping').value||0),notes:document.getElementById('poNotes').value,status,lines})});
      const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not save PO.');
      app.innerHTML=`<section class="completion-card"><div class="completion-icon">✓</div><div class="eyebrow" style="margin-top:14px">PURCHASE ORDER ${status==='open'?'OPEN':'SAVED'}</div><h2>${esc(data.purchaseOrder.po_number)}</h2><p class="muted">${data.purchaseOrder.lineCount} material line${data.purchaseOrder.lineCount===1?'':'s'} · created by ${esc(data.purchaseOrder.createdBy)}</p><div class="completion-actions"><button id="donePo" class="primary">Back to Receiving</button></div></section>`;
      document.getElementById('donePo').onclick=()=>go('receive');
    }catch(error){notify(error.message)}finally{if(document.getElementById('savePoDraft'))draftBtn.disabled=openBtn.disabled=false}
  }
})();
