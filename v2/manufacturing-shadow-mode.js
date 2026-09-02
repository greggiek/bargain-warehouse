(()=>{
 const view=document.getElementById('productionView');if(!view)return;
 const apply=()=>{
  const head=view.querySelector('.mfg-head');
  if(head&&!view.querySelector('.mfg-shadow-banner')){
   const banner=document.createElement('section');banner.className='mfg-shadow-banner';banner.setAttribute('role','status');
   banner.innerHTML='<strong>SHADOW MODE — Qoblex remains the live Manufacturing system</strong><span>BM Warehouse is for comparison and draft workflow testing only. It will not release production, change inventory, create transfers, or update Shopify.</span>';
   head.after(banner);
  }
  view.querySelectorAll('button').forEach(button=>{
   const label=button.textContent.trim();
   if(label==='Save Draft')button.textContent='Save Shadow Draft';
   if(/^(Release Work Order|Start|Pause|Resume|Record Progress|Confirm progress|Review Transfer|Open Transfer detail|Create new draft version)$/.test(label)){
    button.disabled=true;button.title='Unavailable in Shadow Mode — use Qoblex for live Manufacturing';button.setAttribute('aria-disabled','true');
   }
  });
 };
 new MutationObserver(apply).observe(view,{childList:true,subtree:true});apply();
})();
