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

      const unmappedBody = document.getElementById('snapshotUnmappedRows');
      unmappedBody.replaceChildren();
      (data.unmappedLocations || []).forEach(row => {
        const tr = document.createElement('tr');
        [row.shopifyStore, row.shopifyLocation, row.levels, row.nonzeroLevels, row.netOnHand, row.examples.join(', ')].forEach(value => {
          const td = document.createElement('td');
          td.textContent = value;
          tr.append(td);
        });
        unmappedBody.append(tr);
      });
      if (!unmappedBody.children.length) {
        unmappedBody.innerHTML = '<tr><td colspan="6">All Shopify locations are mapped.</td></tr>';
      }

      const negativeBody = document.getElementById('snapshotNegativeRows');
      negativeBody.replaceChildren();
      (data.negativeLocations || []).forEach(row => {
        const tr = document.createElement('tr');
        [row.warehouse, row.v2Location, row.negativeSkus, row.totalDeficit, row.worstOnHand, row.examples.join(', ')].forEach((value, index) => {
          const td = document.createElement('td');
          td.textContent = value;
          if (index === 4) td.className = 'inventory-status error';
          tr.append(td);
        });
        negativeBody.append(tr);
      });
      if (!negativeBody.children.length) {
        negativeBody.innerHTML = '<tr><td colspan="6">No negative balances in this preview.</td></tr>';
      }

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
      const unmappedImpact = data.counts.unmappedNonzeroLevels || 0;
      const mappingText = unmappedImpact
        ? ` · review ${unmappedImpact.toLocaleString()} unmapped nonzero levels before baseline approval`
        : ' · all nonzero Shopify levels are mapped';
      status.textContent = `Preview only · ${data.counts.mappedBalances.toLocaleString()} location/SKU balances · negatives retained for replenishment · zero quantities allowed${mappingText}`;
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

  document.getElementById('snapshotImport').addEventListener('click', async () => {
    if (!confirm('Import the verified Shopify opening balances into V2? Shopify and Qoblex will not change.')) return;
    const response = await fetch('/api/inventory-opening-snapshot-import', { method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify({confirmation:'IMPORT_OPENING_BALANCE'}) });
    const data = await response.json();
    if (!response.ok || !data.ok) return alert('Import failed: ' + (data.error || 'unknown error'));
    alert('Opening baseline imported: ' + data.result.imported + ' balances.');
    loadPreview();
  });

  document.getElementById('snapshotNav').addEventListener('click', show);
  document.getElementById('snapshotRefresh').addEventListener('click', loadPreview);
})();
