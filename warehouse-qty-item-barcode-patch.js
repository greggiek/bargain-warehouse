/* Bargain Warehouse UX patch
   1) Adds a quantity field to scanner workflows so one barcode scan can add/check multiple pieces.
   2) Adds a Code 39 barcode to each item line on printed PO/transfer tickets.
*/
(function(){
  const BC = () => window.bargainDocumentBarcode;
  const configs = [
    {input:'receiveScan', button:'receiveScanBtn', label:'Receive Qty'},
    {input:'transferSku', button:'transferAdd', label:'Move Qty'},
    {input:'checkItemScan', button:'checkItemBtn', label:'Check Qty'},
    {input:'verifyItemScan', button:'verifyItemBtn', label:'Qty'},
    {input:'finalItemScan', button:'finalItemBtn', label:'Qty'}
  ];

  function enhanceScanner(cfg){
    const input=document.getElementById(cfg.input), button=document.getElementById(cfg.button);
    if(!input||!button||button.dataset.qtyEnhanced==='1') return;
    button.dataset.qtyEnhanced='1';
    const row=input.closest('.scan-row'); if(!row) return;
    const qtyWrap=document.createElement('label');
    qtyWrap.className='warehouse-qty-wrap';
    qtyWrap.innerHTML=`<span>${cfg.label}</span><input class="warehouse-qty" type="number" inputmode="numeric" min="1" step="1" value="1" aria-label="${cfg.label}">`;
    row.insertBefore(qtyWrap,button);
    input.placeholder=input.placeholder.replace(/\s*[—-]\s*each scan\s*=\s*1 piece/i,'');
    const qtyInput=qtyWrap.querySelector('input');
    const originalClick=button.onclick;
    if(typeof originalClick==='function'){
      button.onclick=function(ev){
        const qty=Math.max(1,Math.min(9999,parseInt(qtyInput.value,10)||1));
        const scanned=String(input.value||'').trim();
        if(!scanned) return originalClick.call(this,ev);
        for(let i=0;i<qty;i++){
          input.value=scanned;
          originalClick.call(this,ev);
          if(!document.body.contains(input)) break;
        }
        if(document.body.contains(qtyInput)) qtyInput.value='1';
      };
    }
    row.addEventListener('keydown',function(ev){
      if(ev.key==='Enter' && ev.target===input && Number(qtyInput.value)>1){
        ev.preventDefault(); ev.stopImmediatePropagation(); button.click();
      }
    },true);
  }

  function enhanceAll(){ configs.forEach(enhanceScanner); }
  const obs=new MutationObserver(enhanceAll); obs.observe(document.documentElement,{childList:true,subtree:true}); enhanceAll();

  const style=document.createElement('style');
  style.textContent=`
    .scan-row:has(.warehouse-qty-wrap){grid-template-columns:minmax(0,1fr) 110px auto;align-items:end}
    .warehouse-qty-wrap{display:grid;gap:5px;font-size:12px;font-weight:800;color:var(--muted,#6b7280)}
    .warehouse-qty{width:100%;min-height:56px!important;text-align:center;font-size:20px!important;font-weight:900;padding:0 8px!important}
    @media(max-width:640px){.scan-row:has(.warehouse-qty-wrap){grid-template-columns:minmax(0,1fr) 92px}.scan-row:has(.warehouse-qty-wrap)>button{grid-column:1/-1}.warehouse-qty{min-height:50px!important}}
  `; document.head.appendChild(style);

  function itemBarcodeCell(line){
    const value=String(line.barcode||line.sku||'').trim();
    if(!value||!BC()) return '—';
    return `<div style="width:190px;max-width:190px">${BC().code39Svg(value)}</div>`;
  }

  function printRows(lines, mode){
    return (lines||[]).map(l=>{
      const qty=mode==='check' ? l.expected : Number(l.qty||0);
      const qty2=mode==='check' ? `<td>${l.qty}</td><td>${l.expected-l.qty}</td>` : '';
      const problems=mode==='ticket' ? `<td>${l.problems?.length?l.problems.map(p=>`${esc(p.type)} — ${p.qty}${p.note?` — ${esc(p.note)}`:''}${p.photo?' — photo attached':''}`).join('<br>'):'—'}</td>` : '';
      return `<tr><td>${esc(l.sku||'')}</td><td>${esc(l.name||'')}</td><td class="item-barcode-cell">${itemBarcodeCell(l)}</td><td>${Number(qty||0).toLocaleString()}</td>${qty2}${problems}</tr>`;
    }).join('');
  }

  function printStyles(body){
    return `<style>
      .item-barcode-cell svg{display:block;width:180px;height:58px}.item-barcode-cell svg text{font-size:12px}
      .main-doc-barcode{margin:14px 0 18px;padding:10px 14px;border:2px solid #111;border-radius:8px;max-width:520px;break-inside:avoid}
      .main-doc-barcode-label{font:700 10px Arial,sans-serif;letter-spacing:.12em;margin-bottom:3px;color:#333}
      .main-doc-barcode svg{display:block;width:100%;height:94px}
      @media print{.item-barcode-cell{width:190px}.item-barcode-cell svg{width:180px!important;height:58px!important}}
    </style>${body}`;
  }

  // Replace PO / Create Transfer printout with a main document barcode + barcode on every item line.
  window.printTicket=function(tx,kind){
    if(kind==='adjust'){
      let body=`<h1>Bargain Moulding — ${esc(tx.type)} Ticket</h1><div class="muted">${esc(tx.ref)} · ${fmtDate(tx.date)}</div><div class="meta"><div><strong>Employee</strong><br>${esc(tx.employee)}</div><div><strong>Location</strong><br>${esc(tx.location||'')}</div><div><strong>SKU</strong><br>${esc(tx.sku)}</div><div><strong>Reason</strong><br>${esc(tx.reason)}</div><div><strong>Old Quantity</strong><br>${tx.oldQty.toLocaleString()}</div><div><strong>New Quantity</strong><br>${tx.newQty.toLocaleString()}</div><div><strong>Difference</strong><br>${tx.variance>=0?'+':''}${tx.variance.toLocaleString()}</div><div><strong>Unit Cost</strong><br>$${tx.unitCost.toFixed(2)}</div><div><strong>Cost Impact</strong><br>${tx.costImpact<0?'-':'+'}$${Math.abs(tx.costImpact).toFixed(2)}</div></div><div class="sig"><div class="line">Employee Signature</div><div class="line">Manager / Receiver</div></div>`;
      return printWindow(`${tx.type} ${tx.ref}`,body);
    }
    const isPO=kind==='receive';
    const mainValue=isPO?`PO-${tx.po}`:(String(tx.ref||'').toUpperCase().startsWith('TR-')?tx.ref:`TR-${tx.ref}`);
    const mainLabel=isPO?'MAIN PO BARCODE — SCAN TO OPEN PO':'MAIN TRANSFER BARCODE — SCAN TO OPEN TRANSFER';
    let body=`<h1>Bargain Moulding — ${esc(tx.type)} Ticket</h1><div class="muted">${esc(tx.ref)} · ${fmtDate(tx.date)}</div>${BC()?BC().documentBarcode(mainValue,mainLabel):''}<div class="meta"><div><strong>Employee</strong><br>${esc(tx.employee)}</div><div><strong>Location</strong><br>${esc(tx.location||tx.from||'')}</div>`;
    if(isPO) body+=`<div><strong>PO</strong><br>${esc(tx.po)}</div><div><strong>Supplier</strong><br>${esc(tx.supplier)}</div><div><strong>Status</strong><br>${esc(tx.status)}</div><div><strong>Good Pieces</strong><br>${tx.total}</div>`;
    else body+=`<div><strong>Move From</strong><br>${esc(tx.from)}</div><div><strong>Move To</strong><br>${esc(tx.to)}</div><div><strong>Total Pieces</strong><br>${tx.total}</div><div><strong>Status</strong><br>${esc(tx.status||'Ready to Move')}</div>${tx.note?`<div><strong>Note</strong><br>${esc(tx.note)}</div>`:''}`;
    body+=`</div><table><thead><tr><th>SKU</th><th>Description</th><th>Item Barcode</th><th>Qty</th><th>Problems</th></tr></thead><tbody>${printRows(tx.lines||[],'ticket')}</tbody></table><div class="sig"><div class="line">Employee Signature</div><div class="line">Manager / Receiver</div></div>`;
    printWindow(`${tx.type} ${tx.ref}`,printStyles(body));
  };

  window.printTransferCheck=function(tx){
    const value=String(tx.ref||'').toUpperCase().startsWith('TR-')?tx.ref:`TR-${tx.ref}`;
    let body=`<h1>Bargain Moulding — Transfer Check</h1><div class="muted">${esc(tx.ref)} · ${fmtDate(tx.date)}</div>${BC()?BC().documentBarcode(value,'MAIN TRANSFER BARCODE — SCAN TO OPEN TRANSFER'):''}<div class="meta"><div><strong>Checked By</strong><br>${esc(tx.employee)}</div><div><strong>Status</strong><br>${esc(tx.status)}</div><div><strong>Move From</strong><br>${esc(tx.from)}</div><div><strong>Move To</strong><br>${esc(tx.to)}</div><div><strong>Expected Pieces</strong><br>${tx.expectedTotal}</div><div><strong>Scanned Pieces</strong><br>${tx.total}</div>${tx.note?`<div><strong>Problem Note</strong><br>${esc(tx.note)}</div>`:''}</div><table><thead><tr><th>SKU</th><th>Description</th><th>Item Barcode</th><th>Expected</th><th>Scanned</th><th>Missing</th></tr></thead><tbody>${printRows(tx.lines||[],'check')}</tbody></table><div class="sig"><div class="line">Warehouse Manager Signature</div><div class="line">Receiver / Driver</div></div>`;
    printWindow(`Transfer Check ${tx.ref}`,printStyles(body));
  };
})();
