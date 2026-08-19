(() => {
 const $=id=>document.getElementById(id); const view=$('replenishmentView'); if(!view)return;
 let all=[];
 const fmt=n=>new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(n);
 const set=(t,e=false)=>{$('replenishmentStatus').textContent=t;$('replenishmentStatus').classList.toggle('error',e);};
 function render(){
  const term=$('replenishmentSearch').value.trim().toLowerCase(),loc=$('replenishmentLocation').value;
  const rows=all.filter(x=>(!loc||String(x.locationId)===loc)&&(!term||[x.sku,x.product,x.category,x.barcode,x.location].join(' ').toLowerCase().includes(term)));
  const host=$('replenishmentRows');host.replaceChildren();
  rows.forEach(x=>{const tr=document.createElement('tr');[x.location,x.sku,x.product,x.category||'—',fmt(x.onHand),fmt(x.shortage),fmt(x.shortage)].forEach((v,i)=>{const td=document.createElement('td');td.textContent=v;if(i===4)td.className='zero';if(i===5||i===6)td.style.color='#ff8a8a';tr.append(td)});host.append(tr);});
  if(!rows.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=7;td.className='muted';td.textContent='No shortages match those filters.';tr.append(td);host.append(tr);}
  const total=rows.reduce((n,x)=>n+x.shortage,0);$('replenishmentCount').textContent=rows.length+' shortage SKUs';$('replenishmentDeficit').textContent=fmt(total)+' pieces to replenish';
 }
 async function load(){
  set('Loading V2 shortages…');const r=await fetch('/api/replenishment',{credentials:'same-origin',cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Unable to load replenishment');
  all=d.items||[];const s=$('replenishmentLocation');s.replaceChildren();const o=document.createElement('option');o.value='';o.textContent='All warehouses';s.append(o);(d.locations||[]).forEach(x=>{const o=document.createElement('option');o.value=x.id;o.textContent=x.name;s.append(o);});
  const total=all.reduce((n,x)=>n+x.shortage,0);set(all.length+' shortage SKUs · '+fmt(total)+' total pieces required. These are V2 replenishment signals only.');render();
 }
 $('replenishmentNav').addEventListener('click',()=>{view.hidden=false;document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.id==='replenishmentNav'));load().catch(e=>set(e.message,true));});
 ['overviewNav','inventoryNav','productSyncNav','snapshotNav','transfersNav','receivingNav','productionNav'].forEach(id=>$(id)?.addEventListener('click',()=>view.hidden=true));
 $('replenishmentRefresh').addEventListener('click',()=>load().catch(e=>set(e.message,true)));
 $('replenishmentSearch').addEventListener('input',render);$('replenishmentLocation').addEventListener('change',render);
})();