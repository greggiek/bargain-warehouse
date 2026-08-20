(() => {
  const nav = document.getElementById('transfersNav'), view = document.getElementById('transferView');
  if (!nav || !view) return;
  const otherViews = ['overviewView','inventoryView','productSyncView','snapshotView'].map((id)=>document.getElementById(id));
  const otherNavs = ['overviewNav','inventoryNav','productSyncNav','snapshotNav'].map((id)=>document.getElementById(id));
  const from=document.getElementById('transferFrom'), to=document.getElementById('transferTo');
  const sku=document.getElementById('transferSku'), quantity=document.getElementById('transferQty');
  const create=document.getElementById('transferCreate'), status=document.getElementById('transferStatus');
  const suggestions=document.getElementById('transferSuggestions'), rows=document.getElementById('transferRows');
  const queueSearch=document.getElementById('transferQueueSearch'), statusFilter=document.getElementById('transferStatusFilter');
  let transfers=[], searchTimer, searchRequest=0;
  let scanSession=null, pendingReceiptLines=null;
  const show=(message,failed=false)=>{status.textContent=message;status.classList.toggle('error',failed);};
  const cell=(row,value)=>{const element=document.createElement('td');element.textContent=value;row.append(element);};
  const empty=(body,colspan,message)=>{body.replaceChildren();const row=document.createElement('tr'),element=document.createElement('td');element.colSpan=colspan;element.className='muted';element.textContent=message;row.append(element);body.append(row);};
  const formatStatus=(value)=>String(value||'').replace(/_/g,' ');
  const locationOption=(location)=>{const option=document.createElement('option');option.value=location.id;option.textContent=location.name;option.disabled=!location.canManage;return option;};
  const actionButton=(label,transfer,action)=>{const button=document.createElement('button');button.className='button secondary';button.type='button';button.textContent=label;button.addEventListener('click',()=>openScanner(transfer,action));return button;};
  function printTransfer(transfer){const lines=transfer.transfer_lines||[];const popup=window.open('about:blank','_blank','width=900,height=700');if(!popup)return show('Allow pop-ups to print this transfer.',true);const esc=value=>String(value??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));popup.document.write('<!doctype html><title>'+esc(transfer.transfer_number)+'</title><style>body{font:15px Arial;color:#18263a;margin:38px}h1{margin:0 0 6px}p{color:#61718a}table{width:100%;border-collapse:collapse;margin-top:28px}th,td{padding:11px;border:1px solid #cfd9e6;text-align:left}th{background:#edf3fa}.code{font-family:monospace;font-size:18px;font-weight:bold}@media print{body{margin:16px}}</style><h1>'+esc(transfer.transfer_number)+'</h1><p><b>Route:</b> '+esc(transfer.from_location?.name)+' → '+esc(transfer.to_location?.name)+'<br><b>Status:</b> '+esc(formatStatus(transfer.status))+'<br><b>Printed:</b> '+esc(new Date().toLocaleString())+'</p><table><thead><tr><th>SKU / scan label</th><th>Product</th><th>Requested</th><th>Allocated</th><th>Shipped</th><th>Received</th></tr></thead><tbody>'+lines.map(line=>'<tr><td class="code">'+esc(line.products?.sku)+'</td><td>'+esc(line.products?.name)+'</td><td>'+esc(line.requested_quantity)+'</td><td>'+esc(line.allocated_quantity)+'</td><td>'+esc(line.shipped_quantity)+'</td><td>'+esc(line.received_quantity)+'</td></tr>').join('')+'</tbody></table><p>Scan the SKU label against this document. Shopify and Qoblex are not changed.</p>');popup.document.close();popup.focus();setTimeout(()=>popup.print(),250);}
  function openScanner(transfer,action){
    scanSession={transfer,action,counts:new Map()};document.getElementById('transferScanPanel').hidden=false;document.getElementById('transferScanTitle').textContent=(action==='ship'?'Ship ':'Receive ')+transfer.transfer_number;
    document.getElementById('transferScanHelp').textContent=action==='ship'?'Scan every item leaving the origin. Confirming ships the transfer.':'Scan everything received. You can record discrepancies after the scan.';
    document.getElementById('transferScanStatus').textContent='';renderScan();document.getElementById('transferScanPanel').scrollIntoView({behavior:'smooth',block:'center'});document.getElementById('transferScanInput').focus();
  }
  function renderScan(){const host=document.getElementById('transferScanRows');host.replaceChildren();(scanSession.transfer.transfer_lines||[]).forEach(line=>{const expected=Number(scanSession.action==='ship'?line.allocated_quantity:line.shipped_quantity),scanned=scanSession.counts.get(line.id)||0,row=document.createElement('tr');cell(row,line.products?.sku||'—');cell(row,String(expected));cell(row,String(scanned));cell(row,String(Math.max(0,expected-scanned)));host.append(row);});}
  function scanValue(value){const term=String(value||'').trim().toLowerCase();if(!term)return;const line=(scanSession.transfer.transfer_lines||[]).find(x=>[x.products?.sku,x.products?.barcode,x.products?.name].filter(Boolean).some(v=>String(v).toLowerCase()===term));if(!line){document.getElementById('transferScanStatus').textContent='Not on this transfer: '+value;document.getElementById('transferScanStatus').classList.add('error');return;}const expected=Number(scanSession.action==='ship'?line.allocated_quantity:line.shipped_quantity),next=(scanSession.counts.get(line.id)||0)+1;if(next>expected){document.getElementById('transferScanStatus').textContent='Already scanned the expected quantity for '+line.products?.sku+'.';document.getElementById('transferScanStatus').classList.add('error');return;}scanSession.counts.set(line.id,next);document.getElementById('transferScanStatus').textContent=line.products?.sku+' scanned ('+next+'/'+expected+').';document.getElementById('transferScanStatus').classList.remove('error');renderScan();}
  function hideSuggestions(){suggestions.replaceChildren();suggestions.hidden=true;}
  function showSuggestions(products){
    suggestions.replaceChildren();if(!products.length)return hideSuggestions();
    products.forEach((product)=>{const button=document.createElement('button');button.className='product-suggestion';button.type='button';
      const primary=document.createElement('strong');primary.textContent=product.sku+' — '+product.name;
      const detail=document.createElement('small');detail.textContent=[product.barcode?'Barcode: '+product.barcode:'',product.category||''].filter(Boolean).join(' · ');
      button.append(primary,detail);button.addEventListener('click',()=>{sku.value=product.sku;hideSuggestions();quantity.focus();});suggestions.append(button);});
    suggestions.hidden=false;
  }
  async function searchProducts(){
    const term=sku.value.trim();if(term.length<2)return hideSuggestions();const request=++searchRequest;
    try {const response=await fetch('/api/transfers?productSearch='+encodeURIComponent(term),{credentials:'same-origin'});const data=await response.json();if(request!==searchRequest||!response.ok)throw new Error(data.error||'Lookup failed');showSuggestions(data.products||[]);}
    catch(error){hideSuggestions();show(error.message||'Product lookup is unavailable.',true);}
  }
  sku.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(searchProducts,180);});
  sku.addEventListener('blur',()=>setTimeout(hideSuggestions,160));
  otherNavs.forEach((otherNav)=>otherNav.addEventListener('click',()=>{view.hidden=true;nav.classList.remove('active');hideSuggestions();}));
  function receiptLines(transfer){
    if(pendingReceiptLines){const lines=pendingReceiptLines;pendingReceiptLines=null;return lines;}
    const lines=transfer.transfer_lines||[];if(lines.length!==1)throw new Error('Multi-line receipts are not enabled in this screen yet.');
    const line=lines[0],outstanding=Number(line.shipped_quantity)-Number(line.received_quantity)-Number(line.damaged_quantity)-Number(line.missing_quantity);
    if(outstanding<=0)throw new Error('There is nothing left to receive.');
    const ask=(label,max)=>{const value=prompt(label+' (0–'+max+')','0');if(value===null)return null;const n=Number(value);if(!Number.isFinite(n)||n<0||n>max)throw new Error('Enter a quantity between 0 and '+max+'.');return n;};
    const receivedQuantity=ask('Quantity received for '+(line.products?.sku||'this SKU'),outstanding);if(receivedQuantity===null)return null;
    const damagedQuantity=ask('Quantity damaged',outstanding-receivedQuantity);if(damagedQuantity===null)return null;
    const missingQuantity=ask('Quantity missing',outstanding-receivedQuantity-damagedQuantity);if(missingQuantity===null)return null;
    if(receivedQuantity+damagedQuantity+missingQuantity===0)throw new Error('Enter at least one quantity.');
    const note=damagedQuantity||missingQuantity?prompt('Optional note for the discrepancy',''):'';if(note===null)return null;
    return [{lineId:line.id,receivedQuantity,damagedQuantity,missingQuantity,note}];
  }
  async function runAction(transfer,action,button){
    let lines;try{if(action==='receive'){lines=receiptLines(transfer);if(!lines)return;}}catch(error){return show(error.message,true);}
    if(!confirm('Confirm you want to '+(action==='ship'?'ship':'record this receipt for')+' '+transfer.transfer_number+' in V2?'))return;
    button.disabled=true;show(action==='ship'?'Shipping transfer…':'Recording receipt…');
    try {const response=await fetch('/api/transfers',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({action,transferId:transfer.id,lines})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Transfer action failed.');await load();show('Transfer '+data.transfer.transferNumber+' is now '+formatStatus(data.transfer.status)+'.');}
    catch(error){show(error.message,true);}finally{button.disabled=false;}
  }
  document.getElementById('transferScanInput').addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();scanValue(event.currentTarget.value);event.currentTarget.value='';}});
  document.getElementById('transferCancelScan').addEventListener('click',()=>{scanSession=null;document.getElementById('transferScanPanel').hidden=true;});
  document.getElementById('transferFinishScan').addEventListener('click',async()=>{if(!scanSession)return;const {transfer,action}=scanSession;const lines=transfer.transfer_lines||[];const incomplete=lines.filter(line=>(scanSession.counts.get(line.id)||0)<Number(action==='ship'?line.allocated_quantity:line.shipped_quantity));if(incomplete.length){return show('Scan is incomplete. Record a discrepancy through receiving before confirming.',true);}if(action==='receive')pendingReceiptLines=lines.map(line=>({lineId:line.id,receivedQuantity:Number(line.shipped_quantity),damagedQuantity:0,missingQuantity:0,note:''}));document.getElementById('transferScanPanel').hidden=true;scanSession=null;await runAction(transfer,action,document.getElementById('transferFinishScan'));});
  document.getElementById('transferCameraScan').addEventListener('click',()=>{document.getElementById('transferScanStatus').textContent='Camera scanning is next; use a Bluetooth scanner or type/scan into this field for now.';});
  function renderQueue(){
    const term=queueSearch.value.trim().toLowerCase(),wanted=statusFilter.value;
    const visible=transfers.filter((transfer)=>{const line=transfer.transfer_lines?.[0],haystack=[transfer.transfer_number,transfer.from_location?.name,transfer.to_location?.name,transfer.status,line?.products?.sku,line?.products?.name].join(' ').toLowerCase();return (!term||haystack.includes(term))&&(!wanted||transfer.status===wanted);});
    if(!visible.length)return empty(rows,7,'No transfers match this view.');
    rows.replaceChildren();visible.forEach((transfer)=>{const row=document.createElement('tr'),lines=transfer.transfer_lines||[],pieces=lines.reduce((sum,line)=>sum+Number(line.requested_quantity||0),0);cell(row,transfer.transfer_number);cell(row,transfer.from_location?.name||'—');cell(row,transfer.to_location?.name||'—');cell(row,formatStatus(transfer.status));cell(row,String(lines.length));cell(row,String(pieces));const action=document.createElement('td'),print=document.createElement('button');print.className='button secondary';print.type='button';print.textContent='Print';print.addEventListener('click',()=>printTransfer(transfer));action.append(print);if(transfer.status==='allocated')action.append(actionButton('Ship',transfer,'ship'));else if(['in_transit','partially_received'].includes(transfer.status))action.append(actionButton('Receive',transfer,'receive'));row.append(action);rows.append(row);});
  }
  function renderInTransit(lines,summary){
    document.getElementById('inTransitPieces').textContent=summary.inTransitPieces+' pieces';
    document.getElementById('inTransitTransfers').textContent=summary.activeTransfers+' active transfers';
    document.getElementById('inTransitSkus').textContent=summary.inTransitSkus+' SKUs';
    const body=document.getElementById('inTransitRows');if(!lines.length)return empty(body,7,'No material is currently in transit.');
    body.replaceChildren();lines.forEach((line)=>{const row=document.createElement('tr');cell(row,line.sku);cell(row,line.transferNumber);cell(row,line.from+' → '+line.to);cell(row,String(line.shipped));cell(row,String(line.received));cell(row,String(line.damaged));cell(row,String(line.inTransit));body.append(row);});
  }
  function renderHistory(history){
    const body=document.getElementById('transferHistoryRows');if(!history.length)return empty(body,4,'No V2 transfer history yet.');
    body.replaceChildren();history.forEach((event)=>{const row=document.createElement('tr');cell(row,event.document_number||'—');cell(row,event.description||formatStatus(event.action_type));cell(row,event.user_name||'—');cell(row,new Date(event.created_at).toLocaleString());body.append(row);});
  }
  function renderExceptions(exceptions){
    document.getElementById('exceptionCount').textContent=exceptions.length+' open';
    const body=document.getElementById('transferExceptionRows');if(!exceptions.length)return empty(body,5,'No transfer problems require review.');
    body.replaceChildren();exceptions.forEach((item)=>{const row=document.createElement('tr');cell(row,item.transfers?.transfer_number||'—');cell(row,item.transfer_lines?.products?.sku||'—');cell(row,item.discrepancy_type);cell(row,String(item.quantity));cell(row,item.note||'—');body.append(row);});
  }
  async function load(){
    show('Loading your V2 transfer command center…');const response=await fetch('/api/transfers',{credentials:'same-origin'});const data=await response.json();
    if(!response.ok)return show(data.error||'Could not load transfers.',true);
    [from,to].forEach((select)=>{select.replaceChildren();const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Choose location';select.append(placeholder);data.locations.forEach((location)=>select.append(locationOption(location)));});
    transfers=data.transfers||[];renderQueue();renderInTransit(data.inTransitLines||[],data.summary||{inTransitPieces:0,activeTransfers:0,inTransitSkus:0});renderHistory(data.history||[]);renderExceptions(data.exceptions||[]);
    show('Create, ship, and receive transfers in the V2 ledger. Shopify and Qoblex are not changed.');
  }
  queueSearch.addEventListener('input',renderQueue);statusFilter.addEventListener('change',renderQueue);
  document.getElementById('transferCreateChoice').addEventListener('click',()=>{document.getElementById('transferCreatePanel').scrollIntoView({behavior:'smooth',block:'center'});sku.focus();});
  document.getElementById('transferReceiveChoice').addEventListener('click',()=>document.getElementById('transferQueue').scrollIntoView({behavior:'smooth',block:'start'}));
  nav.addEventListener('click',async()=>{otherViews.forEach((element)=>{if(element)element.hidden=true;});otherNavs.forEach((element)=>element&&element.classList.remove('active'));nav.classList.add('active');view.hidden=false;await load();});
  create.addEventListener('click',async()=>{
    if(!from.value||!to.value||!sku.value.trim()||!quantity.value)return show('Choose locations, an exact SKU, and a quantity.',true);
    if(from.value===to.value)return show('Choose two different locations.',true);create.disabled=true;show('Allocating transfer…');
    try{const response=await fetch('/api/transfers',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({action:'create',fromLocationId:from.value,toLocationId:to.value,sku:sku.value,quantity:quantity.value})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Transfer could not be allocated.');sku.value='';quantity.value='';await load();show('Transfer '+data.transfer.transferNumber+' created and allocated. Ship it when it leaves.');}
    catch(error){show(error.message,true);}finally{create.disabled=false;}
  });
})();
