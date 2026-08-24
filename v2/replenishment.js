(() => {
  const $ = id => document.getElementById(id), view = $('replenishmentView');
  if (!view) return;
  let all = [], recommendations = [], purchaseQueue = [], purchaseOrders = [], showAllPurchaseQueue = false, selected = null, boardData = [];
  const expandedWarehouses = new Set();
  const purchaseQueueLimit = 15, fmt = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);
  const set = (text, error = false) => { $('replenishmentStatus').textContent = text; $('replenishmentStatus').classList.toggle('error', error); };
  const poSet = (text, error = false) => { $('purchaseOrderStatus').textContent = text; $('purchaseOrderStatus').classList.toggle('error', error); };
  const transferSet = (text, error = false) => { $('lowStockDrilldownStatus').textContent = text; $('lowStockDrilldownStatus').classList.toggle('error', error); };
  const cell = (row, value) => { const td = document.createElement('td'); td.textContent = value; row.append(td); };

  function choose(locationId, category) {
    selected = { locationId: Number(locationId), category };
    const location = all.find(x => x.locationId === selected.locationId)?.location || 'Warehouse';
    $('replenishmentLocation').value = String(selected.locationId);
    $('replenishmentSearch').value = '';
    $('lowStockDrilldown').hidden = false;
    $('lowStockDrilldownTitle').textContent = location + ' · ' + category;
    $('lowStockDrilldownHelp').textContent = 'Low items in this category, with live availability at ' + (all.find(x => x.locationId === selected.locationId)?.mainWarehouseName || 'the main warehouse') + '.';
    render();
    $('lowStockDrilldown').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderBoard(board) {
    const host = $('lowStockBoard'); host.replaceChildren();
    const byLoc = new Map();
    board.filter(x => x.below > 0).forEach(x => { if (!byLoc.has(x.location)) byLoc.set(x.location, []); byLoc.get(x.location).push(x); });
    if (!byLoc.size) { host.innerHTML = '<p class="muted">Everything with a par level is currently healthy.</p>'; return; }
    [...byLoc.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([location, groups]) => {
      groups.sort((a, b) => b.below - a.below || b.deficit - a.deficit);
      const card = document.createElement('section'); card.className = 'low-stock-card alert';
      const head = document.createElement('div'); head.className = 'low-stock-card-head';
      const title = document.createElement('div'); title.innerHTML = '<span>WAREHOUSE</span><strong></strong>'; title.querySelector('strong').textContent = location;
      const total = groups.reduce((n, x) => n + x.below, 0), badge = document.createElement('span'); badge.className = 'low-stock-badge'; badge.textContent = total + ' SKUs below par';
      head.append(title, badge); card.append(head);
      const expanded = expandedWarehouses.has(location);
      const shown = expanded ? groups : groups.slice(0, 4);
      shown.forEach(x => {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'low-stock-row low-stock-category';
        const name = document.createElement('span'), status = document.createElement('strong');
        name.textContent = x.category; status.className = 'needs'; status.textContent = x.below + ' SKUs · ' + fmt(x.deficit) + ' short';
        row.append(name, status); row.onclick = () => choose(x.locationId, x.category); card.append(row);
      });
      if (groups.length > 4) {
        const more = document.createElement('button'); more.type = 'button'; more.className = 'low-stock-more';
        more.textContent = expanded ? 'Show fewer categories' : 'View all ' + groups.length + ' categories →';
        more.onclick = () => {
          if (expanded) expandedWarehouses.delete(location); else expandedWarehouses.add(location);
          renderBoard(boardData);
        };
        card.append(more);
      }
      host.append(card);
    });
  }

  function renderPurchaseOrders() {
    const host = $('purchaseOrderRows'); host.replaceChildren();
    const open = purchaseOrders.filter(order => !['received', 'cancelled'].includes(order.status));
    open.forEach(order => {
      const row = document.createElement('tr'), lines = order.purchase_order_lines || [];
      cell(row, order.purchase_order_number); cell(row, order.vendor_name || 'Unassigned'); cell(row, String(lines.length));
      cell(row, fmt(lines.reduce((sum, line) => sum + Number(line.ordered_quantity || 0), 0))); cell(row, order.status.replaceAll('_', ' '));
      const action = document.createElement('td'), receive = document.createElement('button'); receive.className = 'button secondary'; receive.type = 'button'; receive.textContent = 'Open PO';
      receive.onclick = () => $('purchaseOrdersNav')?.click(); action.append(receive); row.append(action); host.append(row);
    });
    if (!open.length) host.innerHTML = '<tr><td colspan="6" class="muted">No open purchase orders for 730.</td></tr>';
  }

  function buildPurchaseQueue() {
    const remaining = all.map(x => ({ ...x, remaining: Math.max(x.shortage - recommendations.filter(r => r.productId === x.productId && r.toLocationId === x.locationId).reduce((n, r) => n + r.quantity, 0), 0) })).filter(x => x.remaining > 0);
    const grouped = new Map();
    remaining.forEach(x => {
      if (!grouped.has(x.productId)) grouped.set(x.productId, { productId: x.productId, sku: x.sku, product: x.product, category: x.category, quantity: 0, warehouses: [] });
      const row = grouped.get(x.productId); row.quantity += x.remaining; row.warehouses.push(x.location);
    });
    purchaseQueue = [...grouped.values()].sort((a, b) => b.quantity - a.quantity);
  }

  function renderDrilldown() {
    const host = $('lowStockDrilldownRows'); host.replaceChildren();
    if (!selected) return;
    const rows = all.filter(x => x.locationId === selected.locationId && x.category === selected.category).sort((a, b) => b.shortage - a.shortage || a.sku.localeCompare(b.sku));
    const suggestionsByProduct = new Map(
      recommendations
        .filter(item => item.toLocationId === selected.locationId)
        .map(item => [item.productId, item])
    );
    let transferable = 0;
    rows.forEach(x => {
      const suggestion = suggestionsByProduct.get(x.productId);
      const row = document.createElement('tr');
      const choose = document.createElement('td');
      if (suggestion) {
        const input = document.createElement('input'); input.type = 'checkbox'; input.checked = true;
        input.dataset.categoryTransfer = String(x.productId); choose.append(input); transferable += 1;
      } else {
        choose.textContent = '—';
      }
      row.append(choose);
      [x.sku, x.product, fmt(x.onHand), fmt(x.parQuantity), fmt(x.shortage),
        suggestion ? suggestion.from : 'No source available',
        suggestion ? fmt(suggestion.availableQuantity == null ? suggestion.quantity : suggestion.availableQuantity) : '—',
        suggestion ? fmt(suggestion.quantity) : '—'
      ].forEach((value, index) => {
        const td = document.createElement('td'); td.textContent = value;
        if (index === 4) td.className = 'low-stock-shortage';
        row.append(td);
      });
      host.append(row);
    });
    if (!rows.length) host.innerHTML = '<tr><td colspan="9" class="muted">No low items in this category.</td></tr>';
    $('lowStockDrilldownCount').textContent = rows.length + ' low SKUs · ' + fmt(rows.reduce((n, x) => n + x.shortage, 0)) + ' pieces short';
    $('createCategoryTransfers').disabled = transferable === 0;
    $('createCategoryTransfers').dataset.recommendations = JSON.stringify(
      [...suggestionsByProduct.values()]
    );
    transferSet(transferable
      ? 'Select the lines to draft from the available source warehouse. Inventory will not move until the draft is allocated and shipped.'
      : 'No source warehouse has enough available inventory for this category right now.');
  }

  function render() {
    const term = $('replenishmentSearch').value.trim().toLowerCase(), locationId = $('replenishmentLocation').value;
    const filtered = all.filter(x => (!locationId || String(x.locationId) === locationId) && (!term || [x.sku, x.product, x.category, x.barcode, x.location].join(' ').toLowerCase().includes(term)));
    const rows = selected ? filtered.filter(x => x.locationId === selected.locationId && x.category === selected.category) : filtered;
    const host = $('replenishmentRows'); host.replaceChildren();
    rows.forEach(x => {
      const row = document.createElement('tr');
      [x.location, x.sku, x.product, x.category || '—', fmt(x.onHand), fmt(x.shortage), x.mainWarehouseAvailable == null ? '—' : fmt(x.mainWarehouseAvailable)].forEach((value, index) => {
        const td = document.createElement('td'); td.textContent = value; if (index === 4) td.className = 'zero'; if (index === 5) td.className = 'low-stock-shortage'; row.append(td);
      }); host.append(row);
    });
    if (!rows.length) host.innerHTML = '<tr><td colspan="7" class="muted">No shortages match those filters.</td></tr>';
    $('replenishmentCount').textContent = all.length + ' shortage SKUs';
    $('replenishmentDeficit').textContent = fmt(all.reduce((n, x) => n + x.shortage, 0)) + ' pieces short';
    $('replenishmentWarehouseCount').textContent = new Set(all.map(x => x.locationId)).size + ' warehouses need attention';
    renderDrilldown();

    buildPurchaseQueue();
    const buyHost = $('purchaseQueueRows'); buyHost.replaceChildren(); const visible = showAllPurchaseQueue ? purchaseQueue : purchaseQueue.slice(0, purchaseQueueLimit);
    visible.forEach(item => {
      const row = document.createElement('tr'), selectedInput = document.createElement('input'); selectedInput.type = 'checkbox'; selectedInput.checked = true; selectedInput.dataset.purchaseProductId = item.productId;
      const buy = document.createElement('td'); buy.append(selectedInput); row.append(buy); cell(row, item.sku); cell(row, item.product); cell(row, item.category || '—'); cell(row, [...new Set(item.warehouses)].join(', '));
      const amount = document.createElement('input'); amount.type = 'number'; amount.min = '0.01'; amount.step = '0.01'; amount.value = item.quantity; amount.className = 'inventory-search'; amount.dataset.purchaseQuantity = item.productId;
      const amountCell = document.createElement('td'); amountCell.append(amount); row.append(amountCell); buyHost.append(row);
    });
    if (!purchaseQueue.length) buyHost.innerHTML = '<tr><td colspan="6" class="muted">Internal transfer coverage resolves every current shortage.</td></tr>';
    $('purchaseQueueCount').textContent = purchaseQueue.length + ' SKUs to buy'; $('purchaseQueueQty').textContent = fmt(purchaseQueue.reduce((n, x) => n + x.quantity, 0)) + ' pieces remaining';
    const toggle = $('purchaseQueueToggle'); toggle.hidden = purchaseQueue.length <= purchaseQueueLimit; toggle.textContent = showAllPurchaseQueue ? 'Show top ' + purchaseQueueLimit : 'Show all ' + purchaseQueue.length;
    $('purchaseQueueVisible').textContent = 'Selected lines create a draft PO received into 730.';


  }

  async function loadOrders() {
    const response = await fetch('/api/purchase-orders', { credentials: 'same-origin', cache: 'no-store' }), data = await response.json();
    if (!response.ok) throw Error(data.error || 'Unable to load purchase orders');
    purchaseOrders = data.orders || []; poSet((data.hub?.name || '730') + ' is the procurement hub. Drafts are inventory-neutral.'); renderPurchaseOrders();
  }

  async function load() {
    set('Loading V2 low-stock health…');
    const response = await fetch('/api/replenishment', { credentials: 'same-origin', cache: 'no-store' }), data = await response.json();
    if (!response.ok) throw Error(data.error || 'Unable to load low stock');
    all = data.items || []; recommendations = data.recommendations || []; boardData = data.board || [];
    renderBoard(boardData);
    const select = $('replenishmentLocation'); const oldValue = select.value; select.replaceChildren();
    const option = document.createElement('option'); option.value = ''; option.textContent = 'All warehouses'; select.append(option);
    (data.locations || []).forEach(x => { const option = document.createElement('option'); option.value = x.id; option.textContent = x.name; select.append(option); });
    select.value = oldValue;
    render(); await loadOrders();
    set('High-level health board loaded. Select a category to see item detail and main-warehouse availability.');
  }

  $('createCategoryTransfers').addEventListener('click', async () => {
    try {
      const current = JSON.parse($('createCategoryTransfers').dataset.recommendations || '[]');
      const selectedIds = new Set([...document.querySelectorAll('[data-category-transfer]')].filter(input => input.checked).map(input => Number(input.dataset.categoryTransfer)));
      const lines = current.filter(item => selectedIds.has(Number(item.productId))).map(item => ({
        productId: item.productId, fromLocationId: item.fromLocationId, toLocationId: item.toLocationId, quantity: item.quantity
      }));
      if (!lines.length) throw Error('Select at least one line with an available transfer source.');
      const routes = new Set(lines.map(line => line.fromLocationId + ':' + line.toLocationId)).size;
      if (!confirm('Create ' + routes + ' draft transfer' + (routes === 1 ? '' : 's') + ' from ' + lines.length + ' selected line' + (lines.length === 1 ? '' : 's') + '? Inventory will not move or be reserved until you allocate the draft.')) return;
      $('createCategoryTransfers').disabled = true; transferSet('Creating draft transfer…');
      const response = await fetch('/api/transfers', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create_recommended_drafts', lines })
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Could not create the transfer draft.');
      const created = data.transfers || [];
      transferSet(created.length + ' draft transfer' + (created.length === 1 ? '' : 's') + ' created. Open Transfers when you are ready to allocate and ship.');
      await load();
    } catch (error) {
      transferSet(error.message, true);
    } finally {
      $('createCategoryTransfers').disabled = false;
    }
  });

  $('createPurchaseOrder').addEventListener('click', async () => {
    try {
      const lines = [...document.querySelectorAll('[data-purchase-product-id]')].filter(input => input.checked).map(input => ({ productId: Number(input.dataset.purchaseProductId), quantity: Number(document.querySelector('[data-purchase-quantity="' + input.dataset.purchaseProductId + '"]').value) }));
      if (!lines.length) throw Error('Select at least one item to buy.');
      const response = await fetch('/api/purchase-orders', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', vendorName: $('purchaseVendor').value, notes: $('purchaseNotes').value, lines, idempotencyKey: 'po-' + Date.now() }) }), data = await response.json();
      if (!response.ok) throw Error(data.error || 'Could not create purchase order');
      poSet(data.purchaseOrder.purchaseOrderNumber + ' drafted for 730. It will not change inventory until received.'); $('purchaseNotes').value = ''; await load();
    } catch (error) { poSet(error.message, true); }
  });

  $('replenishmentNav').addEventListener('click', () => {
    ['overviewView', 'inventoryView', 'snapshotView', 'transferView', 'productionView', 'productSyncView', 'parLevelsView', 'bomManagementView', 'inventoryLedgerView', 'cycleCountReviewView'].forEach(id => { const element = $(id); if (element) element.hidden = true; });
    view.hidden = false; document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.id === 'replenishmentNav')); load().catch(error => set(error.message, true));
  });
  ['overviewNav', 'inventoryNav', 'productSyncNav', 'snapshotNav', 'transfersNav', 'productionNav', 'parLevelsNav', 'bomManagementNav', 'inventoryLedgerNav', 'cycleCountReviewNav'].forEach(id => $(id)?.addEventListener('click', () => view.hidden = true));
  $('replenishmentRefresh').addEventListener('click', () => load().catch(error => set(error.message, true)));
  $('purchaseQueueToggle').addEventListener('click', () => { showAllPurchaseQueue = !showAllPurchaseQueue; render(); });
  $('replenishmentSearch').addEventListener('input', () => { selected = null; $('lowStockDrilldown').hidden = true; render(); });
  $('replenishmentLocation').addEventListener('change', () => { selected = null; $('lowStockDrilldown').hidden = true; render(); });
  $('lowStockDrilldownClose').addEventListener('click', () => { selected = null; $('lowStockDrilldown').hidden = true; $('replenishmentLocation').value = ''; render(); });
})();