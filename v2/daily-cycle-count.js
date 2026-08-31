(() => {
  const $=id=>document.getElementById(id);let loaded=false;
  const set=(text,error=false)=>{$('cycleCountStatus').textContent=text;$('cycleCountStatus').classList.toggle('error',error);};
  function rows(lines) {
    const host=$('cycleCountRows'); host.replaceChildren();
    lines.forEach(line => {
      const done=line.status!=='pending', item=document.createElement('article'); item.className='daily-count-line';
      const info=document.createElement('div'), sku=document.createElement('strong'), name=document.createElement('span');
      sku.textContent=line.products?.sku||'—'; name.textContent=line.products?.name||'Unnamed item'; info.append(sku,name); item.append(info);
      if (done) {
        const state=document.createElement('div'); state.className='daily-count-state'; state.textContent='Counted: '+line.counted_quantity; item.append(state);
      } else {
        const input=document.createElement('input'); input.className='inventory-search'; input.type='number'; input.min='0'; input.step='1'; input.inputMode='numeric'; input.placeholder='Count';
        const button=document.createElement('button'); button.className='button'; button.type='button'; button.textContent='Save'; button.onclick=()=>save(line.id,input.value);
        item.append(input,button);
      }
      host.append(item);
    });
  }
  function render(data){const location=$('cycleCountLocation');if(!loaded){location.replaceChildren();data.locations.forEach(x=>{const option=document.createElement('option');option.value=x.id;option.textContent=x.name;location.append(option)});location.value=data.run.location_id;loaded=true;}rows(data.run.lines||[]);const completed=(data.run.lines||[]).filter(x=>x.status!=='pending').length,total=(data.run.lines||[]).length;set(completed+' of '+total+' counted.');}
  async function load(){set('Loading count…');const r=await fetch('/api/daily-cycle-count?locationId='+encodeURIComponent($('cycleCountLocation').value),{credentials:'same-origin'}),data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'Could not load daily cycle count.');render(data);}
  async function save(lineId,value){const r=await fetch('/api/daily-cycle-count',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({locationId:Number($('cycleCountLocation').value),lineId,countedQuantity:Number(value)})}),data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'Could not save count.');render(data);set('Count saved.');}
  function open(){$('dailyCycleCountDialog').showModal();load().catch(e=>set(e.message,true));}
  window.BMWarehouseQuickDailyCount = open;
  $('overviewDailyCycleCount').onclick=open;$('cycleCountLocation').onchange=()=>load().catch(e=>set(e.message,true));
})();