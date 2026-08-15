(() => {
  const mount = () => {
    const topbar = document.querySelector('.topbar');
    if (!topbar || topbar.querySelector('.bm-header-logo')) return;
    const brand = topbar.firstElementChild;
    if (!brand) return;
    brand.classList.add('bm-header-brand');
    const logo = document.createElement('img');
    logo.className = 'bm-header-logo';
    logo.src = './bm-warehouse-logo.png?v=1';
    logo.alt = 'BM Warehouse';
    logo.width = 400;
    logo.height = 112;
    brand.prepend(logo);
  };

  const style = document.createElement('style');
  style.textContent = `
    .bm-header-brand{position:fixed;top:10px;left:12px;z-index:30;display:flex;align-items:flex-start}
    .bm-header-logo{display:block;width:165px;height:auto;object-fit:contain}
    .bm-header-brand>.eyebrow{display:none}
    .bm-header-brand>#pageTitle{display:none}
    @media(max-width:760px){
      .bm-header-brand{top:9px;left:10px}
      .bm-header-logo{width:145px}
      .topbar{gap:10px}
    }
  `;
  document.head.appendChild(style);
  new MutationObserver(mount).observe(document.documentElement, { childList:true, subtree:true });
  mount();
})();
