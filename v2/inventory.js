(() => {
  const $ = id => document.getElementById(id);
  const view = $('inventoryView');
  if (!view) return;
  let loaded = false, searchTimer, request;
  const expandedWarehouses = new Set();
  const number = value => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const setStatus = (message, error = false) => {
    $('inventoryStatus').textContent = message;
    $('inventoryStatus').classList.toggle('error', error);
  };

  function setLocations(locations, selectedId) {
    const select = $('inventoryLocation');
    if (loaded) return;
    select.replaceChildren(new Option('All warehouses', ''));
    locations.forEach(location => select.add(new Option(location.name, String(location.id))));
    select.value = selectedId ? String(selectedId) : '';
    loaded = true;
  }

  function renderBoard(warehouses) {
    const host = $('inventoryCategoryBoard'); host.replaceChildren();
    $('inventoryLookup').hidden = true; host.hidden = false;
    if (!warehouses.length) { host.innerHTML = '<p class="muted">No V2 inventory is available at these warehouses yet.</p>'; return; }
    warehouses.forEach(warehouse => {
      const card = document.createElement('section'); card.className = 'low-stock-card';
      const head = document.createElement('div'); head.className = 'low-stock-card-head';
      const title = document.createElement('div'); title.innerHTML = '<span>WAREHOUSE</span><strong></strong>'; title.querySelector('strong').textContent = warehouse.name;
      const total = warehouse.categories.reduce((sum, category) => sum + category.available, 0);
      const badge = document.createElement('span'); badge.className = 'low-stock-badge'; badge.textContent = number(total) + ' available';
      head.append(title, badge); card.append(head);
      const expanded = expandedWarehouses.has(warehouse.id);
      const categories = expanded ? warehouse.categories : warehouse.categories.slice(0, 8);
      categories.forEach(category => {
        const row = document.createElement('div'); row.className = 'low-stock-row';
        const name = document.createElement('span'); name.textContent = category.category;
        const value = document.createElement('strong'); value.textContent = number(category.available) + ' available · ' + number(category.skuCount) + ' SKUs';
        row.append(name, value); card.append(row);
      });
      if (warehouse.categories.length > 8) {
        const more = document.createElement('button'); more.type = 'button'; more.className = 'low-stock-more';
        more.textContent = expanded ? 'Show fewer categories' : 'View all ' + warehouse.categories.length + ' categories →';
        more.addEventListener('click', () => {
          if (expanded) expandedWarehouses.delete(warehouse.id); else expandedWarehouses.add(warehouse.id);
          renderBoard(warehouses);
        });
        card.append(more);
      }
      host.append(card);
    });
  }

  function renderLookup(rows) {
    $('inventoryCategoryBoard').hidden = true; $('inventoryLookup').hidden = false;
    const body = $('inventoryRows'); body.replaceChildren();
    rows.forEach(row => {
      const tr = document.createElement('tr');
      const breakdown = (row.locations || []).map(location => location.location + ': ' + number(location.available)).join(' · ');
      [row.sku, row.name, row.category, number(row.onHand), number(row.allocated), number(row.available), breakdown || '—'].forEach((value, index) => {
        const td = document.createElement('td'); td.textContent = value;
        if (index === 0) td.className = 'sku';
        tr.append(td);
      });
      body.append(tr);
    });
    if (!rows.length) body.innerHTML = '<tr><td colspan="7" class="muted">No V2 inventory matches this SKU or product search.</td></tr>';
    $('inventoryCount').textContent = number(rows.length) + ' matching SKU' + (rows.length === 1 ? '' : 's');
  }

  async function load() {
    request?.abort(); request = new AbortController();
    const refresh = $('inventoryRefresh'); refresh.disabled = true;
    const search = $('inventorySearch').value.trim();
    setStatus(search.length >= 2 ? 'Looking up SKU availability…' : 'Loading category overview…');
    try {
      const params = new URLSearchParams({ locationId: $('inventoryLocation').value, search });
      const response = await fetch('/api/inventory?' + params, { cache: 'no-store', credentials: 'same-origin', signal: request.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw Error(data.error || 'V2 inventory request failed');
      setLocations(data.locations || [], data.locationId);
      $('inventoryLocation').value = data.locationId ? String(data.locationId) : '';
      $('inventorySkuCount').textContent = number(data.summary?.skuCount);
      $('inventoryOnHand').textContent = number(data.summary?.onHand);
      $('inventoryAvailable').textContent = number(data.summary?.available);
      $('inventoryWarehouseCount').textContent = number(data.summary?.warehouses);
      if (data.mode === 'lookup') renderLookup(data.rows || []);
      else renderBoard(data.warehouses || []);
      setStatus(data.mode === 'lookup'
        ? 'SKU lookup across ' + number(data.summary?.warehouses) + ' warehouse' + (data.summary?.warehouses === 1 ? '' : 's') + '.'
        : 'Category overview · updated ' + new Date(data.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    } catch (error) {
      if (error.name !== 'AbortError') setStatus(error.message || 'Could not load inventory.', true);
    } finally {
      refresh.disabled = false;
    }
  }

  function show(viewName) {
    const inventory = viewName === 'inventory';
    ['atGlanceView', 'snapshotView', 'transferView', 'productionView', 'productSyncView', 'parLevelsView', 'bomManagementView', 'inventoryLedgerView', 'cycleCountReviewView', 'replenishmentView', 'binLocationsView'].forEach(id => { const node = $(id); if (node) node.hidden = true; });
    $('overviewView').hidden = inventory; view.hidden = !inventory;
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', (inventory && item.id === 'inventoryNav') || (!inventory && item.id === 'overviewNav')));
    if (inventory) load();
  }

  $('overviewNav').addEventListener('click', () => show('overview'));
  $('inventoryNav').addEventListener('click', () => show('inventory'));
  $('inventoryRefresh').addEventListener('click', load);
  $('inventoryLocation').addEventListener('change', () => { expandedWarehouses.clear(); load(); });
  $('inventorySearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 220);
  });
})();