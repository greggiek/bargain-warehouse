(() => {
  let pendingTransferNumber = null;

  const originalRenderTransferHub=renderTransferHub;
  renderTransferHub=function(){
    originalRenderTransferHub();
    const canCreate=state.employee?.permissions?.includes('create_docs'),create=document.getElementById('newTransferBtn'),receive=document.getElementById('checkTransferBtn'),note=document.getElementById('managerTransferNote');
    if(create&&!canCreate)create.remove();
    if(receive){receive.disabled=false;receive.innerHTML='<div><div class="choice-icon">▣✓</div><h3>Receive Transfer</h3><p class="muted">Scan transfer paperwork, then verify every piece received.</p></div><strong>Receive ›</strong>';receive.onclick=()=>go('transferCheck')}
    if(note)note.textContent=canCreate?'Create outgoing transfers or receive incoming transfers.':'Warehouse Manager access — receive incoming transfers.';
  };

  const originalRenderTransferCheck=renderTransferCheck;
  renderTransferCheck=function(){originalRenderTransferCheck();pageTitle.textContent='Receive Transfer';const eyebrow=app.querySelector('.eyebrow'),heading=app.querySelector('h2'),copy=app.querySelector('.section-head p');if(eyebrow)eyebrow.textContent='RECEIVE TRANSFER';if(heading)heading.textContent='Scan the incoming transfer paperwork';if(copy)copy.textContent='Scan or enter the transfer number, then verify every piece received.';loadWaitingTransfers()};

  async function loadWaitingTransfers(){
    const host=document.createElement('section');host.className='panel waiting-receipt-panel';host.innerHTML='<div class="eyebrow">WAITING TO RECEIVE</div><h2>Incoming Transfers</h2><p class="muted">Loading transfers…</p>';app.prepend(host);
    try{const token=await window.bmGoogleAuth.accessToken();if(!token)throw new Error('Your Google session expired. Refresh and sign in again.');const response=await fetch('/api/warehouse?action=waiting-transfers',{cache:'no-store',headers:{Authorization:`Bearer ${token}`}}),payload=await response.text();let data;try{data=JSON.parse(payload)}catch{throw new Error(response.ok?'The transfer response was invalid.':'The server could not load transfers.')}if(!response.ok)throw new Error(data.error||'Could not load transfers.');for(const transfer of data.transfers||[])backendTransfers[transfer.ref]=transfer;host.innerHTML=`<div class="section-head"><div><div class="eyebrow">WAITING TO RECEIVE</div><h2>Incoming Transfers</h2></div><strong>${(data.transfers||[]).length} waiting</strong></div>${(data.transfers||[]).length?`<div style="display:grid;gap:9px">${data.transfers.map(transfer=>`<button class="waiting-transfer" data-waiting-transfer="${esc(transfer.ref)}"><span><strong>${esc(transfer.ref)}</strong><small>${esc(transfer.from)} → ${esc(transfer.to)}</small></span><span>Receive ›</span></button>`).join('')}</div>`:'<p class="muted">Nothing is waiting to be received.</p>'}`;host.querySelectorAll('[data-waiting-transfer]').forEach(button=>button.onclick=()=>showTransferCheck(button.dataset.waitingTransfer))}catch(error){host.innerHTML=`<div class="eyebrow">WAITING TO RECEIVE</div><h2>Incoming Transfers</h2><p>${esc(error.message)}</p>`}
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
      window.bmGoogleAuth.accessToken().then(token=>token&&fetch('/api/warehouse?action=save-transfer',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(transferToSave)})).then(response=>{if(response&&!response.ok)notify('Transfer created, but the waiting queue could not be updated. Try Save Draft and finish again.')}).catch(()=>notify('Transfer created, but the waiting queue could not be updated.'));
      pendingTransferNumber = null;
    }
    const result=originalShowCompletion(tx, kind);
    if(kind==='transfer'){
      const print=document.getElementById('printTicket');
      if(print)print.textContent='🖨 Print Transfer';
    }
    return result;
  };

  const style = document.createElement('style');
  style.textContent = `.transfer-number-card{display:grid;gap:3px;margin-top:14px;padding:12px 14px;border:1px solid #99f6e4;border-radius:12px;background:#f0fdfa;width:fit-content}.transfer-number-card span{font-size:11px;font-weight:900;letter-spacing:.1em;color:#0f766e}.transfer-number-card strong{font-size:20px;letter-spacing:.03em}.transfer-number-card small{color:#64748b}.add-transfer-line{display:block;margin:12px 0 18px;width:100%;border:1px dashed #94a3b8;background:#f8fafc;color:#0f766e}`;
  document.head.appendChild(style);
})();
