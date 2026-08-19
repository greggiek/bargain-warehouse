(() => {
  let loaded = false;

  function setText(id, value) {
    document.getElementById(id).textContent = value;
  }

  async function loadPreview() {
    const status = document.getElementById('productSyncStatus');
    const button = document.getElementById('productSyncRefresh');
    button.disabled = true;
    status.textContent = 'Reading the Shopify catalog and checking V2 mirror status…';
    status.className = 'inventory-status';
    try {
      const response = await fetch('/api/product-sync-preview', {
        cache: 'no-store',
        credentials: 'same-origin'
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Preview failed');
      if (data.writesEnabled !== false || data.mode !== 'PREVIEW_ONLY') {
        throw new Error('Preview safety check failed');
      }

      setText('syncShopifyCount', data.counts.shopifySkus.toLocaleString());
      setText('syncSourceCount', data.counts.sourceVariants.toLocaleString());
      setText('syncMirrorCount', data.counts.existingProducts.toLocaleString());
      setText('syncWarningCount', data.counts.warnings.toLocaleString());

      const body = document.getElementById('productSyncRows');
      body.replaceChildren();
      data.candidates.slice(0, 250).forEach(candidate => {
        const row = document.createElement('tr');
        [candidate.action, candidate.sku, candidate.name, candidate.barcode || '—', candidate.sourceStores.join(', ')].forEach((value, index) => {
          const cell = document.createElement('td');
          cell.textContent = value;
          if (index === 1) cell.className = 'sku';
          row.append(cell);
        });
        body.append(row);
      });

      loaded = true;
      status.textContent =
        `Read-only Shopify preview · ${data.counts.sourceVariants.toLocaleString()} source variants across ${data.candidates.length.toLocaleString()} SKUs · no writes performed`;
    } catch (error) {
      status.textContent = `Could not build product preview: ${error.message}`;
      status.className = 'inventory-status error';
    } finally {
      button.disabled = false;
    }
  }

  function show() {
    document.getElementById('overviewView').hidden = true;
    document.getElementById('inventoryView').hidden = true;
    document.getElementById('productSyncView').hidden = false;
    ['overviewNav', 'inventoryNav', 'productSyncNav'].forEach(id => {
      document.getElementById(id).classList.toggle('active', id === 'productSyncNav');
    });
    if (!loaded) loadPreview();
  }

  async function syncCatalog() {
    if (!window.confirm('Sync Shopify into the V2 catalog mirror now? This only creates or refreshes V2 mirror records. It will not change Shopify, inventory, or Qoblex.')) return;
    const syncButton = document.getElementById('productSyncRun');
    const status = document.getElementById('productSyncStatus');
    syncButton.disabled = true;
    status.textContent = 'Syncing Shopify into the V2 catalog mirror…';
    status.className = 'inventory-status';
    try {
      const response = await fetch('/api/shopify-catalog-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ confirmation: 'SYNC_SHOPIFY_CATALOG' })
      });
      const responseText = await response.text();
      let data;
      try { data = JSON.parse(responseText); } catch {
        throw new Error(responseText || 'Catalog sync returned an invalid server response');
      }
      if (!response.ok || !data.ok) throw new Error(data.error || 'Shopify catalog sync failed');
      loaded = false;
      await loadPreview();
      status.textContent = `Shopify mirror synced · created ${data.synced.created.toLocaleString()} · refreshed ${data.synced.refreshed.toLocaleString()} · linked ${data.synced.sourceVariants.toLocaleString()} source variants · ${data.synced.warnings.toLocaleString()} warnings`;
    } catch (error) {
      status.textContent = `Shopify catalog sync failed: ${error.message}`;
      status.className = 'inventory-status error';
    } finally {
      syncButton.disabled = false;
    }
  }

  document.getElementById('productSyncNav').addEventListener('click', show);
  document.getElementById('productSyncRefresh').addEventListener('click', loadPreview);
  document.getElementById('productSyncRun').addEventListener('click', syncCatalog);
})();
