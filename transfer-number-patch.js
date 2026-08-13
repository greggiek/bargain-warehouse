(() => {
  let pendingTransferNumber = null;

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
