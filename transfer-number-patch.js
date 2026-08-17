(() => {
  let pendingTransferNumber = null;

  const originalRenderTransferHub=renderTransferHub;
  renderTransferHub=function(){
    originalRenderTransferHub();
    const canCreate=state.employee?.permissions?.includes('create_docs'),canReceive=['administrator','logistics_coordinator','warehouse_manager'].includes(state.employee?.roleKey)||state.employee?.role==='Manager',create=document.getElementById('newTransferBtn'),receive=document.getElementById('checkTransferBtn'),note=document.getElementById('managerTransferNote');
    if(create&&!canCreate)create.remove();
    if(receive){receive.innerHTML='<div><div class="choice-icon">▣✓</div><h3>Receive Transfer</h3><p class="muted">Scan transfer paperwork, then verify every piece received.</p></div><strong>Receive ›</strong>';receive.disabled=!canReceive;receive.onclick=canReceive?()=>go('transferCheck'):null}
    if(note)note.textContent=canCreate?'Create outgoing transfers or receive incoming transfers.':canReceive?'Warehouse Manager access — receive incoming transfers.':'Warehouse Manager access is required to receive transfers.';
    if(canCreate){loadMasterTransferBucket();loadTransferProblems();}
  };

  async function loadMasterTransferBucket(){
    const host=document.createElement('section');host.className='panel master-transfer-bucket';host.innerHTML='<div class="eyebrow">ALL LOCATIONS</div><h2>Master Transfer Bucket</h2><p class="muted">Loading active transfers across every warehouse…</p>';app.appendChild(host);
    try{
      const token=await window.bmGoogleAuth.accessToken();if(!token)throw new Error('Your Google session expired. Refresh and sign in again.');
      const response=await fetch('/api/warehouse?action=waiting-transfers',{cache:'no-store',headers:{Authorization:`Bearer ${token}`}}),data=await response.json();if(!response.ok)throw new Error(data.error||'Could not load transfers.');
      const rows=data.transfers||[],locations=[...new Set(rows.flatMap(row=>[row.from,row.to]).filter(Boolean))].sort();
      host.innerHTML=`<div class="section-head"><div><div class="eyebrow">ALL LOCATIONS</div><h2>Master Transfer Bucket</h2><p class="muted">Every active transfer across the company in one queue.</p></div><strong id="masterTransferCount">${rows.length} active</strong></div><div class="master-transfer-filters"><input id="masterTransferSearch" placeholder="Search transfer #, warehouse, or user"><select id="masterTransferStatus"><option value="">All statuses</option>${[...new Set(rows.map(row=>row.status).filter(Boolean))].sort().map(status=>`<option value="${esc(status)}">${esc(status.replaceAll('_',' '))}</option>`).join('')}</select><select id="masterTransferLocation"><option value="">All warehouses</option>${locations.map(location=>`<option value="${esc(location)}">${esc(location)}</option>`).join('')}</select></div><div class="master-transfer-table-wrap"><table class="master-transfer-table"><thead><tr><th>Transfer</th><th>From</th><th>To</th><th>Status</th><th>Lines</th><th>Pieces</th></tr></thead><tbody id="masterTransferRows"></tbody></table></div>`;
      const render=()=>{const search=host.querySelector('#masterTransferSearch').value.trim().toLowerCase(),status=host.querySelector('#masterTransferStatus').value,location=host.querySelector('#masterTransferLocation').value,shown=rows.filter(row=>(!search||`${row.ref} ${row.from} ${row.to} ${row.createdBy}`.toLowerCase().includes(search))&&(!status||row.status===status)&&(!location||row.from===location||row.to===location));host.querySelector('#masterTransferCount').textContent=`${shown.length} of ${rows.length} active`;host.querySelector('#masterTransferRows').innerHTML=shown.map(row=>`<tr><td><strong>${esc(row.ref)}</strong><small>${esc(row.createdBy||'')}</small></td><td>${esc(row.from)}</td><td>${esc(row.to)}</td><td><span class="master-status ${esc(row.status)}">${esc(String(row.status||'').replaceAll('_',' '))}</span></td><td>${row.lines?.length||0}</td><td>${(row.lines||[]).reduce((sum,line)=>sum+Number(line.expected||0),0)}</td></tr>`).join('')||'<tr><td colspan="6" class="muted">No transfers match these filters.</td></tr>'};
      ['masterTransferSearch','masterTransferStatus','masterTransferLocation'].forEach(id=>host.querySelector('#'+id).addEventListener(id==='masterTransferSearch'?'input':'change',render));render();
    }catch(error){host.innerHTML=`<div class="eyebrow">ALL LOCATIONS</div><h2>Master Transfer Bucket</h2><p>${esc(error.message)}</p>`}
  }

  async function loadTransferProblems(){
    const host=document.createElement('section');host.className='panel transfer-problem-queue';host.innerHTML='<div class="eyebrow">LOGISTICS EXCEPTIONS</div><h2>Transfers Requiring Review</h2><p class="muted">Loading transfer problems…</p>';app.appendChild(host);
    try{const token=await window.bmGoogleAuth.accessToken(),response=await fetch('/api/warehouse?action=transfer-problems',{cache:'no-store',headers:{Authorization:`Bearer ${token}`}}),data=await response.json();if(!response.ok)throw new Error(data.error||'Could not load transfer problems.');const rows=data.problems||[];host.innerHTML=`<div class="section-head"><div><div class="eyebrow">LOGISTICS EXCEPTIONS</div><h2>Transfers Requiring Review</h2><p class="muted">Resolve a shortage or create a follow-up transfer for the missing material.</p></div><strong>${rows.length} open</strong></div>${rows.length?`<div class="transfer-problem-list">${rows.map(row=>{const missing=row.lines.reduce((sum,line)=>sum+Math.max(0,line.expected-line.received),0);return`<article><header><div><strong>${esc(row.ref)}</strong><small>${esc(row.from)} → ${esc(row.to)} · ${esc(row.receiver||'Receiver unknown')}</small></div><span>${row.status==='qoblex_unknown'?'Qoblex Review':row.status==='qoblex_failed'?'Posting Failed':`${missing} missing`}</span></header><p>${esc(row.problemNote||row.qoblexError||'Review required')}</p><div class="problem-line-summary">${row.lines.map(line=>`<span><b>${esc(line.sku)}</b> ${line.received}/${line.expected}</span>`).join('')}</div>${row.status==='problem'?`<footer><button data-resolve="close_short" data-transfer-id="${row.id}">Close Short</button><button data-resolve="adjust_close" data-transfer-id="${row.id}">Adjust Expected & Close</button><button class="primary" data-resolve="create_followup" data-transfer-id="${row.id}">Create Follow-up Transfer</button></footer>`:'<footer><em>Check Qoblex before retrying or changing this transfer.</em></footer>'}</article>`}).join('')}</div>`:'<p class="muted">No transfer problems require review.</p>'}`;host.querySelectorAll('[data-resolve]').forEach(button=>button.onclick=()=>resolveProblem(button,host))}catch(error){host.innerHTML=`<div class="eyebrow">LOGISTICS EXCEPTIONS</div><h2>Transfers Requiring Review</h2><p>${esc(error.message)}</p>`}
  }
  async function resolveProblem(button,host){
    const labels={close_short:'Close this transfer with the shortage documented',adjust_close:'Change expected quantities to the received amounts and complete it',create_followup:'Close the shortage and create a new transfer for everything missing'},resolution=button.dataset.resolve,note=prompt(`${labels[resolution]}. Add a resolution note:`)||'';
    if(!note.trim())return notify('A resolution note is required.');
    button.disabled=true;const prior=button.textContent;button.textContent='Working…';
    try{const token=await window.bmGoogleAuth.accessToken(),response=await fetch('/api/warehouse?action=resolve-transfer-problem',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({id:button.dataset.transferId,resolution,note})}),data=await response.json();if(!response.ok)throw new Error(data.error||'Could not resolve the transfer.');notify(data.followUpNumber?`${data.followUpNumber} created`:'Transfer resolved');host.remove();loadTransferProblems()}catch(error){notify(error.message);button.disabled=false;button.textContent=prior}
  }

  const originalRenderTransferCheck=renderTransferCheck;
  renderTransferCheck=function(){originalRenderTransferCheck();pageTitle.textContent='Receive Transfer';const eyebrow=app.querySelector('.eyebrow'),heading=app.querySelector('h2'),copy=app.querySelector('.section-head p');if(eyebrow)eyebrow.textContent='RECEIVE TRANSFER';if(heading)heading.textContent='Scan the incoming transfer paperwork';if(copy)copy.textContent='Scan or enter the transfer number, then verify every piece received.';loadWaitingTransfers()};

  async function loadWaitingTransfers(){
    const host=document.createElement('section');host.className='panel waiting-receipt-panel';host.innerHTML='<div class="eyebrow">WAITING TO RECEIVE</div><h2>Open Transfers</h2><p class="muted">Loading transfers for this warehouse…</p>';app.appendChild(host);
    try{const token=await window.bmGoogleAuth.accessToken();if(!token)throw new Error('Your Google session expired. Refresh and sign in again.');const response=await fetch('/api/warehouse?action=waiting-transfers',{cache:'no-store',headers:{Authorization:`Bearer ${token}`}}),payload=await response.text();let data;try{data=JSON.parse(payload)}catch{throw new Error(response.ok?'The transfer response was invalid.':'The server could not load transfers.')}if(!response.ok)throw new Error(data.error||'Could not load transfers.');const selected=String(state.location||'').trim().toLowerCase(),transfers=state.location==='All Locations'?(data.transfers||[]):(data.transfers||[]).filter(transfer=>String(transfer.to||'').trim().toLowerCase()===selected);for(const transfer of transfers)backendTransfers[transfer.ref]=transfer;const actionable=t=>['awaiting_receipt','receiving'].includes(t.status);host.innerHTML=`<div class="section-head"><div><div class="eyebrow">WAITING TO RECEIVE</div><h2>Open Transfers</h2><p class="muted">${state.location==='All Locations'?'Open transfers across the company':`Transfers arriving at ${esc(state.location)}`}.</p></div><strong>${transfers.length} open</strong></div>${transfers.length?`<div class="waiting-transfer-list">${transfers.map(transfer=>`<button class="waiting-transfer" data-waiting-transfer="${actionable(transfer)?esc(transfer.ref):''}" ${actionable(transfer)?'':'disabled'}><span><strong>${esc(transfer.ref)}</strong><small>${esc(transfer.from)} → ${esc(transfer.to)}</small></span><span>${transfer.status==='problem'?'Problem — Logistics Review':transfer.status==='qoblex_unknown'?'Qoblex Review Required':transfer.status==='qoblex_failed'?'Qoblex Posting Failed':'Receive ›'}</span></button>`).join('')}</div>`:'<p class="muted">No open transfers are waiting for this warehouse.</p>'}`;host.querySelectorAll('[data-waiting-transfer]').forEach(button=>{if(button.dataset.waitingTransfer)button.onclick=()=>showTransferCheck(button.dataset.waitingTransfer)})}catch(error){host.innerHTML=`<div class="eyebrow">WAITING TO RECEIVE</div><h2>Open Transfers</h2><p>${esc(error.message)}</p>`}
  }

  function pad(value, size = 2) { return String(value).padStart(size, '0'); }
  function nextTransferNumber() {
    const now = new Date();
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const sequence = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
    return `TR-${date}-${sequence}`;
  }

  const originalRenderTransferCreate = renderTransferCreate;
  renderTransferCreate = function () {
    pendingTransferNumber = nextTransferNumber();
    originalRenderTransferCreate();
    const heading = app.querySelector('.section-head > div');
    if (heading) {
      const number = document.createElement('div');
      number.className = 'transfer-number-card';
      number.innerHTML = `<span>TRANSFER NUMBER</span><strong>${esc(pendingTransferNumber)}</strong><small>Assigned now and printed on all transfer paperwork</small>`;
      heading.appendChild(number);
    }
    const items=document.getElementById('transferItems');
    if(items){
      const addMore=document.createElement('button');
      addMore.id='addTransferLine';addMore.type='button';addMore.className='secondary add-transfer-line';addMore.textContent='+ Add More Lines';
      addMore.onclick=()=>{const input=document.getElementById('transferSku');if(input){input.value='';input.focus();input.scrollIntoView({behavior:'smooth',block:'center'});notify('Search or scan the next item')}};
      items.insertAdjacentElement('afterend',addMore);
    }
    const finish=document.getElementById('createTransfer');
    if(finish){
      const save=document.createElement('button');save.id='saveTransferDraft';save.type='button';save.className='secondary';save.textContent='Save Draft';
      finish.insertAdjacentElement('beforebegin',save);
      save.onclick=async()=>{
        if(!state.transferItems.length)return notify('Add at least one transfer line before saving');
        const token=await window.bmGoogleAuth.accessToken();if(!token)return notify('Your Google session expired. Refresh and sign in again.');
        save.disabled=true;const prior=save.textContent;save.textContent='Saving…';
        try{const response=await fetch('/api/warehouse?action=save-transfer',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({transferNumber:pendingTransferNumber,from:state.location,to:document.getElementById('transferTo').value,note:document.getElementById('transferNote').value,lines:state.transferItems.map(item=>({sku:item.sku,name:item.name,barcode:item.barcode||item.sku,qty:item.qty}))})}),data=await response.json();if(!response.ok)throw new Error(data.error||'Could not save transfer');save.textContent='✓ Draft Saved';notify(`${pendingTransferNumber} saved`);setTimeout(()=>{if(document.body.contains(save)){save.textContent=prior;save.disabled=false}},1800)}catch(error){notify(error.message);save.textContent=prior;save.disabled=false}
      };
    }
  };

  const originalShowCompletion = showCompletion;
  showCompletion = function (tx, kind) {
    let savePromise=null;
    if (kind === 'transfer' && pendingTransferNumber) {
      const oldRef = tx.ref;
      tx.ref = pendingTransferNumber;
      const activity = state.activity.find(row => row.ref === oldRef);
      if (activity) activity.ref = tx.ref;
      backendTransfers[tx.ref] = {
        ref: tx.ref,
        from: tx.from,
        to: tx.to,
        status: tx.status,
        createdBy: tx.employee,
        lines: (tx.lines || []).map(line => ({
          sku: line.sku,
          name: line.name,
          barcode: line.barcode || line.sku,
          expected: Number(line.qty || 0)
        }))
      };
      const transferToSave={transferNumber:tx.ref,from:tx.from,to:tx.to,note:tx.note||'',status:'awaiting_receipt',lines:(tx.lines||[]).map(line=>({sku:line.sku,name:line.name,barcode:line.barcode||line.sku,qty:Number(line.qty||0)}))};
      savePromise=window.bmGoogleAuth.accessToken().then(async token=>{if(!token)throw new Error('Your session expired. Refresh and sign in again.');const response=await fetch('/api/warehouse?action=save-transfer',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(transferToSave)}),data=await response.json().catch(()=>null);if(!response.ok)throw new Error(data?.error||'The transfer could not be saved.');return data});
      pendingTransferNumber = null;
    }
    const result=originalShowCompletion(tx, kind);
    if(kind==='transfer'){
      const print=document.getElementById('printTicket');
      if(print){print.textContent=savePromise?'Saving Transfer…':'🖨 Print Transfer';print.disabled=Boolean(savePromise);savePromise?.then(()=>{print.textContent='🖨 Print Transfer';print.disabled=false;notify(`${tx.ref} is ready to print`)}).catch(error=>{print.textContent='Save Failed';print.disabled=true;notify(error.message)})}
    }
    return result;
  };

  const code39Patterns={
    '0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw','5':'wnnwwnnnn','6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn',
    A:'wnnnnwnnw',B:'nnwnnwnnw',C:'wnwnnwnnn',D:'nnnnwwnnw',E:'wnnnwwnnn',F:'nnwnwwnnn',G:'nnnnnwwnw',H:'wnnnnwwnn',I:'nnwnnwwnn',J:'nnnnwwwnn',
    K:'wnnnnnnww',L:'nnwnnnnww',M:'wnwnnnnwn',N:'nnnnwnnww',O:'wnnnwnnwn',P:'nnwnwnnwn',Q:'nnnnnnwww',R:'wnnnnnwwn',S:'nnwnnnwwn',T:'nnnnwnwwn',
    U:'wwnnnnnnw',V:'nwwnnnnnw',W:'wwwnnnnnn',X:'nwnnwnnnw',Y:'wwnnwnnnn',Z:'nwwnwnnnn','-':'nwnnnnwnw','.':'wwnnnnwnn',' ':'nwwnnnwnn','$':'nwnwnwnnn','/':'nwnwnnnwn','+':'nwnnnwnwn','%':'nnnwnwnwn','*':'nwnnwnwnn'
  };
  function code39Svg(raw,label=true){
    const value=String(raw||'').trim().toUpperCase().split('').filter(ch=>code39Patterns[ch]&&ch!=='*').join('')||'UNKNOWN',encoded=`*${value}*`,narrow=2,wide=5,gap=2;
    let x=8,bars='';
    for(const ch of encoded){const pattern=code39Patterns[ch];for(let i=0;i<pattern.length;i++){const width=pattern[i]==='w'?wide:narrow;if(i%2===0)bars+=`<rect x="${x}" y="4" width="${width}" height="52" fill="#000"/>`;x+=width}x+=gap}
    const width=x+8,height=label?76:62;
    return `<svg class="bm-code39" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Barcode ${esc(value)}"><rect width="100%" height="100%" fill="#fff"/>${bars}${label?`<text x="${width/2}" y="71" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" letter-spacing="1">${esc(value)}</text>`:''}</svg>`;
  }
  window.bmCode39Svg=code39Svg;
  const originalPrintTicket=printTicket;
  printTicket=function(tx,kind){
    if(kind!=='transfer')return originalPrintTicket(tx,kind);
    const lines=(tx.lines||[]),body=`<h1>Bargain Moulding — Transfer</h1><div class="muted">Created ${fmtDate(tx.date)} · ${esc(tx.employee)}</div><div class="transfer-barcode">${code39Svg(tx.ref)}</div><div class="meta"><div><strong>Transfer</strong><br>${esc(tx.ref)}</div><div><strong>Status</strong><br>${esc(tx.status||'Awaiting Receipt')}</div><div><strong>Move From</strong><br>${esc(tx.from)}</div><div><strong>Move To</strong><br>${esc(tx.to)}</div><div><strong>Different Items</strong><br>${lines.length}</div><div><strong>Total Pieces</strong><br>${lines.reduce((sum,line)=>sum+Number(line.qty||0),0)}</div>${tx.note?`<div><strong>Note</strong><br>${esc(tx.note)}</div>`:''}</div><table><thead><tr><th>SKU / Description</th><th>Item Barcode</th><th>Qty</th><th>Received</th></tr></thead><tbody>${lines.map(line=>`<tr><td><strong>${esc(line.sku||'')}</strong><br>${esc(line.name||'')}</td><td class="item-barcode">${code39Svg(line.barcode||line.sku,false)}<small>${esc(line.barcode||line.sku||'')}</small></td><td>${Number(line.qty||0).toLocaleString()}</td><td></td></tr>`).join('')}</tbody></table><div class="sig"><div class="line">Prepared By</div><div class="line">Warehouse Manager / Receiver</div></div><style>.transfer-barcode{width:420px;max-width:100%;margin:18px auto}.bm-code39{display:block;width:100%;height:auto}.item-barcode{width:230px}.item-barcode small{display:block;text-align:center;font-size:9px}.item-barcode .bm-code39{height:48px}@media print{.transfer-barcode{width:380px}.item-barcode{width:210px}}</style>`;
    printWindow(`Transfer ${tx.ref}`,body);
  };

  const style = document.createElement('style');
  style.textContent = `.master-transfer-filters{display:grid;grid-template-columns:minmax(220px,1fr) 180px 220px;gap:8px;margin:12px 0}.master-transfer-filters input,.master-transfer-filters select{min-height:40px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;padding:0 10px}.master-transfer-table-wrap{overflow:auto}.master-transfer-table{width:100%;border-collapse:collapse;font-size:12px}.master-transfer-table th,.master-transfer-table td{text-align:left;padding:10px;border-bottom:1px solid #e2e8f0;white-space:nowrap}.master-transfer-table th{color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.06em}.master-transfer-table td:first-child{display:grid;gap:2px}.master-transfer-table td small{color:#64748b}.master-status{display:inline-block;padding:4px 7px;border-radius:999px;background:#e8f1f8;color:#17324d;font-weight:800;text-transform:capitalize}.master-status.problem,.master-status.qoblex_failed,.master-status.qoblex_unknown{background:#fff7ed;color:#9a3412}@media(max-width:750px){.master-transfer-filters{grid-template-columns:1fr}.master-transfer-table{min-width:680px}}.transfer-number-card{display:grid;gap:3px;margin-top:14px;padding:12px 14px;border:1px solid #99f6e4;border-radius:12px;background:#f0fdfa;width:fit-content}.transfer-number-card span{font-size:11px;font-weight:900;letter-spacing:.1em;color:#0f766e}.transfer-number-card strong{font-size:20px;letter-spacing:.03em}.transfer-number-card small{color:#64748b}.add-transfer-line{display:block;margin:12px 0 18px;width:100%;border:1px dashed #94a3b8;background:#f8fafc;color:#0f766e}.waiting-transfer:disabled{opacity:1;cursor:default;background:#fff7ed;border-color:#fed7aa}.waiting-transfer:disabled>span:last-child{color:#9a3412;font-weight:800}.transfer-problem-list{display:grid;gap:10px}.transfer-problem-list article{border:1px solid #fed7aa;background:#fffaf5;border-radius:14px;padding:14px}.transfer-problem-list header{display:flex;justify-content:space-between;gap:12px}.transfer-problem-list header div{display:grid;gap:3px}.transfer-problem-list header small{color:#64748b}.transfer-problem-list header span{color:#9a3412;font-weight:850}.transfer-problem-list p{margin:10px 0}.problem-line-summary{display:flex;gap:7px;flex-wrap:wrap}.problem-line-summary span{padding:5px 8px;border-radius:999px;background:#fff;border:1px solid #fed7aa;font-size:12px}.transfer-problem-list footer{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.transfer-problem-list footer button{min-height:38px;border:1px solid #cbd5e1;border-radius:9px;background:#fff;padding:0 11px;font-weight:800}.transfer-problem-list footer button.primary{background:#2563eb;color:#fff;border-color:#2563eb}.transfer-problem-list footer em{color:#9a3412}`;
  document.head.appendChild(style);
})();
