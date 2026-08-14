(() => {
  const originalRenderReceive = renderReceive;
  let poReference = null;

  renderReceive = function () {
    pageTitle.textContent='Receiving';
    const canCreate=state.employee?.permissions?.includes('create_docs');
    app.innerHTML=`<section class="panel"><div class="section-head"><div><div class="eyebrow">RECEIVING</div><h2>What are you doing?</h2></div></div><div class="transfer-choice-grid">${canCreate?'<button class="transfer-choice primary-choice" id="createPoBtn"><div><div class="choice-icon">＋</div><h3>Create PO</h3><p class="muted">Build and save a purchase order for incoming material.</p></div><strong>Start ›</strong></button>':''}<button class="transfer-choice check-choice" id="receivePoBtn"><div><div class="choice-icon">▣</div><h3>Receive PO</h3><p class="muted">Open a purchase order and receive incoming material.</p></div><strong>Receive ›</strong></button></div></section>`;
    const create=document.getElementById('createPoBtn');if(create)create.onclick=renderCreatePurchaseOrder;
    document.getElementById('receivePoBtn').onclick=()=>{pageTitle.textContent='Receive PO';app.innerHTML='';originalRenderReceive()};
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
        <p class="permission-note">Your Google Workspace login authorizes this purchase order.</p></section>`;
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
  function printPurchaseOrder(po) {
    const materialTotal=po.lines.reduce((sum,line)=>sum+(line.orderedQty||0)*(line.unitCost||0),0),grandTotal=materialTotal+po.shippingCost;
    const money=value=>Number(value||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
    const rows=po.lines.map(line=>`<tr><td>${esc(line.sku)}</td><td>${esc(line.name)}</td><td>${esc(line.uom)}</td><td>${Number(line.orderedQty).toLocaleString()}</td><td>$${money(line.unitCost)}</td><td>$${money(line.orderedQty*line.unitCost)}</td></tr>`).join('');
    const body=`<h1>Bargain Moulding — Purchase Order</h1><div class="muted">${esc(po.poNumber)} · ${fmtDate(new Date())}</div><div class="meta"><div><strong>Vendor</strong><br>${esc(po.vendorName)}</div><div><strong>Destination</strong><br>${esc(po.destinationName)}</div><div><strong>Supplier Reference</strong><br>${esc(po.supplierReferenceNumber||'—')}</div><div><strong>Expected Date</strong><br>${esc(po.expectedDate||'—')}</div><div><strong>Status</strong><br>${esc(po.status==='open'?'Open for Receiving':'Draft')}</div><div><strong>Created By</strong><br>${esc(po.createdBy)}</div></div><table><thead><tr><th>SKU</th><th>Description</th><th>UOM</th><th>Qty</th><th>Unit Cost</th><th>Line Total</th></tr></thead><tbody>${rows}</tbody></table><div style="margin:18px 0 0 auto;width:300px"><div style="display:flex;justify-content:space-between;padding:5px"><span>Material</span><strong>$${money(materialTotal)}</strong></div><div style="display:flex;justify-content:space-between;padding:5px"><span>Shipping</span><strong>$${money(po.shippingCost)}</strong></div><div style="display:flex;justify-content:space-between;padding:10px 5px;border-top:2px solid #111;font-size:18px"><span>PO Total</span><strong>$${money(grandTotal)}</strong></div></div>${po.notes?`<div style="margin-top:20px"><strong>Notes</strong><p>${esc(po.notes)}</p></div>`:''}<div class="sig"><div class="line">Authorized By</div><div class="line">Vendor Confirmation</div></div>`;
    printWindow(`Purchase Order ${po.poNumber}`,body);
  }
  async function savePo(status) {
    const lines=collectLines();
    if(!document.getElementById('poVendor').value||!document.getElementById('poDestination').value)return notify('Choose a vendor and destination warehouse');
    if(!lines.length||lines.some(l=>!l.sku||!(l.orderedQty>0)))return notify('Every line needs a SKU and quantity');
    const draftBtn=document.getElementById('savePoDraft'),openBtn=document.getElementById('openPo');draftBtn.disabled=openBtn.disabled=true;
    try{
      const token=await window.bmGoogleAuth.accessToken();if(!token)throw new Error('Your Google session expired. Refresh and sign in again.');
      const vendor=document.getElementById('poVendor'),destination=document.getElementById('poDestination');
      const printable={poNumber:document.getElementById('poNumber').value,supplierReferenceNumber:document.getElementById('poSupplierReference').value,vendorId:vendor.value,vendorName:vendor.selectedOptions[0]?.textContent||'',destinationLocationId:destination.value,destinationName:destination.selectedOptions[0]?.textContent||'',expectedDate:document.getElementById('poExpected').value||null,shippingCost:Number(document.getElementById('poShipping').value||0),notes:document.getElementById('poNotes').value,status,lines};
      const response=await fetch('/api/warehouse?action=create-po',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(printable)});
      const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not save PO.');
      printable.poNumber=data.purchaseOrder.po_number;printable.createdBy=data.purchaseOrder.createdBy;
      app.innerHTML=`<section class="completion-card"><div class="completion-icon">✓</div><div class="eyebrow" style="margin-top:14px">PURCHASE ORDER ${status==='open'?'OPEN':'SAVED'}</div><h2>${esc(data.purchaseOrder.po_number)}</h2><p class="muted">${data.purchaseOrder.lineCount} material line${data.purchaseOrder.lineCount===1?'':'s'} · created by ${esc(data.purchaseOrder.createdBy)}</p><div class="completion-actions"><button id="printPo" class="print-btn">🖨 Print Purchase Order</button><button id="donePo" class="primary">Back to Receiving</button></div></section>`;
      document.getElementById('printPo').onclick=()=>printPurchaseOrder(printable);
      document.getElementById('donePo').onclick=()=>go('receive');
    }catch(error){notify(error.message)}finally{if(document.getElementById('savePoDraft'))draftBtn.disabled=openBtn.disabled=false}
  }
})();
