/* BM Warehouse - read-only Shopify inventory overview */
(function () {
  const WAREHOUSES = [
    { key: 'bayview', label: 'Bayview', locations: ['Bayview Warehouse'] },
    { key: 'bohemia', label: 'Bohemia', locations: ['Bohemia Warehouse'] },
    { key: 'outpost', label: 'Outpost - Ronkonkoma', locations: ['Outpost - Ronkonkoma'] },
    { key: 'riverhead', label: 'Riverhead', locations: ['Riverhead Warehouse'] },
    { key: 'windham', label: 'Windham', locations: ['730 Windham Rd'] },
    { key: 'annex', label: 'Annex', locations: ['Annex (Retail) 730'] }
  ];

  const css = document.createElement('style');
  css.textContent = `
    .inv-overview{display:none}.inv-overview.active{display:block}.inv-hero{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;margin-bottom:12px}.inv-hero h2{font-size:27px;margin:3px 0}.inv-hero p{margin:0;color:#607089}.inv-actions{display:flex;gap:8px}.inv-search{width:300px;min-height:40px}.inv-refresh{border:1px solid #d6dee8;background:#fff;border-radius:7px;min-height:40px;padding:0 14px;font-weight:800;color:#17324d;cursor:pointer}.inv-status{padding:18px;background:#fff;border:1px solid #dfe6ef;border-radius:10px;color:#607089}.inv-error{color:#b42318}.inv-wrap{background:#fff;border:1px solid #dfe6ef;border-radius:10px;overflow:hidden}.inv-table-scroll{overflow:auto;max-height:calc(100vh - 205px)}.inv-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px}.inv-table th{position:sticky;top:0;z-index:2;background:#f1f5f9;color:#52657a;text-align:right;text-transform:uppercase;letter-spacing:.04em;font-size:10px;padding:10px 12px;border-bottom:1px solid #dfe6ef;white-space:nowrap}.inv-table td{padding:9px 12px;border-bottom:1px solid #edf1f5;text-align:right;white-space:nowrap}.inv-table th:first-child,.inv-table td:first-child{text-align:left;position:sticky;left:0;background:#fff;z-index:1}.inv-table th:first-child{z-index:3;background:#f1f5f9}.inv-table th:nth-child(2),.inv-table td:nth-child(2){text-align:left}.inv-table tbody tr:hover td,.inv-table tbody tr:hover td:first-child{background:#f8fbff}.inv-sku{font-weight:850;color:#102033}.inv-name{color:#5f7085;max-width:420px;overflow:hidden;text-overflow:ellipsis}.inv-total{font-weight:900;color:#102033}.inv-zero{color:#b3bdc9}.inv-footbar{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 12px;background:#fafbfd;color:#718196;font-size:11px;border-top:1px solid #edf1f5}.inv-count{font-weight:800;color:#52657a}.inv-mode{font-weight:800;color:#18794e}
    @media(max-width:900px){.inv-hero{align-items:flex-start;flex-direction:column}.inv-actions{width:100%}.inv-search{width:100%;flex:1}.inv-table-scroll{max-height:calc(100vh - 250px)}}
  `;
  document.head.appendChild(css);

  const screen = document.createElement('section');
  screen.className = 'inv-overview';
  screen.id = 'inventoryOverview';
  let rows = [];
  let loading = false;
  let generatedAt = null;

  screen.innerHTML = `<div class="inv-hero"><div><div class="eyebrow">NETWORK INVENTORY</div><h2>Inventory Overview</h2><p>Live on-hand inventory from both Shopify stores.</p></div><div class="inv-actions"><input class="inv-search" id="invSearch" placeholder="Search all inventory…"><button class="inv-refresh" id="invRefresh">Refresh Shopify</button></div></div><div id="invBody"><div class="inv-status">Loading live Shopify inventory…</div></div>`;

  function num(value) {
    return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function cell(value, className = '') {
    return `<td class="${className} ${Number(value || 0) === 0 ? 'inv-zero' : ''}">${num(value)}</td>`;
  }

  function normalize(item) {
    const grouped = Object.fromEntries(WAREHOUSES.map(warehouse => [warehouse.key, 0]));

    for (const inventory of item.locations || []) {
      const warehouse = WAREHOUSES.find(candidate =>
        candidate.locations.includes(String(inventory.locationName || '').trim())
      );
      if (warehouse) grouped[warehouse.key] += Number(inventory.onHand || 0);
    }

    return {
      sku: String(item.sku || '').trim(),
      name: item.product || '',
      total: Number(item.totalOnHand || 0),
      ...grouped
    };
  }

  function render() {
    const body = screen.querySelector('#invBody');
    const query = (screen.querySelector('#invSearch')?.value || '').trim().toLowerCase();
    const shown = query
      ? rows.filter(row => `${row.sku} ${row.name}`.toLowerCase().includes(query))
      : rows;

    body.innerHTML = `<div class="inv-wrap"><div class="inv-table-scroll"><table class="inv-table"><thead><tr><th>SKU</th><th>Product</th><th>Total</th>${WAREHOUSES.map(warehouse => `<th>${esc(warehouse.label)}</th>`).join('')}</tr></thead><tbody>${shown.map(row => `<tr><td class="inv-sku">${esc(row.sku)}</td><td class="inv-name" title="${esc(row.name)}">${esc(row.name)}</td>${cell(row.total, 'inv-total')}${WAREHOUSES.map(warehouse => cell(row[warehouse.key])).join('')}</tr>`).join('')}</tbody></table></div><div class="inv-footbar"><span class="inv-count">Showing ${shown.length.toLocaleString()} of ${rows.length.toLocaleString()} SKUs</span><span class="inv-mode">Shopify read-only</span><span>${generatedAt ? `Updated ${new Date(generatedAt).toLocaleTimeString()}` : ''}</span></div></div>`;
  }

  function mount() {
    const shell = document.querySelector('.app-shell');
    if (shell && !screen.isConnected) shell.appendChild(screen);
    const nav = document.querySelector('#bmNav');
    if (nav && !nav.querySelector('[data-bm-route="inventory-overview"]')) {
      const button = document.createElement('button');
      button.dataset.bmRoute = 'inventory-overview';
      button.innerHTML = '<span class="ico">▥</span><span>Inventory Overview</span>';
      nav.insertBefore(button, nav.querySelector('[data-bm-route="admin"]'));
      button.onclick = show;
    }
  }

  function show() {
    document.querySelectorAll('.app-shell > *').forEach(element => {
      if (element !== screen) element.dataset.invPrev = element.style.display || '';
      if (element !== screen) element.style.display = 'none';
    });
    screen.classList.add('active');
    document.querySelectorAll('#bmNav button').forEach(button =>
      button.classList.toggle('active', button.dataset.bmRoute === 'inventory-overview')
    );
    load();
  }

  function hide() {
    if (!screen.classList.contains('active')) return;
    screen.classList.remove('active');
    document.querySelectorAll('.app-shell > *').forEach(element => {
      if (element !== screen) {
        element.style.display = element.dataset.invPrev || '';
        delete element.dataset.invPrev;
      }
    });
  }

  async function load() {
    if (loading) return;
    loading = true;
    const body = screen.querySelector('#invBody');
    body.innerHTML = '<div class="inv-status">Loading both Shopify stores…</div>';
    try {
      const response = await fetch('/api/shopify-sync-preview', { cache: 'no-store' });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch (_) {
        throw new Error(`Inventory API returned ${response.status} instead of JSON`);
      }
      if (!response.ok || !data.ok) throw new Error(data.error || 'Shopify inventory request failed');
      if (data.writesEnabled !== false) throw new Error('Safety check failed: Shopify feed is not marked read-only');
      rows = (data.normalized || []).map(normalize);
      generatedAt = data.generatedAt || null;
      render();
    } catch (error) {
      body.innerHTML = `<div class="inv-status inv-error">Could not load Shopify inventory: ${esc(error.message || error)}</div>`;
    } finally {
      loading = false;
    }
  }

  screen.addEventListener('click', event => {
    if (event.target.id === 'invRefresh') load();
  });
  screen.addEventListener('input', event => {
    if (event.target.id === 'invSearch') render();
  });

  const oldGo = window.go;
  if (typeof oldGo === 'function') {
    window.go = function (route) {
      if (route !== 'inventory-overview') hide();
      return oldGo.apply(this, arguments);
    };
  }

  const observer = new MutationObserver(mount);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(mount, 1000);
  mount();
})();
