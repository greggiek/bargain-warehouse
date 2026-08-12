/* Bargain Warehouse — BM Time-inspired management UI */
(function(){
  const style=document.createElement('style');
  style.textContent=`
  :root{--bg:#f4f7fb;--card:#fff;--text:#102033;--muted:#607089;--line:#dfe6ef;--brand:#1769e0;--brand-dark:#0e4da7;--green:#137a46;--red:#b42318;--orange:#b85b00;--shadow:0 8px 24px rgba(16,32,51,.07);--navy:#092b47;--navy2:#071f35}
  body{background:var(--bg);color:var(--text)}
  .app-shell{max-width:none;margin:0;min-height:100vh;padding:18px 24px 30px 258px}
  .topbar{height:64px;padding:0 0 14px;margin-bottom:6px;align-items:center}
  .topbar .eyebrow{display:none}.topbar h1{font-size:22px;letter-spacing:-.02em;margin:0;color:#13283d}.top-actions select{min-width:190px;min-height:38px;border-radius:7px;font-size:13px}.icon-btn{width:38px;height:38px;border-radius:7px;font-size:19px}
  .employee-bar{padding:7px 10px;background:#fff;border:1px solid var(--line);border-radius:8px;margin-bottom:12px;min-height:42px}.employee-chip{border:0;background:#eef3f8;border-radius:7px;padding:6px 9px;font-size:12px}.logout-btn{font-size:12px}
  .hero-card,.panel,.login-card,.completion-card{border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow)}
  .hero-card{padding:18px 20px;margin-bottom:12px}.hero-card h2{font-size:24px}.panel{padding:16px 18px;margin-bottom:12px}.panel.compact{padding-bottom:16px}
  .section-head{margin-bottom:13px}.section-head h2,.section-head h3{font-size:18px}.eyebrow{font-size:10px;letter-spacing:.08em;color:#6d7d92}.muted{color:var(--muted)}
  select,input{border-color:#d6dee8;border-radius:7px;min-height:40px;padding:0 11px;font-size:13px}.scan-input{font-size:15px;min-height:46px}
  .primary,.success,.danger,.secondary,.print-btn,.label-btn{min-height:40px;border-radius:7px;padding:0 14px;font-size:13px}.primary{background:#1769e0}.secondary{background:#edf2f7}.success{background:#157a49}
  .action-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px}
  .action-card,.action-card.receive,.action-card.transfer,.action-card.adjust,.action-card.pick,.admin-card{background:#fff!important;color:var(--text)!important;border:1px solid var(--line)!important;border-radius:10px;padding:16px;min-height:106px;box-shadow:none;grid-template-columns:42px 1fr auto}
  .action-card:hover{border-color:#b9c9dd!important;box-shadow:0 5px 15px rgba(16,32,51,.06)}
  .action-icon,.admin-card .action-icon{width:42px;height:42px;border-radius:50%;background:#eaf2ff!important;color:#1769e0!important;font-size:21px}.action-card h3{font-size:16px;margin:0 0 4px}.action-card p{font-size:12px;color:var(--muted);opacity:1}.action-card>span{font-size:23px;color:#8a9bb0}
  .status-pill,.activity-badge{background:#eaf2ff;color:#1557a8;border-radius:999px;padding:5px 9px;font-size:11px}.quick-po,.pick-choice,.transfer-choice,.dash-kpi,.warehouse-loss-card,.adjust-card,.kpi,.line-item,.receive-line,.match-line{border-radius:8px;box-shadow:none}.quick-po{padding:11px 13px;font-size:13px}.pick-choice,.transfer-choice{padding:16px;min-height:120px}.pick-choice h3,.transfer-choice h3{font-size:17px}
  .receive-kpis,.dashboard-kpis{gap:8px}.kpi,.dash-kpi{background:#fff;padding:11px}.kpi strong{font-size:19px}.dash-kpi strong{font-size:23px}
  .receive-line,.match-line{padding:12px;gap:9px}.metric strong{font-size:17px}.issue-btn{border-radius:7px;min-height:38px}
  .locked-location,.warning-box,.manager-only,.scan-feedback,.exception-panel{border-radius:8px}.receive-footer{border-radius:8px;box-shadow:0 4px 14px rgba(16,32,51,.08)}
  .admin-table-wrap,.ticket-preview{border-radius:8px}.admin-table th,.ticket-preview th{background:#f1f5f9}.admin-table th,.admin-table td{padding:9px 10px}.activity-item{font-size:13px;padding:9px 0}
  .login-shell{max-width:500px;margin:70px auto}.login-card{padding:24px}.pin-key{border-radius:8px;background:#fff}.pin-display{border-radius:8px;background:#f2f6fa}
  .bm-sidebar{position:fixed;left:0;top:0;bottom:0;width:222px;background:linear-gradient(180deg,var(--navy),var(--navy2));color:#fff;padding:22px 14px;z-index:60;display:flex;flex-direction:column;box-shadow:1px 0 0 rgba(255,255,255,.04)}
  .bm-brand{padding:0 6px 23px;border-bottom:1px solid rgba(255,255,255,.08);margin-bottom:14px}.bm-brand-title{font-size:20px;font-weight:900;letter-spacing:-.02em}.bm-brand-title:before{content:'';display:inline-block;width:4px;height:23px;border-radius:3px;background:#247cff;margin-right:9px;vertical-align:-4px}.bm-brand-sub{font-size:9px;font-weight:800;letter-spacing:.12em;opacity:.65;margin:4px 0 0 14px}
  .bm-nav{display:grid;gap:4px}.bm-nav button{border:0;background:transparent;color:#dbe8f4;text-align:left;border-radius:7px;padding:10px 11px;font-size:13px;font-weight:700;display:flex;gap:10px;align-items:center}.bm-nav button:hover,.bm-nav button.active{background:rgba(255,255,255,.10);color:#fff}.bm-nav .ico{width:19px;text-align:center;font-size:15px}.bm-nav-bottom{margin-top:auto;padding-top:13px;border-top:1px solid rgba(255,255,255,.08)}
  body.bm-login .bm-sidebar{display:none}body.bm-login .app-shell{padding-left:24px}
  @media(max-width:900px){.app-shell{padding:12px 12px 82px}.bm-sidebar{left:0;right:0;top:auto;width:auto;height:66px;padding:6px 8px;display:block;background:#082844}.bm-brand{display:none}.bm-nav{display:flex;justify-content:space-around;gap:2px}.bm-nav button{flex:1;display:grid;justify-items:center;gap:2px;padding:5px 2px;font-size:9px}.bm-nav .ico{font-size:17px}.bm-nav-bottom{display:none}.topbar{height:auto;min-height:56px}.action-grid{grid-template-columns:1fr 1fr}.employee-bar{margin-bottom:10px}.hero-card{padding:15px}.panel{padding:14px}.top-actions{width:auto}.top-actions select{min-width:135px}.action-card{min-height:90px;padding:12px;grid-template-columns:38px 1fr auto}.action-icon{width:38px;height:38px}.action-card h3{font-size:14px}.action-card p{font-size:11px}}
  @media(max-width:560px){.action-grid{grid-template-columns:1fr}.bm-nav button:nth-child(n+6){display:none}.top-actions select{max-width:145px}.topbar h1{font-size:20px}}
  `;
  document.head.appendChild(style);

  const sidebar=document.createElement('aside');
  sidebar.className='bm-sidebar';
  sidebar.innerHTML=`<div class="bm-brand"><div class="bm-brand-title">BM WAREHOUSE</div><div class="bm-brand-sub">OPERATIONS</div></div><nav class="bm-nav" id="bmNav">
    <button data-bm-route="home"><span class="ico">⌂</span><span>Dashboard</span></button>
    <button data-bm-route="receive"><span class="ico">▣</span><span>Receiving</span></button>
    <button data-bm-route="transfer"><span class="ico">⇄</span><span>Transfers</span></button>
    <button data-bm-route="adjust"><span class="ico">±</span><span>Adjustments</span></button>
    <button data-bm-route="pickpack"><span class="ico">✓</span><span>Will Call</span></button>
    <button data-bm-route="fulfillment"><span class="ico">▤</span><span>Load</span></button>
    <button data-bm-route="admin"><span class="ico">▦</span><span>Admin</span></button>
  </nav><nav class="bm-nav bm-nav-bottom"><button id="bmHome"><span class="ico">⌂</span><span>Warehouse Home</span></button><button id="bmSignOut"><span class="ico">↪</span><span>Sign Out</span></button></nav>`;
  document.body.prepend(sidebar);

  function sync(){
    try{document.body.classList.toggle('bm-login',!state?.employee||state?.route==='login'||state?.route==='clock');}catch(e){}
    sidebar.querySelectorAll('[data-bm-route]').forEach(btn=>{
      const route=btn.dataset.bmRoute;
      const invOverview=route==='inventory-overview';
      btn.classList.toggle('active',invOverview?document.getElementById('inventoryOverview')?.classList.contains('active'):typeof state!=='undefined'&&state.route===route);
      let allowed=true;
      try{allowed=route==='home'||state.employee?.permissions?.includes(route)||route==='admin'&&state.employee?.permissions?.includes('admin')||invOverview&&state.employee?.permissions?.includes('admin')}catch(e){}
      btn.style.display=allowed?'':'none';
      if(!invOverview)btn.onclick=()=>{try{if(state.clockedIn)go(route)}catch(e){}};
    });
  }
  sidebar.querySelector('#bmHome').onclick=()=>{try{if(state.clockedIn)go('home')}catch(e){}};
  sidebar.querySelector('#bmSignOut').onclick=()=>{try{logout()}catch(e){}};
  const observer=new MutationObserver(sync);observer.observe(document.documentElement,{childList:true,subtree:true});
  setInterval(sync,1000);sync();
})();