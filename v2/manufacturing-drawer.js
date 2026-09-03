(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory;
  else root.createMfgDrawerLifecycle=factory;
})(typeof window==='undefined'?this:window,function createMfgDrawerLifecycle({drawer,body,document}){
  let listeners=null,opener=null;

  function cleanup({restoreFocus=true}={}){
    const priorOpener=opener;
    listeners?.abort();
    listeners=null;
    if(drawer.open)drawer.close();
    body.innerHTML='';
    document.body.classList.remove('mfg-drawer-open');
    opener=null;
    if(restoreFocus&&priorOpener?.isConnected&&typeof priorOpener.focus==='function'){
      try{priorOpener.focus({preventScroll:true})}catch{priorOpener.focus()}
    }
  }

  function bindSession(){
    if(listeners)return;
    listeners=new AbortController();
    const options={signal:listeners.signal};
    drawer.addEventListener('click',event=>{
      if(event.target===drawer||event.target?.closest?.('[data-close]'))cleanup();
    },options);
    drawer.addEventListener('cancel',event=>{
      event.preventDefault();
      cleanup();
    },options);
    drawer.addEventListener('close',()=>cleanup(),options);
  }

  function open(html){
    if(!drawer.open)opener=document.activeElement;
    body.innerHTML=html;
    bindSession();
    if(!drawer.open)drawer.showModal();
    document.body.classList.add('mfg-drawer-open');
  }

  return {open,close:cleanup};
});
