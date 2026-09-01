(() => {
  const $ = id => document.getElementById(id);
  const view = $('inventoryView'); if (!view) return;\n  const values = globalThis.InventoryValues || { signedInventory: (onHand, committed, available) => ({ onHand:Number(onHand||0), committed:Number(committed||0), available:available == null ? Number(onHand||0)-Number(committed||0) : Number(available||0) }) };
  let loaded = false, searchTimer, request, lastData, sortLocationId = null, sortDirection = 'desc';
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
    ['Item description', 'SKU'].forEach(label => { const th = document.createElement('th'); th.textContent = label; header.append(th); });
    locations.forEach(location => {
      const th = document.createElement('th'), button = document.createElement('button');
      button.type = 'button'; button.className = 'inventory-sort-button';
      const active = Number(sortLocationId) === Number(location.id);
      button.textContent = shortLocation(location.name) + (active ? (sortDirection === 'desc' ? ' ↓' : ' ↑') : '');
      button.title = 'Sort ' + location.name + (active && sortDirection === 'desc' ? ' lowest to highest' : ' highest to lowest');
      button.onclick = () => {
        if (Number(sortLocationId) === Number(location.id)) sortDirection = sortDirection === 'desc' ? 'asc' : 'desc';
        else { sortLocationId = location.id; sortDirection = 'desc'; }
        renderMatrix(lastData?.rows || [], lastData?.locations || [], lastData?.category ? ((lastData.locations?.[0]?.name || 'Warehouse') + ' · ' + lastData.category) : '');
      };
      th.append(button); header.append(th);
    });
    head.append(header);
    const body = $('inventoryRows'); body.replaceChildren();
    const orderedRows = [...rows].sort((a, b) => {
      if (!sortLocationId) return a.name.localeCompare(b.name) || a.sku.localeCompare(b.sku);
      const delta = Number(a.quantities?.[sortLocationId] || 0) - Number(b.quantities?.[sortLocationId] || 0);
      return sortDirection === 'desc' ? -delta : delta;
    });
    orderedRows.forEach(row => {
      const tr = document.createElement('tr');
      const name = document.createElement('td'); name.textContent = row.name; tr.append(name);
      const sku = document.createElement('td'); sku.textContent = row.sku; sku.className = 'sku'; tr.append(sku);
      locations.forEach(location => {
        const detail = values.signedInventory(row.inventory?.[location.id]?.onHand ?? row.quantities?.[location.id] ?? 0,row.inventory?.[location.id]?.committed ?? 0,row.inventory?.[location.id]?.available);
        const td = document.createElement('td'); td.className = 'inventory-quantity-detail';
        [['On hand',detail.onHand],['Committed',detail.committed],['Available',detail.available]].forEach(([label,value]) => {
          const line = document.createElement('span'); line.className = value < 0 ? 'negative' : value === 0 ? 'zero' : '';
          const caption = document.createElement('small'); caption.textContent = label;
          const amount = document.createElement('strong'); amount.textContent = number(value);
          line.append(caption,amount); td.append(line);
        });
        tr.append(td);
      });
      body.append(tr);
    });
    if (!rows.length) body.innerHTML = '<tr><td colspan="' + (locations.length + 2) + '" class="muted">No items match this view.</td></tr>';
    $('inventoryCount').textContent = number(rows.length) + ' items' + (detail ? ' in this category' : '');
    $('inventoryDetailTitle').textContent = detail ? detail : 'All inventory';
    $('inventoryBack').hidden = !detail;
  }
  function csvCell(value) { const text = String(value ?? ''); return /[",\n]/.test(text) ? '"' + text.replaceAll('"','""') + '"' : text; }
  function exportCsv() {
    if (!lastData) return setStatus('Load inventory before exporting.', true);
    const locations = lastData.locations || [];
    const headers = ['Product','SKU',...locations.flatMap(location => [location.name + ' On hand',location.name + ' Committed',location.name + ' Available'])];
    const lines = [headers,...(lastData.rows || []).map(row => [row.name,row.sku,...locations.flatMap(location => {
      const detail = values.signedInventory(row.inventory?.[location.id]?.onHand ?? row.quantities?.[location.id] ?? 0,row.inventory?.[location.id]?.committed ?? 0,row.inventory?.[location.id]?.available);
      return [detail.onHand,detail.committed,detail.available];
    })])].map(row => row.map(csvCell).join(','));
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([lines.join('\n')],{type:'text/csv;charset=utf-8'}));
    link.download = 'bm-inventory-signed-' + new Date().toISOString().slice(0,10) + '.csv'; link.click(); URL.revokeObjectURL(link.href);
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
  $('inventoryRefresh').addEventListener('click',load);\n  const exportButton = document.createElement('button'); exportButton.id='inventoryExport'; exportButton.type='button'; exportButton.className='button secondary'; exportButton.textContent='Export CSV'; exportButton.addEventListener('click',exportCsv); $('inventoryRefresh').after(exportButton);
  $('inventoryLocation').addEventListener('change',()=>{ $('inventoryCategory').value=''; load(); });
  $('inventoryCategory').addEventListener('change',load);
  $('inventoryBack').addEventListener('click',()=>{ $('inventoryCategory').value=''; load(); });
  $('inventorySearch').addEventListener('input',()=>{ clearTimeout(searchTimer); searchTimer=setTimeout(load,220); });
})();