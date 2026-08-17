/* BM Warehouse - Cycle Count workspace */
(() => {
  const screen = document.createElement('section');
  screen.id = 'cycleCountScreen';
  screen.className = 'cycle-count-screen';
  screen.style.display = 'none';

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

  function currentWarehouse() {
    return state.location || document.querySelector('#locationSelect')?.value || 'Select a warehouse';
  }

  function render() {
    const warehouse = currentWarehouse();
    screen.innerHTML = `
      <section class="hero-card cycle-count-hero">
        <div>
          <div class="eyebrow">INVENTORY CONTROL</div>
          <h2>Cycle Count</h2>
          <p class="muted">Count selected inventory at ${escapeHtml(warehouse)} without changing Qoblex or Shopify.</p>
        </div>
        <span class="cycle-count-location">${escapeHtml(warehouse)}</span>
      </section>
      <section class="cycle-count-actions">
        <article class="panel">
          <div class="cycle-count-icon">⌗</div>
          <h3>Start New Count</h3>
          <p class="muted">Choose an aisle, bin, product group, or list of SKUs to count.</p>
          <button class="primary" id="startCycleCount">Start New Count</button>
        </article>
        <article class="panel">
          <div class="cycle-count-icon">☷</div>
          <h3>Count History</h3>
          <p class="muted">Review completed counts, differences, and who performed each count.</p>
          <button class="secondary" id="reviewCycleCounts">Review History</button>
        </article>
      </section>
      <section class="panel cycle-count-empty" id="cycleCountWorkspace">
        <div class="eyebrow">CYCLE COUNT WORKSPACE</div>
        <h3>Ready for setup</h3>
        <p class="muted">Starting or reviewing counts will be connected in the next step. This section is read-only and cannot move inventory.</p>
      </section>`;

    screen.querySelector('#startCycleCount').onclick = () => {
      screen.querySelector('#cycleCountWorkspace').innerHTML = '<div class="eyebrow">NEW COUNT</div><h3>Choose what should be counted</h3><p class="muted">The count setup workflow is ready to be defined: aisle/bin, product group, or selected SKUs.</p>';
    };
    screen.querySelector('#reviewCycleCounts').onclick = () => {
      screen.querySelector('#cycleCountWorkspace').innerHTML = '<div class="eyebrow">COUNT HISTORY</div><h3>No cycle counts yet</h3><p class="muted">Completed cycle counts will appear here after the counting workflow is connected.</p>';
    };
  }

  function mount() {
    const shell = document.querySelector('.app-shell');
    if (shell && !screen.isConnected) shell.appendChild(screen);
    const nav = document.querySelector('#bmNav');
    if (!nav || nav.querySelector('[data-bm-route="cycle-count"]')) return;
    const button = document.createElement('button');
    button.dataset.bmRoute = 'cycle-count';
    button.innerHTML = '<span class="ico">✓</span><span>Cycle Count</span>';
    const before = nav.querySelector('[data-bm-route="adjust"]') || nav.querySelector('.bm-operations-extra');
    nav.insertBefore(button, before || null);
    button.onclick = show;
  }

  function show() {
    if (typeof go === 'function') go('home');
    state.route = 'cycle-count';
    pageTitle.textContent = 'Cycle Count';
    document.querySelectorAll('.app-shell > *').forEach(element => {
      if (element !== screen) element.style.display = 'none';
    });
    render();
    screen.style.display = 'block';
    document.querySelectorAll('#bmNav button').forEach(button =>
      button.classList.toggle('active', button.dataset.bmRoute === 'cycle-count')
    );
  }

  function hide() {
    screen.style.display = 'none';
  }

  const css = document.createElement('style');
  css.textContent = `
    .cycle-count-hero{display:flex;align-items:center;justify-content:space-between;gap:18px}
    .cycle-count-hero h2{margin:4px 0}.cycle-count-hero p{margin:0}
    .cycle-count-location{padding:8px 12px;border-radius:999px;background:#e8f1f8;color:#17324d;font-size:12px;font-weight:850}
    .cycle-count-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:14px 0}
    .cycle-count-actions .panel{margin:0}.cycle-count-actions h3{margin:10px 0 4px}.cycle-count-actions p{min-height:40px}
    .cycle-count-icon{display:grid;place-items:center;width:38px;height:38px;border-radius:10px;background:#e8f1f8;color:#17324d;font-size:20px;font-weight:900}
    .cycle-count-empty{text-align:center;padding:34px}.cycle-count-empty h3{margin:7px 0}
    @media(max-width:700px){.cycle-count-hero{align-items:flex-start;flex-direction:column}.cycle-count-actions{grid-template-columns:1fr}}
  `;
  document.head.appendChild(css);

  window.bmOpenCycleCount = show;
  const oldGo = window.go;
  if (typeof oldGo === 'function') {
    window.go = function (route) {
      if (route !== 'cycle-count') hide();
      return oldGo.apply(this, arguments);
    };
  }
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
  mount();
})();
