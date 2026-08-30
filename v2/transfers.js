(() => {
  const nav = document.getElementById('transfersNav'), view = document.getElementById('transferView');
  if (!nav || !view) return;
  const otherViews = ['overviewView','inventoryView','productSyncView','snapshotView','skuFixView','receivingView','productionView','bomManagementView','parLevelsView','forecastingView','purchaseOrdersView'].map((id)=>document.getElementById(id));
  const otherNavs = ['overviewNav','inventoryNav','productSyncNav','snapshotNav'].map((id)=>document.getElementById(id));
  const from=document.getElementById('transferFrom'), to=document.getElementById('transferTo');
  const sku=document.getElementById('transferSku'), quantity=document.getElementById('transferQty');
  const create=document.getElementById('transferCreate'), status=document.getElementById('transferStatus');
  const suggestions=document.getElementById('transferSuggestions'), rows=document.getElementById('transferRows');
  const queueSearch=document.getElementById('transferQueueSearch'), statusFilter=document.getElementById('transferStatusFilter');
  const documentScanPanel=document.getElementById('transferDocumentScanPanel'), documentScanInput=document.getElementById('transferDocumentScanInput'), documentScanStatus=document.getElementById('transferDocumentScanStatus');
  const newTransferButton=document.getElementById('transferNewButton');
  const createPanel=document.getElementById('transferCreatePanel');
  const adminSections=['transferInTransit','transferQueue','transferHistory','transferExceptions'].map((id)=>document.getElementById(id));
  const overviewReceiveTransfer=document.getElementById('overviewReceiveTransfer');
  const transferQueue=document.getElementById('transferQueue'), transferInTransit=document.getElementById('transferInTransit');
  if(transferQueue&&transferInTransit)transferQueue.parentNode.insertBefore(transferQueue,transferInTransit);
  let transfers=[], searchTimer, searchRequest=0, createMode=false, capabilities={ canManageTransfers:false, canReceiveTransfers:false };
  let scanSession=null, pendingReceiptLines=null, pendingQuantityLine=null;
  const show=(message,failed=false)=>{status.textContent=message;status.classList.toggle('error',failed);};
  const cell=(row,value)=>{const element=document.createElement('td');element.textContent=value;row.append(element);};
  const empty=(body,colspan,message)=>{body.replaceChildren();const row=document.createElement('tr'),element=document.createElement('td');element.colSpan=colspan;element.className='muted';element.textContent=message;row.append(element);body.append(row);};
  const formatStatus=(value)=>String(value||'').replace(/_/g,' ');
  const locationOption=(location)=>{const option=document.createElement('option');option.value=location.id;option.textContent=location.name;option.disabled=!location.canManage;return option;};
  const actionButton=(label,transfer,action)=>{const button=document.createElement('button');button.className='button secondary';button.type='button';button.textContent=label;button.addEventListener('click',()=>openScanner(transfer,action));return button;};
  const showDialog=dialog=>{dialog.hidden=false;if(typeof dialog.showModal==='function'&&!dialog.open)dialog.showModal();};
  const hideDialog=dialog=>{if(typeof dialog.close==='function'&&dialog.open)dialog.close();dialog.hidden=true;};
  function applyCapabilities(receiveOnly=false){
    const isAdmin=Boolean(capabilities.canManageTransfers);
    // Shopify is the only live inventory-movement workflow. Keep old V2 transfer
    // cards as hidden history so nobody can accidentally use a second ledger.
    newTransferButton.hidden=!isAdmin;
    newTransferButton.textContent='Create Shopify transfer';
    create.hidden=true;
    if(typeof nativeCreate!=='undefined')nativeCreate.hidden=true;
    createPanel.hidden=true;
    adminSections.forEach((section)=>{if(section)section.hidden=true;});
    if(receiveOnly || !isAdmin){
      documentScanPanel.hidden=false;
      documentScanStatus.textContent='Scan the main barcode printed on the incoming transfer to begin.';
      documentScanStatus.classList.remove('error');
    }
  }
  function openCamera(onScan,statusElement){
    if(!window.BMWarehouseCamera){statusElement.textContent='Camera scanner is still loading. Try again in a moment.';statusElement.classList.add('error');return;}
    window.BMWarehouseCamera.open({onScan,onError:message=>{statusElement.textContent=message;statusElement.classList.add('error');},title:'Scan transfer barcode',help:'Hold the transfer or SKU barcode inside the camera view.'});
  }
  function printTransfer(transfer){
    const lines=transfer.transfer_lines||[];
    if(!capabilities.canManageTransfers)return show('Only administrators can print transfer paperwork.',true);
    const popup=window.open('about:blank','_blank','width=900,height=700');
    if(!popup)return show('Allow pop-ups to print this transfer.',true);
    const esc=value=>String(value??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
    // Code 39 is generated here (rather than loaded from a CDN) so printed labels
    // work on restricted warehouse networks and in browser print pop-ups.
    const code39={
      '0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw','5':'wnnwwnnnn','6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn',
      'A':'wnnnnwnnw','B':'nnwnnwnnw','C':'wnwnnwnnn','D':'nnnnwwnnw','E':'wnnnwwnnn','F':'nnwnwwnnn','G':'nnnnnwwnw','H':'wnnnnwwnn','I':'nnwnnwwnn','J':'nnnnwwwnn',
      'K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww','O':'wnnnwnnwn','P':'nnwnwnnwn','Q':'nnnnnnwww','R':'wnnnnnwwn','S':'nnwnnnwwn','T':'nnnnwnwwn',
      'U':'wwnnnnnnw','V':'nwwnnnnnw','W':'wwwnnnnnn','X':'nwnnwnnnw','Y':'wwnnwnnnn','Z':'nwwnwnnnn','-':'nwnnnnwnw','.':'wwnnnnwnn',' ':'nwwnnnwnn','$':'nwnwnwnnn','/':'nwnwnnnwn','+':'nwnnnwnwn','%':'nnnwnwnwn','*':'nwnnwnwnn'
    };
    const code39Svg=value=>{
      const encoded='*'+String(value||'').toUpperCase()+'*';
      if([...encoded].some(character=>!code39[character])) return '<div class="barcode-warning">Barcode unavailable: unsupported SKU characters</div>';
      const unit=2,height=52,quiet=10;
      let x=quiet,rects='';
      [...encoded].forEach((character,index)=>{
        [...code39[character]].forEach((width,position)=>{const size=(width==='w'?3:1)*unit;if(position%2===0)rects+='<rect x="'+x+'" y="0" width="'+size+'" height="'+height+'"/>';x+=size;});
        if(index<encoded.length-1)x+=unit;
      });
      const total=x+quiet;
      return '<svg class="sku-barcode" viewBox="0 0 '+total+' '+height+'" width="'+total+'" height="'+height+'" role="img" aria-label="Barcode for '+esc(value)+'">'+rects+'</svg>';
    };
    const productFor=line=>Array.isArray(line.products)?(line.products[0]||{}):(line.products||{});
    const lineRows=lines.map(line=>{
      const product=productFor(line);
      const scanSku=product.sku||line.sku||line.product_sku||'MISSING SKU';
      return '<tr><td>'+code39Svg(scanSku)+'<div class="code">SKU: '+esc(scanSku)+'</div></td><td>'+esc(product.name||line.product_name||'Unnamed product')+'</td><td>'+esc(line.requested_quantity)+'</td><td>'+esc(line.allocated_quantity)+'</td><td>'+esc(line.shipped_quantity)+'</td><td>'+esc(line.received_quantity)+'</td></tr>';
    }).join('');
    popup.document.write('<!doctype html><title>'+esc(transfer.transfer_number)+'</title><style>body{font:15px Arial;color:#18263a;margin:38px}h1{margin:0 0 6px}p{color:#61718a}table{width:100%;border-collapse:collapse;margin-top:28px}th,td{padding:11px;border:1px solid #cfd9e6;text-align:left}th{background:#edf3fa}.code{font-family:monospace;font-size:18px;font-weight:bold;white-space:nowrap}.sku-barcode{display:block;max-width:260px;height:58px}.document-barcode{padding:12px;border:2px solid #18263a;border-radius:8px;max-width:420px;margin:18px 0}.document-barcode b{display:block;margin-bottom:6px;font-size:11px;letter-spacing:.08em}.document-barcode .sku-barcode{max-width:390px;height:70px}.barcode-warning{font-size:12px;color:#a33}@media print{body{margin:16px}}</style><h1>'+esc(transfer.transfer_number)+'</h1><p><b>Route:</b> '+esc(transfer.from_location?.name)+' → '+esc(transfer.to_location?.name)+'<br><b>Status:</b> '+esc(formatStatus(transfer.status))+'<br><b>Printed:</b> '+esc(new Date().toLocaleString())+'</p><section class="document-barcode"><b>TRANSFER BARCODE — SCAN IN BM WAREHOUSE TO RECEIVE</b>'+code39Svg(transfer.transfer_number)+'<div class="code">'+esc(transfer.transfer_number)+'</div></section><table><thead><tr><th>SKU / scan label</th><th>Product</th><th>Requested</th><th>Allocated</th><th>Shipped</th><th>Received</th></tr></thead><tbody>'+lineRows+'</tbody></table><p>Every barcode encodes its printed SKU. “MISSING SKU” goes into the SKU-fix queue before use.</p>');
    popup.document.close();popup.focus();setTimeout(()=>popup.print(),150);
  }
  function openScanner(transfer,action){
    if(action==='ship'&&!capabilities.canManageTransfers)return show('Only administrators can ship transfers.',true);
    if(action==='receive'&&!capabilities.canReceiveTransfers)return show('You do not have receiving access for this transfer.',true);
    scanSession={transfer,action,counts:new Map()};showDialog(document.getElementById('transferScanPanel'));document.getElementById('transferScanTitle').textContent=(action==='ship'?'Ship ':'Receive ')+transfer.transfer_number;
    document.getElementById('transferScanHelp').textContent=action==='ship'?'Scan every item leaving the origin. Confirming ships the transfer.':'Scan everything received. You can record discrepancies after the scan.';
    document.getElementById('transferScanStatus').textContent='';renderScan();document.getElementById('transferScanPanel').scrollIntoView({behavior:'smooth',block:'center'});document.getElementById('transferScanInput').focus();
  }
  function openDocumentScan(){showDialog(documentScanPanel);documentScanInput.value='';documentScanStatus.textContent='Scan or enter the transfer number to begin.';documentScanStatus.classList.remove('error');documentScanInput.focus();}
  function openTransferFromPaperwork(value){
    if(scanShopifyTransfer(value))return;
    const scanned=String(value||'').trim().toUpperCase();
    const transfer=transfers.find(item=>String(item.transfer_number||'').toUpperCase()===scanned);
    if(!transfer){documentScanStatus.textContent='No visible transfer matches '+scanned+'. Make sure you are signed into the destination warehouse.';documentScanStatus.classList.add('error');return;}
    if(!['in_transit','partially_received'].includes(transfer.status)){documentScanStatus.textContent=transfer.transfer_number+' is '+formatStatus(transfer.status)+'. It must be shipped before it can be received.';documentScanStatus.classList.add('error');return;}
    hideDialog(documentScanPanel);openScanner(transfer,'receive');
  }
  function renderScan(){const host=document.getElementById('transferScanRows'),finish=document.getElementById('transferFinishScan');host.replaceChildren();let expectedTotal=0,scannedTotal=0;(scanSession.transfer.transfer_lines||[]).forEach(line=>{const expected=Number(scanSession.action==='ship'?line.allocated_quantity:line.shipped_quantity),scanned=scanSession.counts.get(line.id)||0,row=document.createElement('tr');expectedTotal+=expected;scannedTotal+=scanned;cell(row,line.products?.sku||'—');cell(row,String(expected));cell(row,String(scanned));cell(row,String(Math.max(0,expected-scanned)));host.append(row);});finish.hidden=false;finish.disabled=scannedTotal!==expectedTotal;finish.textContent=scanSession.action==='receive'?'Receive Transfer & Close':'Ship Transfer';document.getElementById('transferScanStatus').textContent=scannedTotal+' of '+expectedTotal+' pieces checked.';document.getElementById('transferScanStatus').classList.remove('error');}
  function openQuantityDialog(line){pendingQuantityLine=line;const expected=Number(scanSession.action==='ship'?line.allocated_quantity:line.shipped_quantity),current=Number(scanSession.counts.get(line.id)||0),remaining=expected-current,dialog=document.getElementById('transferQuantityDialog'),input=document.getElementById('transferQuantityInput');if(remaining<=0){document.getElementById('transferScanStatus').textContent=(line.products?.sku||'This SKU')+' is already fully checked.';document.getElementById('transferScanStatus').classList.add('error');return;}document.getElementById('transferQuantityTitle').textContent=line.products?.sku||'Transfer item';document.getElementById('transferQuantityHelp').textContent='Up to '+remaining+' pieces can be added for '+(line.products?.name||'this item')+'.';input.max=String(remaining);input.value='1';if(typeof dialog.showModal==='function')dialog.showModal();else dialog.hidden=false;input.focus();}
  function scanValue(value){const term=String(value||'').trim().toLowerCase();if(!term)return;const line=(scanSession.transfer.transfer_lines||[]).find(x=>[x.products?.sku,x.products?.barcode,x.products?.name].filter(Boolean).some(v=>String(v).toLowerCase()===term));if(!line){document.getElementById('transferScanStatus').textContent='Not on this transfer: '+value;document.getElementById('transferScanStatus').classList.add('error');return;}openQuantityDialog(line);}
  function confirmQuantity(){if(!pendingQuantityLine||!scanSession)return;const line=pendingQuantityLine,input=document.getElementById('transferQuantityInput'),expected=Number(scanSession.action==='ship'?line.allocated_quantity:line.shipped_quantity),current=Number(scanSession.counts.get(line.id)||0),add=Number(input.value);if(!Number.isFinite(add)||add<=0||add>expected-current)return;scanSession.counts.set(line.id,current+add);const dialog=document.getElementById('transferQuantityDialog');if(typeof dialog.close==='function')dialog.close();else dialog.hidden=true;pendingQuantityLine=null;renderScan();}
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
  otherNavs.forEach((otherNav)=>otherNav?.addEventListener('click',()=>{view.hidden=true;nav.classList.remove('active');hideSuggestions();}));
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
    const prompt = action === 'allocate'
      ? 'Confirm you want to allocate ' + transfer.transfer_number + ' in V2? This reserves the available inventory but does not ship it.'
      : 'Confirm you want to ' + (action === 'ship' ? 'ship' : 'record this receipt for') + ' ' + transfer.transfer_number + ' in V2?';
    if(!confirm(prompt))return;
    button.disabled=true;show(action==='allocate'?'Allocating transfer…':action==='ship'?'Shipping transfer…':'Recording receipt…');
    try {const response=await fetch('/api/transfers',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({action,transferId:transfer.id,lines})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Transfer action failed.');await load();show('Transfer '+data.transfer.transferNumber+' is now '+formatStatus(data.transfer.status)+'.');}
    catch(error){show(error.message,true);}finally{button.disabled=false;}
  }
  document.getElementById('transferScanInput').addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();scanValue(event.currentTarget.value);event.currentTarget.value='';}});
  document.getElementById('transferCancelScan').addEventListener('click',()=>{scanSession=null;hideDialog(document.getElementById('transferScanPanel'));});
  document.getElementById('transferScanClose').addEventListener('click',()=>{scanSession=null;hideDialog(document.getElementById('transferScanPanel'));});
  document.getElementById('transferDocumentClose').addEventListener('click',()=>hideDialog(documentScanPanel));
  document.getElementById('transferFinishScan').addEventListener('click',async()=>{if(!scanSession)return;const {transfer,action}=scanSession;const lines=transfer.transfer_lines||[];const incomplete=lines.filter(line=>(scanSession.counts.get(line.id)||0)<Number(action==='ship'?line.allocated_quantity:line.shipped_quantity));if(incomplete.length){return show('Scan is incomplete. Record a discrepancy through receiving before confirming.',true);}if(action==='receive')pendingReceiptLines=lines.map(line=>({lineId:line.id,receivedQuantity:Number(line.shipped_quantity),damagedQuantity:0,missingQuantity:0,note:''}));hideDialog(document.getElementById('transferScanPanel'));scanSession=null;await runAction(transfer,action,document.getElementById('transferFinishScan'));});
  document.getElementById('transferCameraScan').addEventListener('click',()=>openCamera(scanValue,document.getElementById('transferScanStatus')));
  document.getElementById('transferQuantityConfirm').addEventListener('click',confirmQuantity);
  document.getElementById('transferQuantityInput').addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();confirmQuantity();}});
  document.getElementById('transferQuantityCancel').addEventListener('click',()=>{pendingQuantityLine=null;const dialog=document.getElementById('transferQuantityDialog');if(typeof dialog.close==='function')dialog.close();else dialog.hidden=true;});
  documentScanInput.addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();openTransferFromPaperwork(event.currentTarget.value);}});
  document.getElementById('transferDocumentCameraScan').addEventListener('click',()=>openCamera(openTransferFromPaperwork,documentScanStatus));
  function renderQueue(){
    const term=queueSearch.value.trim().toLowerCase(),wanted=statusFilter.value;
    const visible=transfers.filter((transfer)=>{const line=transfer.transfer_lines?.[0],haystack=[transfer.transfer_number,transfer.from_location?.name,transfer.to_location?.name,transfer.status,line?.products?.sku,line?.products?.name].join(' ').toLowerCase();return (!term||haystack.includes(term))&&(!wanted||transfer.status===wanted);});
    if(!visible.length)return empty(rows,7,'No transfers match this view.');
    rows.replaceChildren();visible.forEach((transfer)=>{const row=document.createElement('tr'),lines=transfer.transfer_lines||[],pieces=lines.reduce((sum,line)=>sum+Number(line.requested_quantity||0),0);cell(row,transfer.transfer_number);cell(row,transfer.from_location?.name||'—');cell(row,transfer.to_location?.name||'—');cell(row,formatStatus(transfer.status));cell(row,String(lines.length));cell(row,String(pieces));const action=document.createElement('td');if(capabilities.canManageTransfers){const print=document.createElement('button');print.className='button secondary';print.type='button';print.textContent='Print';print.addEventListener('click',()=>printTransfer(transfer));action.append(print);if(transfer.status==='draft'){const allocate=document.createElement('button');allocate.className='button secondary';allocate.type='button';allocate.textContent='Allocate';allocate.addEventListener('click',()=>runAction(transfer,'allocate',allocate));action.append(allocate);}if(transfer.status==='allocated')action.append(actionButton('Ship',transfer,'ship'));}if(capabilities.canReceiveTransfers&&['in_transit','partially_received'].includes(transfer.status))action.append(actionButton('Receive',transfer,'receive'));if(!action.childNodes.length)action.textContent='—';row.append(action);rows.append(row);});
  }
  function renderIncomingTransfers(){const host=document.getElementById('transferIncomingList');if(!host)return;host.replaceChildren();const incoming=transfers.filter(transfer=>['in_transit','partially_received'].includes(transfer.status));if(!incoming.length){host.textContent='No incoming transfers are waiting at this location.';host.className='muted';return;}host.className='transfer-choice-grid';incoming.forEach(transfer=>{const button=document.createElement('button');button.type='button';button.className='transfer-choice receive';const pieces=(transfer.transfer_lines||[]).reduce((sum,line)=>sum+Number(line.shipped_quantity||0)-Number(line.received_quantity||0),0);button.innerHTML='<strong>'+transfer.transfer_number+'</strong><span>'+transfer.from_location?.name+' → '+transfer.to_location?.name+'</span><span>'+pieces+' pieces · Tap to receive</span>';button.addEventListener('click',()=>{hideDialog(documentScanPanel);openScanner(transfer,'receive');});host.append(button);});}
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
    capabilities=data.capabilities||capabilities;
    [from,to].forEach((select)=>{select.replaceChildren();const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Choose location';select.append(placeholder);data.locations.forEach((location)=>select.append(locationOption(location)));});
    transfers=data.transfers||[];renderQueue();renderIncomingTransfers();renderInTransit(data.inTransitLines||[],data.summary||{inTransitPieces:0,activeTransfers:0,inTransitSkus:0});renderHistory(data.history||[]);renderExceptions(data.exceptions||[]);
    await loadShopifyTransfers();
    await loadIntercompanyLedger();
    applyCapabilities();
    show(capabilities.canManageTransfers?'Create and move transfers through Shopify.':'Scan an incoming Shopify transfer to receive it into your assigned warehouse.');
  }
  queueSearch.addEventListener('input',renderQueue);statusFilter.addEventListener('change',renderQueue);
  newTransferButton.addEventListener('click',()=>{if(!capabilities.canManageTransfers)return show('Only administrators can create Shopify transfers.',true);openShopifyTransferDialog();});
  async function openWorkspace(receiveOnly=false){otherViews.forEach((element)=>{if(element)element.hidden=true;});otherNavs.forEach((element)=>element&&element.classList.remove('active'));nav.classList.add('active');view.hidden=false;await load();applyCapabilities(receiveOnly);if(receiveOnly||!capabilities.canManageTransfers)openDocumentScan();}
  window.BMWarehouseOpenTransfers=openWorkspace;
  if(window.BMWarehousePendingTransfersOpen){window.BMWarehousePendingTransfersOpen=false;openWorkspace(false).catch(error=>show(error.message||'Could not load transfers.',true));}
  nav.addEventListener('click',()=>openWorkspace(false).catch(error=>show(error.message||'Could not load transfers.',true)));
  overviewReceiveTransfer?.addEventListener('click',()=>openWorkspace(true));
  create.addEventListener('click',async()=>{
    if(!capabilities.canManageTransfers)return show('Only administrators can create transfers.',true);
    if(!from.value||!to.value||!sku.value.trim()||!quantity.value)return show('Choose locations, an exact SKU, and a quantity.',true);
    if(from.value===to.value)return show('Choose two different locations.',true);create.disabled=true;show('Allocating transfer…');
    try{const response=await fetch('/api/transfers',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({action:'create',fromLocationId:from.value,toLocationId:to.value,sku:sku.value,quantity:quantity.value})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Transfer could not be allocated.');sku.value='';quantity.value='';createMode=false;await load();show('Transfer '+data.transfer.transferNumber+' created and allocated. Ship it when it leaves.');}
    catch(error){show(error.message,true);}finally{create.disabled=false;}
  });

  // Shopify-native transfers are inventory-authoritative. They appear separately from the
  // legacy V2 ledger so employees cannot accidentally move stock through the wrong workflow.
  const shopifyLifecyclePanel=document.createElement('section');
  shopifyLifecyclePanel.className='card section';
  shopifyLifecyclePanel.hidden=false;
  shopifyLifecyclePanel.innerHTML='<div class="transfer-kicker">Transfer list</div><div class="transfer-filters"><input id="shopifyTransferListSearch" class="inventory-search" type="search" placeholder="Search transfer, warehouse, SKU, or status"><select id="shopifyTransferListStatus" class="transfer-filter"><option value="">All statuses</option><option value="draft">Draft</option><option value="pending">Pending</option><option value="received">Received</option></select></div><div class="inventory-table-wrap"><table class="inventory-table"><thead><tr><th>Transfer</th><th>Date</th><th>Status</th><th>Source location</th><th>Destination location</th><th>Lines</th><th>Last update</th><th>Action</th></tr></thead><tbody id="shopifyTransferLifecycleRows"></tbody></table></div>';
  transferQueue.parentNode.insertBefore(shopifyLifecyclePanel,transferQueue);
  const shopifyLifecycleRows=shopifyLifecyclePanel.querySelector('#shopifyTransferLifecycleRows');
  const shopifyTransferListSearch=shopifyLifecyclePanel.querySelector('#shopifyTransferListSearch'),shopifyTransferListStatus=shopifyLifecyclePanel.querySelector('#shopifyTransferListStatus');
  const intercompanyLedgerPanel=document.createElement('section');
  intercompanyLedgerPanel.className='card';
  intercompanyLedgerPanel.hidden=true;
  intercompanyLedgerPanel.innerHTML='<p class="eyebrow">MONTHLY BOOKKEEPING</p><div class="card-header"><div><h2>Intercompany ledger</h2><p class="muted">Completed NY ↔ CT movements, valued at the source moving-average cost frozen at shipment.</p></div><div class="inline-actions"><input id="intercompanyLedgerMonth" type="month" aria-label="Ledger month"><button id="intercompanyLedgerExport" class="button secondary" type="button">Export CSV</button></div></div><div id="intercompanyLedgerSummary" class="muted"></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Reference</th><th>Route</th><th>SKU</th><th>Qty</th><th>Unit cost</th><th>Value</th><th>Status</th></tr></thead><tbody id="intercompanyLedgerRows"></tbody></table></div>';
  transferQueue.parentNode.insertBefore(intercompanyLedgerPanel,transferQueue);
  const intercompanyLedgerMonth=intercompanyLedgerPanel.querySelector('#intercompanyLedgerMonth');
  const intercompanyLedgerExport=intercompanyLedgerPanel.querySelector('#intercompanyLedgerExport');
  const intercompanyLedgerSummary=intercompanyLedgerPanel.querySelector('#intercompanyLedgerSummary');
  const intercompanyLedgerRows=intercompanyLedgerPanel.querySelector('#intercompanyLedgerRows');
  let intercompanyLedgerRowsData=[];
  intercompanyLedgerMonth.value=new Date().toISOString().slice(0,7);
  const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:4}).format(Number(value||0));
  function renderIntercompanyLedger(){
    intercompanyLedgerRows.replaceChildren();
    if(!intercompanyLedgerRowsData.length){empty(intercompanyLedgerRows,8,'No intercompany transfers were shipped in this month.');return;}
    intercompanyLedgerRowsData.forEach(line=>{
      const row=document.createElement('tr');
      cell(row,new Date(line.shipped_at).toLocaleDateString());
      cell(row,line.bm_reference);
      cell(row,line.source_entity+' → '+line.destination_entity);
      cell(row,line.sku);
      cell(row,line.quantity);
      cell(row,money(line.unit_cost));
      cell(row,money(line.extended_value));
      cell(row,formatStatus(line.status));
      intercompanyLedgerRows.append(row);
    });
  }
  function exportIntercompanyLedger(){
    const headers=['Date','Reference','From entity','To entity','SKU','Quantity','Unit cost','Extended value','Currency','Status','Source Shopify adjustment','Destination Shopify adjustment'];
    const escape=value=>'"'+String(value??'').replace(/"/g,'""')+'"';
    const lines=intercompanyLedgerRowsData.map(line=>[
      line.shipped_at,line.bm_reference,line.source_entity,line.destination_entity,line.sku,line.quantity,line.unit_cost,line.extended_value,line.currency,line.status,line.source_shopify_adjustment_id,line.destination_shopify_adjustment_id
    ].map(escape).join(','));
    const blob=new Blob([[headers.join(','),...lines].join('\n')],{type:'text/csv;charset=utf-8'});
    const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='bm-intercompany-ledger-'+intercompanyLedgerMonth.value+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),0);
  }
  async function loadIntercompanyLedger(){
    const response=await fetch('/api/intercompany-ledger?month='+encodeURIComponent(intercompanyLedgerMonth.value),{credentials:'same-origin'});
    const data=await response.json();
    if(response.status===403){intercompanyLedgerPanel.hidden=true;return;}
    if(!response.ok){intercompanyLedgerPanel.hidden=true;return;}
    intercompanyLedgerPanel.hidden=false;
    intercompanyLedgerRowsData=data.rows||[];
    const summary=data.summary||{};
    intercompanyLedgerSummary.textContent=(summary.transfers||0)+' transfer'+((summary.transfers||0)===1?'':'s')+' · '+(summary.pieces||0)+' pieces · '+money(summary.value)+' total transfer value';
    renderIntercompanyLedger();
  }
  intercompanyLedgerMonth.addEventListener('change',()=>loadIntercompanyLedger());
  intercompanyLedgerExport.addEventListener('click',exportIntercompanyLedger);
  const transferDetailsDialog=document.createElement('dialog');
  transferDetailsDialog.className='card receiving-dialog';
  transferDetailsDialog.innerHTML='<form method="dialog" class="inventory-head"><div><div class="transfer-kicker">Transfer</div><h2 id="transferDetailsTitle">Transfer</h2></div><button class="button secondary" type="submit">Close</button></form><div id="transferDetailsBody"></div>';
  document.body.append(transferDetailsDialog);
  const transferDetailsTitle=transferDetailsDialog.querySelector('#transferDetailsTitle'),transferDetailsBody=transferDetailsDialog.querySelector('#transferDetailsBody');
  function openTransferDetails(link){transferDetailsTitle.textContent='Transfer '+link.bm_reference;transferDetailsBody.replaceChildren();const route=document.createElement('p');route.className='muted';route.textContent=(link.source_name||'—')+' → '+(link.destination_name||'—')+' · '+formatStatus(link.status);const wrap=document.createElement('div');wrap.className='inventory-table-wrap';const table=document.createElement('table');table.className='inventory-table';table.innerHTML='<thead><tr><th>SKU</th><th>Quantity</th></tr></thead><tbody></tbody>';(link.shopify_transfer_link_lines||[]).forEach(line=>{const row=document.createElement('tr');cell(row,line.sku||'—');cell(row,String(line.quantity||0));table.querySelector('tbody').append(row);});wrap.append(table);transferDetailsBody.append(route,wrap);showDialog(transferDetailsDialog);}
  function compactPrintButton(link){const button=document.createElement('button');button.type='button';button.className='button secondary';button.textContent='Print';button.addEventListener('click',()=>{const choice=prompt('Print options:\n1 — Transfer\n2 — Labels');if(choice==='1')shopifyPrintButton(link).click();if(choice==='2')shopifyLabelButton(link).click();});return button;}
  let shopifyTransferLinks=[], shopifyTransferCapabilities={canShip:false,canReceive:false};
  shopifyTransferListSearch.addEventListener('input',renderShopifyTransfers);shopifyTransferListStatus.addEventListener('change',renderShopifyTransfers);
  async function runShopifyLifecycle(link,action,button){
    const intercompany=link.route_type==='cross_store';
    const question=action==='ship'
      ? (intercompany
        ? 'Ship intercompany transfer '+link.bm_reference+'? This deducts only '+link.source_name+' in Shopify. It does not create a customer sale.'
        : 'Ship '+link.bm_reference+' in Shopify? This starts the real in-transit inventory movement from '+link.source_name+' to '+link.destination_name+'.')
      : (intercompany
        ? 'Receive intercompany transfer '+link.bm_reference+'? This adds stock only into '+link.destination_name+' in Shopify. It does not create a customer sale.'
        : 'Receive '+link.bm_reference+' in Shopify? This adds the material into '+link.destination_name+'.');
    if(!confirm(question))return;
    if(button)button.disabled=true;show(action==='ship'?'Posting shipment…':'Posting receipt…');
    try{
      const response=await fetch('/api/shopify-transfer-lifecycle',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({action,linkId:link.id})});
      const data=await response.json();if(!response.ok)throw new Error(data.error||'Shopify transfer action failed.');
      show(data.message);await loadShopifyTransfers();await loadIntercompanyLedger();
    }catch(error){show(error.message||'Shopify transfer action failed.',true);}finally{if(button)button.disabled=false;}
  }
  async function changeTransferStatus(link,action,button){
    if(button)button.disabled=true;show(action==='mark_pending'?'Marking transfer Pending…':'Returning transfer to Draft…');
    try{const response=await fetch('/api/shopify-transfer-lifecycle',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({action,linkId:link.id})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Transfer status could not be changed.');show(data.message);await loadShopifyTransfers();}catch(error){show(error.message||'Transfer status could not be changed.',true);}finally{if(button)button.disabled=false;}
  }
  function statusButton(label,link,action){const button=document.createElement('button');button.type='button';button.className=action==='mark_pending'?'button':'button secondary';button.textContent=label;button.addEventListener('click',()=>changeTransferStatus(link,action,button));return button;}
  function lifecycleButton(label,link,action){
    const button=document.createElement('button');button.type='button';button.className=action==='ship'?'button':'button secondary';button.textContent=label;
    button.addEventListener('click',()=>runShopifyLifecycle(link,action,button));
    return button;
  }
  function renderShopifyTransfers(){
    shopifyLifecycleRows.replaceChildren();
    const term=shopifyTransferListSearch.value.trim().toLowerCase(),wanted=shopifyTransferListStatus.value;
    const visible=shopifyTransferLinks.filter(link=>{const displayStatus=link.status==='completed'?'received':link.status;const text=[link.bm_reference,link.source_name,link.destination_name,displayStatus,...(link.shopify_transfer_link_lines||[]).map(line=>line.sku)].join(' ').toLowerCase();return (!term||text.includes(term))&&(!wanted||displayStatus===wanted);});
    if(!visible.length)return empty(shopifyLifecycleRows,8,shopifyTransferLinks.length?'No transfers match this view.':'No transfers yet. Create one when material needs to move.');
    visible.forEach(link=>{
      const intercompany=link.route_type==='cross_store',row=document.createElement('tr'),lines=link.shopify_transfer_link_lines||[];
      const refCell=document.createElement('td'),refButton=document.createElement('button');refButton.type='button';refButton.className='po-order-link';refButton.textContent=link.bm_reference;refButton.addEventListener('click',()=>openTransferDetails(link));refCell.append(refButton);row.append(refCell);
      cell(row,link.created_at?new Date(link.created_at).toLocaleDateString():'—');
      cell(row,(intercompany?'Intercompany · ':'')+formatStatus(link.status==='completed'?'received':link.status));
      cell(row,link.source_name||'—');cell(row,link.destination_name||'—');cell(row,String(lines.length));
      cell(row,link.received_at?new Date(link.received_at).toLocaleDateString():link.shipped_at?new Date(link.shipped_at).toLocaleDateString():link.created_at?new Date(link.created_at).toLocaleDateString():'—');
      const actions=document.createElement('td');
      if(shopifyTransferCapabilities.canShip)actions.append(compactPrintButton(link));
      const shipped=link.metadata?.outbound_status==='shipped';
      if(link.status==='draft'&&shopifyTransferCapabilities.canShip)actions.append(statusButton('Mark pending',link,'mark_pending'));
      if(link.status==='pending'&&!shipped&&shopifyTransferCapabilities.canShip){actions.append(statusButton('Edit',link,'return_to_draft'));actions.append(lifecycleButton('Ship',link,'ship'));}
      if(link.status==='pending'&&shipped&&shopifyTransferCapabilities.canReceive)actions.append(lifecycleButton('Receive',link,'receive'));
      if(!actions.childNodes.length)actions.textContent='—';row.append(actions);shopifyLifecycleRows.append(row);
    });
  }
  function barcode39(value){
    const map={'0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw','5':'wnnwwnnnn','6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn','A':'wnnnnwnnw','B':'nnwnnwnnw','C':'wnwnnwnnn','D':'nnnnwwnnw','E':'wnnnwwnnn','F':'nnwnwwnnn','G':'nnnnnwwnw','H':'wnnnnwwnn','I':'nnwnnwwnn','J':'nnnnwwwnn','K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww','O':'wnnnwnnwn','P':'nnwnwnnwn','Q':'nnnnnnwww','R':'wnnnnnwwn','S':'nnwnnnwwn','T':'nnnnwnwwn','U':'wwnnnnnnw','V':'nwwnnnnnw','W':'wwwnnnnnn','X':'nwnnwnnnw','Y':'wwnnwnnnn','Z':'nwwnwnnnn','-':'nwnnnnwnw',' ':'nwwnnnwnn','*':'nwnnwnwnn'};
    const chars='*'+String(value||'').toUpperCase()+'*';if([...chars].some(c=>!map[c]))return '';
    let x=10,rects='';[...chars].forEach((c,index)=>{[...map[c]].forEach((w,pos)=>{const width=(w==='w'?6:2);if(pos%2===0)rects+='<rect x="'+x+'" y="0" width="'+width+'" height="64"/>';x+=width;});if(index<chars.length-1)x+=2;});
    return '<svg viewBox="0 0 '+(x+10)+' 64" width="360" height="64" aria-label="Transfer barcode">'+rects+'</svg>';
  }
  function shopifyLabelButton(link){
    const button=document.createElement('button');button.type='button';button.className='button secondary';button.textContent='Print Zebra labels';
    button.addEventListener('click',()=>{
      const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const lines=link.shopify_transfer_link_lines||[];
      if(!lines.length)return show('This transfer has no item labels to print. Refresh and try again.',true);
      const labels=lines.map((line,index)=>'<section class="zebra-label"><div class="label-copy"><div class="eyebrow">BARGAIN MOULDING · TRANSFER</div><div class="route"><b>From:</b> '+esc(link.source_name)+'<br><b>To:</b> '+esc(link.destination_name)+'</div><div class="sku">'+esc(line.sku||'—')+'</div><div class="bin"><span>DESTINATION BIN</span>'+esc(line.destination_bin||'NOT SET')+'</div><div class="bottom">Qty: '+esc(line.quantity)+' · Label '+(index+1)+' of '+lines.length+'</div></div><div class="barcode">'+barcode39(line.sku||'')+'<div class="code">'+esc(line.sku||'—')+'</div></div></section>').join('');
      const popup=window.open('about:blank','_blank');if(!popup)return show('Allow pop-ups to print Zebra labels.',true);
      popup.document.write('<!doctype html><title>'+esc(link.bm_reference)+' labels</title><style>@page{size:5in 3in;margin:0}*{box-sizing:border-box}body{margin:0;font-family:Arial;color:#000}.zebra-label{width:5in;height:3in;padding:.18in;page-break-after:always;display:flex;gap:.16in;border:1px dashed #ddd}.zebra-label:last-child{page-break-after:auto}.label-copy{width:57%;display:flex;flex-direction:column}.eyebrow{font-size:8pt;font-weight:800;letter-spacing:1px}.route{font-size:9pt;line-height:1.25;min-height:.43in;margin-top:5px}.sku{font:25pt monospace;font-weight:900;letter-spacing:.4px;margin:8px 0}.bin{border:2px solid #000;padding:5px 8px;font-size:20pt;font-weight:900;line-height:1.1;margin-top:auto}.bin span{display:block;font-size:7pt;letter-spacing:1px;margin-bottom:2px}.bottom{margin-top:6px;font-size:9pt;font-weight:700}.barcode{width:43%;display:flex;flex-direction:column;justify-content:center}.barcode svg{width:100%;height:1in;fill:#000;display:block}.code{font:12pt monospace;font-weight:bold;text-align:center;margin-top:4px}</style></head><body>'+labels+'</body></html>');
      popup.document.close();popup.focus();setTimeout(()=>popup.print(),250);
    });return button;
  }
  function shopifyPrintButton(link){
    const button=document.createElement('button');button.type='button';button.className='button secondary';button.textContent='Print ticket';
    button.addEventListener('click',()=>{
      const popup=window.open('about:blank','_blank','width=820,height=700');if(!popup)return show('Allow pop-ups to print this transfer ticket.',true);
      const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const lines=(link.shopify_transfer_link_lines||[]).map(line=>'<tr><td>'+barcode39(line.sku)+'<b>'+esc(line.sku)+'</b></td><td>'+esc(line.quantity)+'</td></tr>').join('')||'<tr><td colspan="2">Line details are unavailable. Refresh the transfer list and try again.</td></tr>';
      popup.document.write('<!doctype html><title>'+esc(link.bm_reference)+' transfer ticket</title><style>body{font:16px Arial;color:#16263c;margin:34px}h1{margin:0 0 8px}.route{font-size:20px;margin-bottom:22px}.barcode{border:2px solid #16263c;border-radius:8px;padding:16px;max-width:420px;margin:20px 0}.barcode b{font-family:monospace;font-size:22px}svg{display:block;max-width:100%;margin:10px 0}table{border-collapse:collapse;width:100%;margin-top:24px}th,td{border:1px solid #cbd5e1;padding:11px;text-align:left}th{background:#edf3fa}@media print{body{margin:16px}}</style><h1>Transfer ticket · '+esc(link.bm_reference)+'</h1><div class="route"><b>From:</b> '+esc(link.source_name)+' &nbsp; → &nbsp; <b>To:</b> '+esc(link.destination_name)+'</div><div class="barcode"><small>SCAN THIS BARCODE AT RECEIVING</small>'+barcode39(link.bm_reference)+'<b>'+esc(link.bm_reference)+'</b></div><h2>Items to move</h2><p>Scan the product barcode beside each SKU to check the item.</p><table><thead><tr><th>Product barcode / SKU</th><th>Quantity</th></tr></thead><tbody>'+lines+'</tbody></table><p>At the destination: open BM Warehouse → Receive transfer → scan this ticket. The scan opens the exact Shopify transfer for confirmation.</p>');
      popup.document.close();popup.focus();setTimeout(()=>popup.print(),150);
    });return button;
  }
  function scanShopifyTransfer(value){
    const code=String(value||'').trim().toUpperCase();
    const link=shopifyTransferLinks.find(item=>String(item.bm_reference||'').toUpperCase()===code);
    if(!link)return false;
    if(!['shipped','partially_received'].includes(link.status)){documentScanStatus.textContent=link.bm_reference+' is '+formatStatus(link.status)+'. It must be shipped before it can be received.';documentScanStatus.classList.add('error');return true;}
    hideDialog(documentScanPanel);runShopifyLifecycle(link,'receive');return true;
  }
  async function loadShopifyTransfers(){
    const response=await fetch('/api/shopify-transfer-lifecycle',{credentials:'same-origin'});
    const data=await response.json();
    if(!response.ok){show(data.error||'Could not load Shopify transfer links.',true);return;}
    shopifyTransferLinks=data.links||[];shopifyTransferCapabilities=data.capabilities||shopifyTransferCapabilities;renderShopifyTransfers();
  }

  // Native Shopify transfers are deliberately separate from the legacy V2 ledger path.
  // The button is admin-only, creates a DRAFT in Shopify, and requires a second explicit
  // confirmation after the live availability preview has returned.
  const nativeCreate=document.createElement('button');
  nativeCreate.type='button';nativeCreate.className='button secondary';nativeCreate.textContent='Create transfer draft';
  create.insertAdjacentElement('afterend',nativeCreate);
  function nativePayload(){return {sourceLocationId:Number(from.value),destinationLocationId:Number(to.value),lines:[{sku:sku.value.trim(),quantity:Number(quantity.value)}]};}
  const transferCreateDialog=document.createElement('dialog');
  transferCreateDialog.className='card receiving-dialog';
  transferCreateDialog.innerHTML='<form method="dialog" class="inventory-head"><div><div class="transfer-kicker">Shopify inventory transfer</div><h2>Create transfer</h2><p class="muted">Build the entire transfer first. Creating the draft does not move stock.</p></div><button class="button secondary" type="submit">Close</button></form><section class="receiving-step"><div class="receiving-step-heading"><span class="receiving-step-number">1</span><div><strong>Choose route</strong><span>NY ↔ CT uses the paired intercompany workflow. Same-store routes create a native Shopify draft.</span></div></div><div class="receiving-step-actions"><select id="shopifyTransferFrom" class="inventory-search" aria-label="From location"></select><select id="shopifyTransferTo" class="inventory-search" aria-label="To location"></select></div></section><section class="receiving-step receiving-step-two"><div class="receiving-step-heading"><span class="receiving-step-number">2</span><div><strong>Add items</strong><span>Add up to 50 SKUs. Each SKU is checked against Shopify before the draft is made.</span></div></div><div class="receiving-step-actions"><div class="product-lookup"><input id="shopifyTransferSku" class="inventory-search" autocomplete="off" placeholder="Search SKU or product"><div id="shopifyTransferSuggestions" class="product-suggestions" hidden></div></div><input id="shopifyTransferQuantity" class="inventory-search" type="number" min="1" step="1" placeholder="Qty"><button id="shopifyTransferAddLine" class="button secondary" type="button">Add line</button></div><div class="inventory-table-wrap"><table class="inventory-table"><thead><tr><th>SKU</th><th>Quantity</th><th></th></tr></thead><tbody id="shopifyTransferDraftLines"></tbody></table></div></section><p id="shopifyTransferCreateStatus" class="inventory-status">Add one or more SKUs, then create the Shopify draft.</p><div class="inventory-actions"><button id="shopifyTransferCreateDraft" class="button" type="button">Create transfer draft</button></div>';
  document.body.append(transferCreateDialog);
  const transferDialogFrom=transferCreateDialog.querySelector('#shopifyTransferFrom'),transferDialogTo=transferCreateDialog.querySelector('#shopifyTransferTo'),transferDialogSku=transferCreateDialog.querySelector('#shopifyTransferSku'),transferDialogQty=transferCreateDialog.querySelector('#shopifyTransferQuantity'),transferDialogSuggestions=transferCreateDialog.querySelector('#shopifyTransferSuggestions'),transferDialogLines=transferCreateDialog.querySelector('#shopifyTransferDraftLines'),transferDialogStatus=transferCreateDialog.querySelector('#shopifyTransferCreateStatus'),transferDialogAdd=transferCreateDialog.querySelector('#shopifyTransferAddLine'),transferDialogCreate=transferCreateDialog.querySelector('#shopifyTransferCreateDraft');
  let transferDraftLines=[],dialogSearchTimer,dialogSearchRequest=0;
  const dialogMessage=(message,failed=false)=>{transferDialogStatus.textContent=message;transferDialogStatus.classList.toggle('error',failed);};
  function renderDraftLines(){transferDialogLines.replaceChildren();if(!transferDraftLines.length)return empty(transferDialogLines,3,'No items added yet.');transferDraftLines.forEach((line,index)=>{const row=document.createElement('tr');cell(row,line.sku);cell(row,String(line.quantity));const actions=document.createElement('td'),remove=document.createElement('button');remove.type='button';remove.className='button secondary';remove.textContent='Remove';remove.addEventListener('click',()=>{transferDraftLines.splice(index,1);renderDraftLines();});actions.append(remove);row.append(actions);transferDialogLines.append(row);});}
  function hideDialogSuggestions(){transferDialogSuggestions.replaceChildren();transferDialogSuggestions.hidden=true;}
  function showDialogSuggestions(products){transferDialogSuggestions.replaceChildren();if(!products.length)return hideDialogSuggestions();products.forEach(product=>{const option=document.createElement('button');option.type='button';option.className='product-suggestion';option.innerHTML='<strong></strong><small></small>';option.querySelector('strong').textContent=product.sku+' — '+product.name;option.querySelector('small').textContent=[product.barcode?'Barcode: '+product.barcode:'',product.category||''].filter(Boolean).join(' · ');option.addEventListener('click',()=>{transferDialogSku.value=product.sku;hideDialogSuggestions();transferDialogQty.focus();});transferDialogSuggestions.append(option);});transferDialogSuggestions.hidden=false;}
  async function searchDialogProducts(){const term=transferDialogSku.value.trim();if(term.length<2)return hideDialogSuggestions();const request=++dialogSearchRequest;try{const response=await fetch('/api/transfers?productSearch='+encodeURIComponent(term),{credentials:'same-origin'});const data=await response.json();if(request!==dialogSearchRequest||!response.ok)throw new Error(data.error||'Lookup failed');showDialogSuggestions(data.products||[]);}catch(error){hideDialogSuggestions();dialogMessage(error.message||'Product lookup is unavailable.',true);}}
  function addDraftLine(){const lineSku=transferDialogSku.value.trim(),lineQuantity=Number(transferDialogQty.value);if(!lineSku||!Number.isInteger(lineQuantity)||lineQuantity<=0)return dialogMessage('Enter an exact SKU and whole-piece quantity.',true);if(transferDraftLines.some(line=>line.sku.toLowerCase()===lineSku.toLowerCase()))return dialogMessage('Each SKU may be included once. Remove the line and add it again if the quantity changed.',true);if(transferDraftLines.length>=50)return dialogMessage('A transfer can include up to 50 SKU lines.',true);transferDraftLines.push({sku:lineSku,quantity:lineQuantity});transferDialogSku.value='';transferDialogQty.value='';hideDialogSuggestions();renderDraftLines();dialogMessage(transferDraftLines.length+' SKU '+(transferDraftLines.length===1?'line':'lines')+' ready for Shopify preview.');transferDialogSku.focus();}
  function openShopifyTransferDialog(){transferDialogFrom.replaceChildren(...[...from.options].map(option=>option.cloneNode(true)));transferDialogTo.replaceChildren(...[...to.options].map(option=>option.cloneNode(true)));transferDialogFrom.value=from.value;transferDialogTo.value=to.value;transferDraftLines=[];transferDialogSku.value='';transferDialogQty.value='';renderDraftLines();dialogMessage('Add one or more SKUs, then create the Shopify draft.');showDialog(transferCreateDialog);transferDialogFrom.focus();}
  transferDialogSku.addEventListener('input',()=>{clearTimeout(dialogSearchTimer);dialogSearchTimer=setTimeout(searchDialogProducts,180);});
  transferDialogSku.addEventListener('blur',()=>setTimeout(hideDialogSuggestions,160));
  transferDialogQty.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();addDraftLine();}});
  transferDialogAdd.addEventListener('click',addDraftLine);
  transferDialogCreate.addEventListener('click',async()=>{if(!transferDialogFrom.value||!transferDialogTo.value||!transferDraftLines.length)return dialogMessage('Choose the two warehouses and add at least one SKU.',true);if(transferDialogFrom.value===transferDialogTo.value)return dialogMessage('Choose two different locations.',true);const payload={sourceLocationId:Number(transferDialogFrom.value),destinationLocationId:Number(transferDialogTo.value),lines:transferDraftLines};transferDialogCreate.disabled=true;dialogMessage('Checking Shopify availability…');try{const previewResponse=await fetch('/api/shopify-transfer-preview',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({action:'preview',...payload})});const plan=await previewResponse.json();if(!previewResponse.ok)throw new Error(plan.error||'Shopify availability lookup failed.');if(!plan.allLinesAvailable)throw new Error('Shopify reports insufficient source stock on one or more lines. Nothing was created.');const crossStore=plan.routeType==='cross_store';const wording=crossStore?'Create intercompany draft '+plan.source.warehouse+' → '+plan.destination.warehouse+' with '+transferDraftLines.length+' SKU lines? No inventory changes until Ship.':'Create Shopify transfer draft '+plan.source.warehouse+' → '+plan.destination.warehouse+' with '+transferDraftLines.length+' SKU lines? No inventory changes until Ship.';if(!confirm(wording))return;const action=crossStore?'create_intercompany_draft':'create_native_same_store';dialogMessage('Creating transfer draft…');const response=await fetch('/api/shopify-transfer-preview',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({action,...payload})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Transfer draft could not be created.');hideDialog(transferCreateDialog);show(result.message);await loadShopifyTransfers();await loadIntercompanyLedger();}catch(error){dialogMessage(error.message||'Shopify transfer creation failed.',true);}finally{transferDialogCreate.disabled=false;}});
})();
