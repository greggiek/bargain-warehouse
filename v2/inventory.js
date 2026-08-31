(() => {
  const $ = id => document.getElementById(id);
  const view = $('inventoryView'); if (!view) return;
  let loaded = false, searchTimer, request, lastData;
  const number = value => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const shortLocation = name => {
    const value = String(name || '');
    if (/amityville/i.test(value)) return 'Amity';
    if (/bohemia/i.test(value)) return 'Bohemia';
    if (/outpost|ronkonkoma/i.test(value)) return 'Outpost';
    if (/windham/i.test(value)) return 'Windham';
    if (/annex/i.test(value)) return 'Annex';
    if (/riverhead/i.test(value)) return 'River.';
    return value;
  };
  const setStatus = (message, error = false) => { $('inventoryStatus').textContent = message; $('inventoryStatus').classList.toggle('error', error); };
  function setLocations(locations, selectedId) {
    const select = $('inventoryLocation');
    if (!loaded) { select.replaceChildren(new Option('All warehouses', '')); locations.forEach(x => select.add(new Option(x.name, String(x.id)))); loaded = true; }
    select.value = selectedId ? String(selectedId) : '';
  }
  function setCategories(categories, locationId, selected) {
    const select = $('inventoryCategory'); select.replaceChildren(new Option(locationId ? 'All categories' : 'Choose a warehouse first', ''));
    if (locationId) categories.filter(x => Number(x.locationId) === Number(locationId)).forEach(x => select.add(new Option(x.category + ' · ' + number(x.itemCount) + ' items', x.category)));
    select.value = selected || ''; select.disabled = !locationId;
  }
  function renderMatrix(rows, locations, detail) {
    const head = $('inventoryLookupHead'); head.replaceChildren();
    const header = document.createElement('tr');
    ['Item description', 'SKU', ...locations.map(x => shortLocation(x.name))].forEach(label => { const th = document.createElement('th'); th.textContent = label; header.append(th); });
    head.append(header);
    const body = $('inventoryRows'); body.replaceChildren();
    rows.forEach(row => {
      const tr = document.createElement('tr');
      [row.name, row.sku, ...locations.map(x => number(row.quantities?.[x.id] || 0))].forEach((value,index) => { const td=document.createElement('td'); td.textContent=value; if(index===1)td.className='sku'; tr.append(td); });
      body.append(tr);
    });
    if (!rows.length) body.innerHTML = '<tr><td colspan="' + (locations.length + 2) + '" class="muted">No items match this view.</td></tr>';
    $('inventoryCount').textContent = number(rows.length) + ' items' + (detail ? ' in this category' : '');
    $('inventoryDetailTitle').textContent = detail ? detail : 'All inventory';
    $('inventoryBack').hidden = !detail;
  }
  async function load() {
    request?.abort(); request = new AbortController();
    const refresh = $('inventoryRefresh'); refresh.disabled = true;
    const locationId = $('inventoryLocation').value, category = $('inventoryCategory').value, search = $('inventorySearch').value.trim();
    setStatus('Loading inventory…');
    try {
      const params = new URLSearchParams({ locationId, category, search });
      const response = await fetch('/api/inventory?' + params, { cache:'no-store', credentials:'same-origin', signal:request.signal });
      const data = await response.json().catch(() => ({})); if (!response.ok || !data.ok) throw Error(data.error || 'Inventory request failed');
      lastData=data; setLocations(data.allLocations || [], data.locationId); setCategories(data.categories || [], data.locationId, data.category);
      renderMatrix(data.rows || [], data.locations || [], data.category ? ((data.locations?.[0]?.name || 'Warehouse') + ' · ' + data.category) : '');
      setStatus('Updated ' + new Date(data.generatedAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}) + '.');
    } catch (error) { if (error.name !== 'AbortError') setStatus(error.message || 'Could not load inventory.',true); }
    finally { refresh.disabled=false; }
  }
  function show(viewName) {
    const inventory = viewName === 'inventory';
    ['atGlanceView','snapshotView','transferView','productionView','productSyncView','parLevelsView','bomManagementView','inventoryLedgerView','cycleCountReviewView','replenishmentView','binLocationsView','purchaseOrdersView','poArrivalsView','forecastingView','vendorDirectoryView','shopifyWebhookView','skuFixView'].forEach(id => { const node=$(id); if(node) node.hidden=true; });
    $('overviewView').hidden=inventory; view.hidden=!inventory;
    document.querySelectorAll('.nav-item').forEach(item=>item.classList.toggle('active',(inventory&&item.id==='inventoryNav')||(!inventory&&item.id==='overviewNav')));
    if(inventory) load();
  }
  $('overviewNav').addEventListener('click',()=>show('overview'));
  $('inventoryNav').addEventListener('click',()=>show('inventory'));
  $('inventoryRefresh').addEventListener('click',load);
  $('inventoryLocation').addEventListener('change',()=>{ $('inventoryCategory').value=''; load(); });
  $('inventoryCategory').addEventListener('change',load);
  $('inventoryBack').addEventListener('click',()=>{ $('inventoryCategory').value=''; load(); });
  $('inventorySearch').addEventListener('input',()=>{ clearTimeout(searchTimer); searchTimer=setTimeout(load,220); });
})();