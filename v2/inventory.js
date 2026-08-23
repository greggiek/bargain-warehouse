(() => {
  const warehouses = [
    { key: 'amityville', label: 'Amityville', names: ['Amityville Main'] },
    { key: 'bohemia', label: 'Bohemia', names: ['Bohemia Main'] },
    { key: 'outpost', label: 'Outpost', names: ['Outpost - Ronkonkoma'] },
    { key: 'riverhead', label: 'Riverhead', names: ['Riverhead Main'] },
    { key: 'windham', label: 'Windham', names: ['730 Windham Rd'] },
    { key: 'annex', label: 'Annex', names: ['Annex Warehouse'] }
  ];
  let rows = [];
  let loaded = false;

  function number(value) {
    return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function normalize(balances) {
    const byProduct = new Map();
    for (const balance of balances || []) {
      const product = balance.products || {};
      const location = balance.locations || {};
      if (!product.sku || !location.name) continue;
      const key = String(balance.product_id);
      if (!byProduct.has(key)) {
        const row = { sku: String(product.sku).trim(), name: String(product.name || ''), total: 0 };
        warehouses.forEach((warehouse) => { row[warehouse.key] = 0; });
        byProduct.set(key, row);
      }
      const row = byProduct.get(key);
      const warehouse = warehouses.find((candidate) => candidate.names.includes(String(location.name).trim()));
      const quantity = Number(balance.quantity || 0);
      row.total += quantity;
      if (warehouse) row[warehouse.key] += quantity;
    }
    return Array.from(byProduct.values()).sort((a, b) => a.sku.localeCompare(b.sku));
  }

  function render() {
    const query = document.getElementById('inventorySearch').value.trim().toLowerCase();
    const shown = rows.filter((row) => `${row.sku} ${row.name}`.toLowerCase().includes(query));
    const body = document.getElementById('inventoryRows');
    body.replaceChildren();

    shown.forEach((row) => {
      const tr = document.createElement('tr');
      const values = [row.sku, row.name, row.total, ...warehouses.map((warehouse) => row[warehouse.key])];
      values.forEach((value, index) => {
        const td = document.createElement('td');
        td.textContent = index < 2 ? value : number(value);
        if (index === 0) td.className = 'sku';
        if (index > 1 && Number(value) === 0) td.className = 'zero';
        if (index > 1 && Number(value) < 0) td.className = 'error';
        tr.append(td);
      });
      body.append(tr);
    });

    document.getElementById('inventoryCount').textContent =
      `Showing ${shown.length.toLocaleString()} of ${rows.length.toLocaleString()} V2 SKUs`;
  }

  async function load() {
    const status = document.getElementById('inventoryStatus');
    const refresh = document.getElementById('inventoryRefresh');
    refresh.disabled = true;
    status.textContent = 'Loading V2 operational inventory…';
    status.className = 'inventory-status';
    try {
      const response = await fetch('/api/inventory', { cache: 'no-store', credentials: 'same-origin' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'V2 inventory request failed');
      rows = normalize(data.balances);
      loaded = true;
      render();
      status.textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString()} · V2 operational ledger`;
    } catch (error) {
      status.textContent = `Could not load V2 inventory: ${error.message}`;
      status.className = 'inventory-status error';
    } finally {
      refresh.disabled = false;
    }
  }

  function show(view) {
    const inventory = view === 'inventory';
    document.getElementById('overviewView').hidden = inventory;
    document.getElementById('inventoryView').hidden = !inventory;
    const ledger = document.getElementById('inventoryLedgerView'); if (ledger) ledger.hidden = true;
    document.getElementById('productSyncView').hidden = true;
    document.getElementById('snapshotView').hidden = true;
    document.getElementById('transferView').hidden = true;
    document.getElementById('overviewNav').classList.toggle('active', !inventory);
    document.getElementById('inventoryNav').classList.toggle('active', inventory);
    document.getElementById('productSyncNav').classList.remove('active');
    document.getElementById('snapshotNav').classList.remove('active');
    document.getElementById('transfersNav').classList.remove('active');
    document.getElementById('inventoryLedgerNav')?.classList.remove('active');
    if (inventory && !loaded) load();
  }

  document.getElementById('overviewNav').addEventListener('click', () => show('overview'));
  document.getElementById('inventoryNav').addEventListener('click', () => show('inventory'));
  document.getElementById('inventoryRefresh').addEventListener('click', load);
  document.getElementById('inventorySearch').addEventListener('input', render);
})();
