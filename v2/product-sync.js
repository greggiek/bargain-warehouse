(() => {
  let loaded = false;

  function setText(id, value) {
    document.getElementById(id).textContent = value;
  }

  async function loadPreview() {
    const status = document.getElementById('productSyncStatus');
    const button = document.getElementById('productSyncRefresh');
    button.disabled = true;
    status.textContent = 'Comparing Shopify with the V2 product table…';
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
      setText('syncInsertCount', data.counts.inserts.toLocaleString());
      setText('syncUpdateCount', data.counts.updates.toLocaleString());
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
        `Preview only · showing ${Math.min(data.candidates.length, 250).toLocaleString()} of ${data.candidates.length.toLocaleString()} candidates · no writes performed`;
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

  document.getElementById('productSyncNav').addEventListener('click', show);
  document.getElementById('productSyncRefresh').addEventListener('click', loadPreview);
})();
