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
    .bm-header-brand{display:flex;flex-direction:column;align-items:flex-start;min-width:0}
    .bm-header-logo{display:block;width:clamp(210px,28vw,330px);height:auto;object-fit:contain}
    .bm-header-brand>.eyebrow{display:none}
    .bm-header-brand>#pageTitle{font-size:14px;margin:3px 0 0 3px;color:var(--muted);letter-spacing:.04em}
    @media(max-width:760px){
      .bm-header-logo{width:clamp(165px,48vw,230px)}
      .bm-header-brand>#pageTitle{font-size:12px}
      .topbar{gap:10px}
    }
  `;
  document.head.appendChild(style);
  new MutationObserver(mount).observe(document.documentElement, { childList:true, subtree:true });
  mount();
})();
