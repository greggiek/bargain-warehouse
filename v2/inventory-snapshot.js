(() => {
  let loaded = false;

  function text(id, value) {
    document.getElementById(id).textContent = value;
  }

  async function loadPreview() {
    const status = document.getElementById('snapshotStatus');
    const button = document.getElementById('snapshotRefresh');
    button.disabled = true;
    status.textContent = 'Reading Shopify inventory for the opening snapshot…';
    status.className = 'inventory-status';
    try {
      const response = await fetch('/api/inventory-opening-snapshot-preview', {
        cache: 'no-store',
        credentials: 'same-origin'
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Snapshot preview failed');
      if (data.writesEnabled !== false || data.mode !== 'OPENING_SNAPSHOT_PREVIEW') {
        throw new Error('Snapshot preview safety check failed');
      }

      text('snapshotLevelCount', data.counts.sourceLevels.toLocaleString());
      text('snapshotBalanceCount', data.counts.mappedBalances.toLocaleString());
      text('snapshotUnmappedCount', data.counts.unmappedLevels.toLocaleString());
      text('snapshotNegativeCount', data.counts.negativeBalances.toLocaleString());

      const body = document.getElementById('snapshotRows');
      body.replaceChildren();
      data.rows.forEach(row => {
        const tr = document.createElement('tr');
        [row.warehouse, row.v2Location, row.sku, row.product, row.onHand, row.sourceStores.join(', ')].forEach((value, index) => {
          const td = document.createElement('td');
          td.textContent = value;
          if (index === 2) td.className = 'sku';
          if (index === 4 && Number(value) < 0) td.className = 'inventory-status error';
          tr.append(td);
        });
        body.append(tr);
      });

      loaded = true;
      const issueText = data.counts.negativeBalances || data.counts.unmappedLevels
        ? ` · review ${data.counts.negativeBalances} negative and ${data.counts.unmappedLevels} unmapped rows before baseline approval`
        : ' · ready for baseline approval';
      status.textContent = `Preview only · ${data.counts.mappedBalances.toLocaleString()} location/SKU balances · no V2 inventory written${issueText}`;
    } catch (error) {
      status.textContent = `Could not build opening snapshot preview: ${error.message}`;
      status.className = 'inventory-status error';
    } finally {
      button.disabled = false;
    }
  }

  function show() {
    ['overviewView', 'inventoryView', 'productSyncView'].forEach(id => document.getElementById(id).hidden = true);
    document.getElementById('snapshotView').hidden = false;
    ['overviewNav', 'inventoryNav', 'productSyncNav', 'snapshotNav'].forEach(id => {
      document.getElementById(id).classList.toggle('active', id === 'snapshotNav');
    });
    if (!loaded) loadPreview();
  }

  document.getElementById('snapshotNav').addEventListener('click', show);
  document.getElementById('snapshotRefresh').addEventListener('click', loadPreview);
})();
