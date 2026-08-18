(() => {
  const warehouses = [
    { key: 'amityville', label: 'Amityville', names: ['Bayview Warehouse', 'Amityville Main'] },
    { key: 'bohemia', label: 'Bohemia', names: ['Bohemia Warehouse', 'Bohemia Main'] },
    { key: 'outpost', label: 'Outpost', names: ['Outpost - Ronkonkoma'] },
    { key: 'riverhead', label: 'Riverhead', names: ['Riverhead Warehouse', 'Riverhead Main'] },
    { key: 'windham', label: 'Windham', names: ['730 Windham Rd'] },
    { key: 'annex', label: 'Annex', names: ['Annex (Retail) 730', 'Annex Warehouse'] }
  ];
  let rows = [];
  let loaded = false;

  function number(value) {
    return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function normalize(item) {
    const row = {
      sku: String(item.sku || '').trim(),
      name: String(item.product || ''),
      total: Number(item.totalOnHand || 0)
    };
    warehouses.forEach(warehouse => { row[warehouse.key] = 0; });
    (item.locations || []).forEach(inventory => {
      const name = String(inventory.locationName || '').trim();
      const warehouse = warehouses.find(candidate => candidate.names.includes(name));
      if (warehouse) row[warehouse.key] += Number(inventory.onHand || 0);
    });
    return row;
  }

  function render() {
    const query = document.getElementById('inventorySearch').value.trim().toLowerCase();
    const shown = rows.filter(row => `${row.sku} ${row.name}`.toLowerCase().includes(query));
    const body = document.getElementById('inventoryRows');
    body.replaceChildren();

    shown.forEach(row => {
      const tr = document.createElement('tr');
      const values = [row.sku, row.name, row.total, ...warehouses.map(warehouse => row[warehouse.key])];
      values.forEach((value, index) => {
        const td = document.createElement('td');
        td.textContent = index < 2 ? value : number(value);
        if (index === 0) td.className = 'sku';
        if (index > 1 && Number(value) === 0) td.className = 'zero';
        tr.append(td);
      });
      body.append(tr);
    });

    document.getElementById('inventoryCount').textContent =
      `Showing ${shown.length.toLocaleString()} of ${rows.length.toLocaleString()} SKUs`;
  }

  async function load() {
    const status = document.getElementById('inventoryStatus');
    const refresh = document.getElementById('inventoryRefresh');
    refresh.disabled = true;
    status.textContent = 'Loading both Shopify stores…';
    status.className = 'inventory-status';
    try {
      const response = await fetch('/api/shopify-sync-preview', {
        cache: 'no-store',
        credentials: 'same-origin'
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Shopify inventory request failed');
      if (data.writesEnabled !== false) throw new Error('Read-only safety check failed');
      rows = (data.normalized || []).map(normalize);
      loaded = true;
      render();
      status.textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString()} · Shopify read-only`;
    } catch (error) {
      status.textContent = `Could not load inventory: ${error.message}`;
      status.className = 'inventory-status error';
    } finally {
      refresh.disabled = false;
    }
  }

  function show(view) {
    const inventory = view === 'inventory';
    document.getElementById('overviewView').hidden = inventory;
    document.getElementById('inventoryView').hidden = !inventory;
    document.getElementById('overviewNav').classList.toggle('active', !inventory);
    document.getElementById('inventoryNav').classList.toggle('active', inventory);
    if (inventory && !loaded) load();
  }

  document.getElementById('overviewNav').addEventListener('click', () => show('overview'));
  document.getElementById('inventoryNav').addEventListener('click', () => show('inventory'));
  document.getElementById('inventoryRefresh').addEventListener('click', load);
  document.getElementById('inventorySearch').addEventListener('input', render);
})();
