/* Bargain Warehouse: main document barcode patch.
   Adds a scanner-friendly Code 39 document barcode to printed PO and transfer paperwork. */
(function () {
  const CODE39 = {
    '0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw','5':'wnnwwnnnn','6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn',
    'A':'wnnnnwnnw','B':'nnwnnwnnw','C':'wnwnnwnnn','D':'nnnnwwnnw','E':'wnnnwwnnn','F':'nnwnwwnnn','G':'nnnnnwwnw','H':'wnnnnwwnn','I':'nnwnnwwnn','J':'nnnnwwwnn',
    'K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww','O':'wnnnwnnwn','P':'nnwnwnnwn','Q':'nnnnnnwww','R':'wnnnnnwwn','S':'nnwnnnwwn','T':'nnnnwnwwn',
    'U':'wwnnnnnnw','V':'nwwnnnnnw','W':'wwwnnnnnn','X':'nwnnwnnnw','Y':'wwnnwnnnn','Z':'nwwnwnnnn','-':'nwnnnnwnw','.':'wwnnnnwnn',' ':'nwwnnnwnn','$':'nwnwnwnnn','/':'nwnwnnnwn','+':'nwnnnwnwn','%':'nnnwnwnwn','*':'nwnnwnwnn'
  };

  function normalizedBarcodeValue(value) {
    return String(value || '').toUpperCase().replace(/[^0-9A-Z.\- $/+%]/g, '-').slice(0, 42);
  }

  function code39Svg(value) {
    const clean = normalizedBarcodeValue(value);
    const encoded = '*' + clean + '*';
    const narrow = 2, wide = 5, gap = 2, height = 66;
    let x = 12;
    const bars = [];
    for (const ch of encoded) {
      const pattern = CODE39[ch] || CODE39['-'];
      for (let i = 0; i < 9; i++) {
        const width = pattern[i] === 'w' ? wide : narrow;
        if (i % 2 === 0) bars.push(`<rect x="${x}" y="4" width="${width}" height="${height}" fill="#000"/>`);
        x += width;
      }
      x += gap;
    }
    const total = x + 12;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} 94" width="100%" height="94" role="img" aria-label="Barcode ${clean}">${bars.join('')}<text x="${total/2}" y="88" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" font-weight="700">${clean}</text></svg>`;
  }

  function documentBarcode(value, label) {
    const safeLabel = String(label || 'MAIN DOCUMENT BARCODE').replace(/[<>&]/g, '');
    return `<div class="main-doc-barcode"><div class="main-doc-barcode-label">${safeLabel}</div>${code39Svg(value)}</div>`;
  }

  function addBarcodePrintStyles(body) {
    return `<style>
      .main-doc-barcode{margin:14px 0 18px;padding:10px 14px;border:2px solid #111;border-radius:8px;max-width:520px;break-inside:avoid}
      .main-doc-barcode-label{font:700 10px Arial,sans-serif;letter-spacing:.12em;margin-bottom:3px;color:#333}
      .main-doc-barcode svg{display:block;width:100%;height:94px}
      @media print{.main-doc-barcode{page-break-inside:avoid}}
    </style>${body}`;
  }

  if (typeof window.printTicket === 'function') {
    const originalPrintTicket = window.printTicket;
    window.printTicket = function (tx, kind) {
      if (kind !== 'receive' && kind !== 'transfer') return originalPrintTicket(tx, kind);
      let value, label;
      if (kind === 'receive') {
        value = `PO-${tx.po}`;
        label = 'MAIN PO BARCODE — SCAN TO OPEN PO';
      } else {
        value = String(tx.ref || '').toUpperCase().startsWith('TR-') ? tx.ref : `TR-${tx.ref}`;
        label = 'MAIN TRANSFER BARCODE — SCAN TO OPEN TRANSFER';
      }
      let body=`<h1>Bargain Moulding — ${esc(tx.type)} Ticket</h1><div class="muted">${esc(tx.ref)} · ${fmtDate(tx.date)}</div>${documentBarcode(value,label)}<div class="meta"><div><strong>Employee</strong><br>${esc(tx.employee)}</div><div><strong>Location</strong><br>${esc(tx.location||tx.from||'')}</div>`;
      if(kind==='receive') body+=`<div><strong>PO</strong><br>${esc(tx.po)}</div><div><strong>Supplier</strong><br>${esc(tx.supplier)}</div><div><strong>Status</strong><br>${esc(tx.status)}</div><div><strong>Good Pieces</strong><br>${tx.total}</div>`;
      if(kind==='transfer') body+=`<div><strong>Move From</strong><br>${esc(tx.from)}</div><div><strong>Move To</strong><br>${esc(tx.to)}</div><div><strong>Total Pieces</strong><br>${tx.total}</div><div><strong>Status</strong><br>${esc(tx.status||'Ready to Move')}</div>${tx.note?`<div><strong>Note</strong><br>${esc(tx.note)}</div>`:''}`;
      body+='</div>';
      body+=`<table><thead><tr><th>SKU</th><th>Description</th><th>Qty</th><th>Problems</th></tr></thead><tbody>${(tx.lines||[]).map(l=>`<tr><td>${esc(l.sku||'')}</td><td>${esc(l.name||'')}</td><td>${Number(l.qty||0).toLocaleString()}</td><td>${l.problems?.length?l.problems.map(p=>`${esc(p.type)} — ${p.qty}${p.note?` — ${esc(p.note)}`:''}${p.photo?' — photo attached':''}`).join('<br>'):'—'}</td></tr>`).join('')}</tbody></table>`;
      body+=`<div class="sig"><div class="line">Employee Signature</div><div class="line">Manager / Receiver</div></div>`;
      printWindow(`${tx.type} ${tx.ref}`, addBarcodePrintStyles(body));
    };
  }

  if (typeof window.printTransferCheck === 'function') {
    window.printTransferCheck = function(tx){
      const value=String(tx.ref||'').toUpperCase().startsWith('TR-')?tx.ref:`TR-${tx.ref}`;
      let body=`<h1>Bargain Moulding — Transfer Check</h1><div class="muted">${esc(tx.ref)} · ${fmtDate(tx.date)}</div>${documentBarcode(value,'MAIN TRANSFER BARCODE — SCAN TO OPEN TRANSFER')}<div class="meta"><div><strong>Checked By</strong><br>${esc(tx.employee)}</div><div><strong>Status</strong><br>${esc(tx.status)}</div><div><strong>Move From</strong><br>${esc(tx.from)}</div><div><strong>Move To</strong><br>${esc(tx.to)}</div><div><strong>Expected Pieces</strong><br>${tx.expectedTotal}</div><div><strong>Scanned Pieces</strong><br>${tx.total}</div>${tx.note?`<div><strong>Problem Note</strong><br>${esc(tx.note)}</div>`:''}</div><table><thead><tr><th>SKU</th><th>Description</th><th>Expected</th><th>Scanned</th><th>Missing</th></tr></thead><tbody>${tx.lines.map(l=>`<tr><td>${esc(l.sku)}</td><td>${esc(l.name)}</td><td>${l.expected}</td><td>${l.qty}</td><td>${l.expected-l.qty}</td></tr>`).join('')}</tbody></table><div class="sig"><div class="line">Warehouse Manager Signature</div><div class="line">Receiver / Driver</div></div>`;
      printWindow(`Transfer Check ${tx.ref}`,addBarcodePrintStyles(body));
    };
  }

  window.bargainDocumentBarcode = { code39Svg, documentBarcode };
})();
