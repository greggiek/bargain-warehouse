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
  let scanSession=null, pendingReceiptLines=null;
  const show=(message,failed=false)=>{status.textContent=message;status.classList.toggle('error',failed);};
  const cell=(row,value)=>{const element=document.createElement('td');element.textContent=value;row.append(element);};
  const empty=(body,colspan,message)=>{body.replaceChildren();const row=document.createElement('tr'),element=document.createElement('td');element.colSpan=colspan;element.className='muted';element.textContent=message;row.append(element);body.append(row);};
  const formatStatus=(value)=>String(value||'').replace(/_/g,' ');
  const locationOption=(location)=>{const option=document.createElement('option');option.value=location.id;option.textContent=location.name;option.disabled=!location.canManage;return option;};
  const actionButton=(label,transfer,action)=>{const button=document.createElement('button');button.className='button secondary';button.type='button';button.textContent=label;button.addEventListener('click',()=>openScanner(transfer,action));return button;};
  function applyCapabilities(receiveOnly=false){
    const isAdmin=Boolean(capabilities.canManageTransfers);
    newTransferButton.hidden=!isAdmin;
    createPanel.hidden=!isAdmin || !createMode;
    adminSections.forEach((section)=>{if(section)section.hidden=!isAdmin;});
    if(receiveOnly || !isAdmin){
      documentScanPanel.hidden=false;
      documentScanStatus.textContent='Scan the main barcode printed on the incoming transfer to begin.';
      documentScanStatus.classList.remove('error');
    }
  }
  function openCamera(onScan,statusElement){
    if(!('BarcodeDetector' in window))return statusElement.textContent='Camera scanning is not supported by this browser. Use the phone scanner field or a Bluetooth scanner.';
    const overlay=document.createElement('div');overlay.style.cssText='position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:20px;background:#07101ddd';
    overlay.innerHTML='<section class="card" style="width:min(620px,100%)"><div class="topbar"><h2>Scan barcode</h2><button class="button secondary" type="button">Close</button></div><video playsinline muted style="display:block;width:100%;margin-top:14px;border-radius:12px;background:#000"></video><p class="muted" style="margin-bottom:0">Hold the transfer or SKU barcode inside the camera view.</p></section>';
    const video=overlay.querySelector('video');let stream,frame;const close=()=>{cancelAnimationFrame(frame);stream?.getTracks().forEach(track=>track.stop());overlay.remove();};overlay.querySelector('button').addEventListener('click',close);document.body.append(overlay);
    navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false}).then(async nextStream=>{
      stream=nextStream;video.srcObject=stream;await video.play();const detector=new BarcodeDetector({formats:['code_39','code_128','qr_code','ean_13','ean_8','upc_a','upc_e','itf','codabar']});
      const detect=async()=>{try{const [code]=await detector.detect(video);if(code?.rawValue){close();onScan(code.rawValue);return;}}catch(_){}frame=requestAnimationFrame(detect);};detect();
    }).catch(()=>{close();statusElement.textContent='Camera permission was not granted. Scan with a Bluetooth scanner or enter the barcode number.';statusElement.classList.add('error');});
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
    scanSession={transfer,action,counts:new Map()};document.getElementById('transferScanPanel').hidden=false;document.getElementById('transferScanTitle').textContent=(action==='ship'?'Ship ':'Receive ')+transfer.transfer_number;
    document.getElementById('transferScanHelp').textContent=action==='ship'?'Scan every item leaving the origin. Confirming ships the transfer.':'Scan everything received. You can record discrepancies after the scan.';
    document.getElementById('transferScanStatus').textContent='';renderScan();document.getElementById('transferScanPanel').scrollIntoView({behavior:'smooth',block:'center'});document.getElementById('transferScanInput').focus();
  }
  function openDocumentScan(){documentScanPanel.hidden=false;documentScanInput.value='';documentScanStatus.textContent='Scan the main barcode from the transfer paperwork.';documentScanStatus.classList.remove('error');documentScanPanel.scrollIntoView({behavior:'smooth',block:'center'});documentScanInput.focus();}
  function openTransferFromPaperwork(value){
    const scanned=String(value||'').trim().toUpperCase();
    const transfer=transfers.find(item=>String(item.transfer_number||'').toUpperCase()===scanned);
    if(!transfer){documentScanStatus.textContent='No visible transfer matches '+scanned+'. Make sure you are signed into the destination warehouse.';documentScanStatus.classList.add('error');return;}
    if(!['in_transit','partially_received'].includes(transfer.status)){documentScanStatus.textContent=transfer.transfer_number+' is '+formatStatus(transfer.status)+'. It must be shipped before it can be received.';documentScanStatus.classList.add('error');return;}
    documentScanPanel.hidden=true;openScanner(transfer,'receive');
  }
  function renderScan(){const host=document.getElementById('transferScanRows');host.replaceChildren();(scanSession.transfer.transfer_lines||[]).forEach(line=>{const expected=Number(scanSession.action==='ship'?line.allocated_quantity:line.shipped_quantity),scanned=scanSession.counts.get(line.id)||0,row=document.createElement('tr');cell(row,line.products?.sku||'—');cell(row,String(expected));const countCell=document.createElement('td'),input=document.createElement('input');input.className='inventory-search';input.type='number';input.min='0';input.max=String(expected);input.step='1';input.value=String(scanned);input.setAttribute('aria-label','Scanned quantity for '+(line.products?.sku||'item'));input.addEventListener('change',()=>{const value=Math.max(0,Math.min(expected,Number(input.value)||0));scanSession.counts.set(line.id,value);input.value=String(value);document.getElementById('transferScanStatus').textContent=(line.products?.sku||'Item')+' set to '+value+' of '+expected+'.';document.getElementById('transferScanStatus').classList.remove('error');renderScan();});countCell.append(input);row.append(countCell);cell(row,String(Math.max(0,expected-scanned)));host.append(row);});}
  function scanValue(value){const term=String(value||'').trim().toLowerCase();if(!term)return;const line=(scanSession.transfer.transfer_lines||[]).find(x=>[x.products?.sku,x.products?.barcode,x.products?.name].filter(Boolean).some(v=>String(v).toLowerCase()===term));if(!line){document.getElementById('transferScanStatus').textContent='Not on this transfer: '+value;document.getElementById('transferScanStatus').classList.add('error');return;}const expected=Number(scanSession.action==='ship'?line.allocated_quantity:line.shipped_quantity),add=Math.max(1,Number(document.getElementById('transferScanQty').value)||1),next=(scanSession.counts.get(line.id)||0)+add;if(next>expected){document.getElementById('transferScanStatus').textContent='That would make '+line.products?.sku+' '+next+' of '+expected+'. Reduce the pieces to add or edit the scanned count.';document.getElementById('transferScanStatus').classList.add('error');return;}scanSession.counts.set(line.id,next);document.getElementById('transferScanStatus').textContent=line.products?.sku+' added '+add+' ('+next+'/'+expected+').';document.getElementById('transferScanStatus').classList.remove('error');renderScan();}
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
  document.getElementById('transferCameraScan').addEventListener('click',()=>openCamera(scanValue,document.getElementById('transferScanStatus')));
  documentScanInput.addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();openTransferFromPaperwork(event.currentTarget.value);}});
  document.getElementById('transferDocumentCameraScan').addEventListener('click',()=>openCamera(openTransferFromPaperwork,documentScanStatus));
  document.getElementById('transferDocumentCancel').addEventListener('click',()=>{documentScanPanel.hidden=true;});
  function renderQueue(){
    const term=queueSearch.value.trim().toLowerCase(),wanted=statusFilter.value;
    const visible=transfers.filter((transfer)=>{const line=transfer.transfer_lines?.[0],haystack=[transfer.transfer_number,transfer.from_location?.name,transfer.to_location?.name,transfer.status,line?.products?.sku,line?.products?.name].join(' ').toLowerCase();return (!term||haystack.includes(term))&&(!wanted||transfer.status===wanted);});
    if(!visible.length)return empty(rows,7,'No transfers match this view.');
    rows.replaceChildren();visible.forEach((transfer)=>{const row=document.createElement('tr'),lines=transfer.transfer_lines||[],pieces=lines.reduce((sum,line)=>sum+Number(line.requested_quantity||0),0);cell(row,transfer.transfer_number);cell(row,transfer.from_location?.name||'—');cell(row,transfer.to_location?.name||'—');cell(row,formatStatus(transfer.status));cell(row,String(lines.length));cell(row,String(pieces));const action=document.createElement('td');if(capabilities.canManageTransfers){const print=document.createElement('button');print.className='button secondary';print.type='button';print.textContent='Print';print.addEventListener('click',()=>printTransfer(transfer));action.append(print);if(transfer.status==='allocated')action.append(actionButton('Ship',transfer,'ship'));}if(capabilities.canReceiveTransfers&&['in_transit','partially_received'].includes(transfer.status))action.append(actionButton('Receive',transfer,'receive'));if(!action.childNodes.length)action.textContent='—';row.append(action);rows.append(row);});
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
    capabilities=data.capabilities||capabilities;
    [from,to].forEach((select)=>{select.replaceChildren();const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Choose location';select.append(placeholder);data.locations.forEach((location)=>select.append(locationOption(location)));});
    transfers=data.transfers||[];renderQueue();renderInTransit(data.inTransitLines||[],data.summary||{inTransitPieces:0,activeTransfers:0,inTransitSkus:0});renderHistory(data.history||[]);renderExceptions(data.exceptions||[]);
    applyCapabilities();
    show(capabilities.canManageTransfers?'Create, print, ship, and receive transfers in the V2 ledger.':'Scan an incoming transfer to receive it into your assigned warehouse.');
  }
  queueSearch.addEventListener('input',renderQueue);statusFilter.addEventListener('change',renderQueue);
  newTransferButton.addEventListener('click',()=>{if(!capabilities.canManageTransfers)return show('Only administrators can create transfers.',true);createMode=true;applyCapabilities();createPanel.scrollIntoView({behavior:'smooth',block:'center'});sku.focus();});
  async function openWorkspace(receiveOnly=false){otherViews.forEach((element)=>{if(element)element.hidden=true;});otherNavs.forEach((element)=>element&&element.classList.remove('active'));nav.classList.add('active');view.hidden=false;await load();applyCapabilities(receiveOnly);if(receiveOnly||!capabilities.canManageTransfers)openDocumentScan();}
  nav.addEventListener('click',()=>openWorkspace(false));
  overviewReceiveTransfer?.addEventListener('click',()=>openWorkspace(true));
  create.addEventListener('click',async()=>{
    if(!capabilities.canManageTransfers)return show('Only administrators can create transfers.',true);
    if(!from.value||!to.value||!sku.value.trim()||!quantity.value)return show('Choose locations, an exact SKU, and a quantity.',true);
    if(from.value===to.value)return show('Choose two different locations.',true);create.disabled=true;show('Allocating transfer…');
    try{const response=await fetch('/api/transfers',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({action:'create',fromLocationId:from.value,toLocationId:to.value,sku:sku.value,quantity:quantity.value})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Transfer could not be allocated.');sku.value='';quantity.value='';createMode=false;await load();show('Transfer '+data.transfer.transferNumber+' created and allocated. Ship it when it leaves.');}
    catch(error){show(error.message,true);}finally{create.disabled=false;}
  });
})();
