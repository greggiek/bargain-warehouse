(() => {
  const $ = id => document.getElementById(id);
  const view = $('inventoryView');
  if (!view) return;
  let loaded = false;
  let page = 1;
  let searchTimer;
  let request;

  const number = value => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const setStatus = (message, error = false) => {
    $('inventoryStatus').textContent = message;
    $('inventoryStatus').classList.toggle('error', error);
  };

  function renderRows(rows) {
    const body = $('inventoryRows');
    body.replaceChildren();
    rows.forEach(row => {
      const tr = document.createElement('tr');
      [row.sku || '—', row.name || '—', row.category || 'Uncategorized', number(row.onHand), number(row.allocated), number(row.onHand - row.allocated)].forEach((value, index) => {
        const td = document.createElement('td');
        td.textContent = value;
        if (index === 0) td.className = 'sku';
        if (index >= 3 && Number(String(value).replace(/,/g, '')) < 0) td.className = 'error';
        tr.append(td);
      });
      body.append(tr);
    });
    if (!rows.length) body.innerHTML = '<tr><td colspan="6" class="muted">No inventory items match this search.</td></tr>';
  }

  function setLocations(locations, locationId) {
    const select = $('inventoryLocation');
    if (loaded) return;
    select.replaceChildren();
    locations.forEach(location => {
      const option = document.createElement('option');
      option.value = location.id;
      option.textContent = location.name;
      select.append(option);
    });
    select.value = locationId;
    loaded = true;
  }

  async function load() {
    request?.abort();
    request = new AbortController();
    const refresh = $('inventoryRefresh');
    refresh.disabled = true;
    setStatus('Loading warehouse inventory…');
    try {
      const params = new URLSearchParams({
        locationId: $('inventoryLocation').value,
        search: $('inventorySearch').value.trim(),
        page: String(page),
        pageSize: '75'
      });
      const response = await fetch('/api/inventory?' + params, { cache: 'no-store', credentials: 'same-origin', signal: request.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw Error(data.error || 'V2 inventory request failed');
      setLocations(data.locations || [], data.locationId);
      $('inventoryLocation').value = data.locationId;
      renderRows(data.rows || []);
      $('inventorySkuCount').textContent = number(data.summary?.skuCount);
      $('inventoryOnHand').textContent = number(data.summary?.onHand);
      $('inventoryZeroCount').textContent = number(data.summary?.zeroOrNegative);
      $('inventoryCount').textContent = 'Showing ' + Math.min(data.total, (data.page - 1) * data.pageSize + 1) + '–' + Math.min(data.total, data.page * data.pageSize) + ' of ' + number(data.total) + ' SKUs';
      $('inventoryPage').textContent = 'Page ' + data.page + ' of ' + Math.max(1, Math.ceil(data.total / data.pageSize));
      $('inventoryPrev').disabled = data.page <= 1;
      $('inventoryNext').disabled = data.page * data.pageSize >= data.total;
      setStatus('V2 warehouse inventory · updated ' + new Date(data.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    } catch (error) {
      if (error.name !== 'AbortError') setStatus(error.message || 'Could not load inventory.', true);
    } finally {
      refresh.disabled = false;
    }
  }

  function show(viewName) {
    const inventory = viewName === 'inventory';
    const otherViews = ['atGlanceView', 'snapshotView', 'transferView', 'productionView', 'productSyncView', 'parLevelsView', 'bomManagementView', 'inventoryLedgerView', 'cycleCountReviewView', 'replenishmentView', 'binLocationsView'];
    otherViews.forEach(id => { const node = $(id); if (node) node.hidden = true; });
    $('overviewView').hidden = inventory;
    view.hidden = !inventory;
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', (inventory && item.id === 'inventoryNav') || (!inventory && item.id === 'overviewNav')));
    if (inventory && !loaded) load();
  }

  $('overviewNav').addEventListener('click', () => show('overview'));
  $('inventoryNav').addEventListener('click', () => show('inventory'));
  $('inventoryRefresh').addEventListener('click', () => load());
  $('inventoryLocation').addEventListener('change', () => { page = 1; load(); });
  $('inventoryPrev').addEventListener('click', () => { if (page > 1) { page -= 1; load(); } });
  $('inventoryNext').addEventListener('click', () => { page += 1; load(); });
  $('inventorySearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { page = 1; load(); }, 250);
  });
})();