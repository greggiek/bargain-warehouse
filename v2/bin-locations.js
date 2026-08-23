(() => {
  const $ = id => document.getElementById(id);
  const view = $('binLocationsView');
  if (!view) return;
  let products = [], loaded = false;
  const set = (message, error = false) => { $('binLocationStatus').textContent = message; $('binLocationStatus').classList.toggle('error', error); };
  const setDialog = (message, error = false) => { $('binLocationDialogStatus').textContent = message; $('binLocationDialogStatus').classList.toggle('error', error); };

  function renderProducts() {
    const term = $('binLocationProductSearch').value.trim().toLowerCase(), host = $('binLocationProductOptions');
    host.replaceChildren();
    products.filter(product => !term || (product.sku + ' ' + product.name + ' ' + product.category).toLowerCase().includes(term)).slice(0, 12).forEach(product => {
      const option = document.createElement('button'); option.type = 'button'; option.className = 'product-suggestion';
      option.innerHTML = '<strong></strong> · <span></span><small></small>';
      option.querySelector('strong').textContent = product.sku;
      option.querySelector('span').textContent = product.name;
      option.querySelector('small').textContent = (product.category || 'Uncategorized') + ' · On hand: ' + product.quantity;
      option.onclick = () => {
        $('binLocationProductId').value = product.id;
        $('binLocationProductSearch').value = product.sku + ' · ' + product.name;
        host.hidden = true;
      };
      host.append(option);
    });
    host.hidden = !host.childNodes.length;
  }
  function renderRows(rows) {
    const body = $('binLocationRows'); body.replaceChildren();
    rows.forEach(row => {
      const tr = document.createElement('tr');
      const bin = document.createElement('td');
      if (row.bin_code) { const label = document.createElement('span'); label.className = 'bin-code'; label.textContent = row.bin_code; bin.append(label); }
      else { const label = document.createElement('span'); label.className = 'bin-not-set'; label.textContent = 'Not set'; bin.append(label); }
      tr.append(bin);
      [row.products?.sku || '—', row.products?.name || '—', row.products?.category || '—', row.quantity, row.updated_by_name || '—', row.updated_at ? new Date(row.updated_at).toLocaleString() : '—', row.note || '—'].forEach(value => {
        const td = document.createElement('td'); td.textContent = value; tr.append(td);
      });
      const actionCell = document.createElement('td'), change = document.createElement('button');
      change.type = 'button'; change.className = 'button secondary'; change.textContent = row.bin_code ? 'Change' : 'Set bin';
      change.onclick = () => openDialog(row);
      actionCell.append(change); tr.append(actionCell); body.append(tr);
    });
    if (!rows.length) body.innerHTML = '<tr><td colspan="9" class="muted">No inventory SKUs match this search.</td></tr>';
  }
  async function load() {
    const locationId = $('binLocationFilter').value;
    set('Loading bin locations…');
    const response = await fetch('/api/bin-locations?locationId=' + encodeURIComponent(locationId) + '&search=' + encodeURIComponent($('binLocationSearch').value), { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'Could not load bin locations.');
    const filter = $('binLocationFilter'), dialog = $('binLocationWarehouse');
    if (!loaded) {
      [filter, dialog].forEach(select => {
        select.replaceChildren();
        data.locations.forEach(location => { const option = document.createElement('option'); option.value = location.id; option.textContent = location.name; select.append(option); });
      });
      filter.value = data.locationId; dialog.value = data.locationId; loaded = true;
    }
    products = data.products || [];
    renderRows(data.bins || []);
    const summary = data.summary || {};
    set((summary.total || 0) + ' inventory SKUs at ' + filter.options[filter.selectedIndex]?.text + ' · ' + (summary.unassigned || 0) + ' bins not set.');
  }
  function openDialog(row) {
    $('binLocationDialog').showModal();
    $('binLocationWarehouse').value = $('binLocationFilter').value;
    $('binLocationProductId').value = row?.product_id || '';
    $('binLocationProductSearch').value = row ? ((row.products?.sku || '') + ' · ' + (row.products?.name || '')) : '';
    $('binLocationCode').value = row?.bin_code || '';
    $('binLocationNote').value = row?.note || '';
    setDialog(row ? 'Update the bin location, then save it.' : 'Choose a warehouse item and enter its bin location.');
    renderProducts();
  }
  async function save() {
    const productId = Number($('binLocationProductId').value), binCode = $('binLocationCode').value.trim();
    if (!productId || !binCode) throw Error('Choose an item and enter its bin location.');
    const response = await fetch('/api/bin-locations', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId: Number($('binLocationWarehouse').value), productId, binCode, note: $('binLocationNote').value })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'Could not save bin location.');
    $('binLocationDialog').close();
    $('binLocationFilter').value = $('binLocationWarehouse').value;
    await load();
    set('Bin location saved: ' + data.bin.bin_code + '.');
  }
  function show() {
    ['overviewView', 'atGlanceView', 'inventoryView', 'snapshotView', 'transferView', 'productionView', 'productSyncView', 'parLevelsView', 'bomManagementView', 'inventoryLedgerView', 'cycleCountReviewView', 'replenishmentView'].forEach(id => { const node = $(id); if (node) node.hidden = true; });
    view.hidden = false;
    document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.id === 'binLocationsNav'));
    load().catch(error => set(error.message, true));
  }
  $('binLocationsNav').addEventListener('click', show);
  document.querySelectorAll('.nav-item').forEach(item => { if (item.id !== 'binLocationsNav') item.addEventListener('click', () => { view.hidden = true; }); });
  $('overviewBinLocations').addEventListener('click', () => openDialog());
  $('binLocationNew').addEventListener('click', () => openDialog());
  $('binLocationRefresh').addEventListener('click', () => load().catch(error => set(error.message, true)));
  $('binLocationFilter').addEventListener('change', () => load().catch(error => set(error.message, true)));
  $('binLocationSearch').addEventListener('input', () => load().catch(error => set(error.message, true)));
  $('binLocationProductSearch').addEventListener('input', renderProducts);
  $('binLocationProductSearch').addEventListener('focus', renderProducts);
  $('binLocationWarehouse').addEventListener('change', () => {
    $('binLocationFilter').value = $('binLocationWarehouse').value;
    load().then(() => { $('binLocationWarehouse').value = $('binLocationFilter').value; renderProducts(); }).catch(error => setDialog(error.message, true));
  });
  $('binLocationSave').addEventListener('click', () => save().catch(error => setDialog(error.message, true)));
})();