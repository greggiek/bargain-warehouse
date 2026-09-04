(() => {
  const $ = id => document.getElementById(id);
  const view = $('inventoryView');
  if (!view) return;

  const values = globalThis.InventoryValues || {
    signedInventory: (onHand, committed, available) => ({
      onHand: Number(onHand || 0),
      committed: Number(committed || 0),
      available: available == null ? Number(onHand || 0) - Number(committed || 0) : Number(available || 0)
    })
  };
  const state = { page: 1, pageSize: 50, sequence: 0, request: null, lastData: null, sortLocationId: null, sortDirection: 'desc' };
  let locationsLoaded = false;
  let searchTimer;
  const metrics = globalThis.BMInventoryMetrics = globalThis.BMInventoryMetrics || [];
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
  const setStatus = (message, error = false) => {
    $('inventoryStatus').textContent = message;
    $('inventoryStatus').classList.toggle('error', error);
    $('inventoryRefresh').textContent = error ? 'Retry' : 'Refresh';
  };

  function setLocations(locations, selectedId) {
    const select = $('inventoryLocation');
    if (!locationsLoaded) {
      select.replaceChildren(new Option('All warehouses', ''));
      locations.forEach(location => select.add(new Option(location.name, String(location.id))));
      locationsLoaded = true;
    }
    select.value = selectedId ? String(selectedId) : '';
  }

  function setCategories(categories, locationId, selected) {
    const select = $('inventoryCategory');
    select.replaceChildren(new Option(locationId ? 'All categories' : 'Choose a warehouse first', ''));
    if (locationId) {
      categories
        .filter(category => !category.locationId || Number(category.locationId) === Number(locationId))
        .forEach(category => select.add(new Option(category.category + ' · ' + number(category.itemCount) + ' items', category.category)));
    }
    select.value = selected || '';
    select.disabled = !locationId;
  }

  function renderPagination(data) {
    $('inventoryPageSummary').textContent = 'Page ' + data.page + ' of ' + data.totalPages + ' · ' + number(data.totalResults) + ' results';
    $('inventoryPrev').disabled = data.page <= 1;
    $('inventoryNext').disabled = data.page >= data.totalPages;
    $('inventoryPageSize').value = String(data.pageSize);
  }

  function renderMatrix(rows, locations, detail) {
    const head = $('inventoryLookupHead');
    head.replaceChildren();
    const header = document.createElement('tr');
    ['Item description', 'SKU'].forEach(label => {
      const th = document.createElement('th');
      th.textContent = label;
      header.append(th);
    });
    locations.forEach(location => {
      const th = document.createElement('th');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'inventory-sort-button';
      const active = Number(state.sortLocationId) === Number(location.id);
      button.textContent = shortLocation(location.name) + (active ? (state.sortDirection === 'desc' ? ' ↓' : ' ↑') : '');
      button.title = 'Sort ' + location.name + (active && state.sortDirection === 'desc' ? ' lowest to highest' : ' highest to lowest');
      button.onclick = () => {
        if (Number(state.sortLocationId) === Number(location.id)) state.sortDirection = state.sortDirection === 'desc' ? 'asc' : 'desc';
        else {
          state.sortLocationId = location.id;
          state.sortDirection = 'desc';
        }
        state.page = 1;
        load();
      };
      th.append(button);
      header.append(th);
    });
    head.append(header);

    const body = $('inventoryRows');
    body.replaceChildren();
    rows.forEach(row => {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = row.name;
      tr.append(name);
      const sku = document.createElement('td');
      sku.textContent = row.sku;
      sku.className = 'sku';
      tr.append(sku);
      locations.forEach(location => {
        const detail = values.signedInventory(
          row.inventory?.[location.id]?.onHand ?? row.quantities?.[location.id] ?? 0,
          row.inventory?.[location.id]?.committed ?? 0,
          row.inventory?.[location.id]?.available
        );
        const td = document.createElement('td');
        td.className = 'inventory-quantity-detail';
        [['On hand', detail.onHand], ['Committed', detail.committed], ['Available', detail.available]].forEach(([label, value]) => {
          const line = document.createElement('span');
          line.className = value < 0 ? 'negative' : value === 0 ? 'zero' : '';
          const caption = document.createElement('small');
          caption.textContent = label;
          const amount = document.createElement('strong');
          amount.textContent = number(value);
          line.append(caption, amount);
          td.append(line);
        });
        tr.append(td);
      });
      body.append(tr);
    });
    if (!rows.length) body.innerHTML = '<tr><td colspan="' + (locations.length + 2) + '" class="muted">No items match this view.</td></tr>';
    $('inventoryCount').textContent = number(rows.length) + ' rows rendered' + (detail ? ' in this category' : '');
    $('inventoryDetailTitle').textContent = detail || 'All inventory';
    $('inventoryBack').hidden = !detail;
  }

  function csvCell(value) {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  }

  function exportCsv() {
    if (!state.lastData) return setStatus('Load inventory before exporting.', true);
    const locations = state.lastData.locations || [];
    const headers = ['Product', 'SKU', ...locations.flatMap(location => [
      location.name + ' On hand',
      location.name + ' Committed',
      location.name + ' Available'
    ])];
    const lines = [headers, ...(state.lastData.rows || []).map(row => [
      row.name,
      row.sku,
      ...locations.flatMap(location => {
        const detail = values.signedInventory(
          row.inventory?.[location.id]?.onHand ?? row.quantities?.[location.id] ?? 0,
          row.inventory?.[location.id]?.committed ?? 0,
          row.inventory?.[location.id]?.available
        );
        return [detail.onHand, detail.committed, detail.available];
      })
    ])].map(row => row.map(csvCell).join(','));
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
    link.download = 'bm-inventory-signed-page-' + state.page + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function cancelRequest() {
    state.sequence += 1;
    state.request?.abort();
    state.request = null;
  }

  async function load() {
    cancelRequest();
    const sequence = state.sequence;
    const controller = new AbortController();
    state.request = controller;
    const refresh = $('inventoryRefresh');
    refresh.disabled = true;
    const started = performance.now();
    const timeout = setTimeout(() => controller.abort('timeout'), 12000);
    setStatus('Loading inventory…');

    const params = new URLSearchParams({
      locationId: $('inventoryLocation').value,
      category: $('inventoryCategory').value,
      search: $('inventorySearch').value.trim(),
      page: String(state.page),
      pageSize: String(state.pageSize),
      sortLocationId: state.sortLocationId == null ? '' : String(state.sortLocationId),
      sortDirection: state.sortDirection
    });

    try {
      const response = await fetch('/api/inventory?' + params, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal
      });
      const responseText = await response.text();
      const data = JSON.parse(responseText || '{}');
      if (!response.ok || !data.ok) throw Error(data.error || 'Inventory request failed');
      if (sequence !== state.sequence || controller.signal.aborted) return;

      state.lastData = data;
      state.page = data.page;
      state.pageSize = data.pageSize;
      setLocations(data.allLocations || [], data.locationId);
      setCategories(data.categories || [], data.locationId, data.category);
      renderMatrix(data.rows || [], data.locations || [], data.category ? ((data.locations?.[0]?.name || 'Warehouse') + ' · ' + data.category) : '');
      renderPagination(data);
      metrics.push({
        requestedAt: new Date().toISOString(),
        requestNumber: metrics.length + 1,
        responseTimeMs: Math.round(performance.now() - started),
        queryTimeMs: Number(data.queryTimeMs || 0),
        payloadBytes: new Blob([responseText]).size,
        renderedRows: (data.rows || []).length
      });
      setStatus('Updated ' + new Date(data.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.');
    } catch (error) {
      if (sequence !== state.sequence) return;
      if (controller.signal.aborted) {
        if (controller.signal.reason === 'timeout') setStatus('Inventory took longer than 12 seconds. Retry.', true);
        return;
      }
      setStatus(error.message || 'Could not load inventory. Retry.', true);
    } finally {
      clearTimeout(timeout);
      if (sequence === state.sequence) {
        refresh.disabled = false;
        state.request = null;
      }
    }
  }

  function reloadFirstPage() {
    state.page = 1;
    load();
  }

  window.BMWarehouseEnterInventory = load;
  window.BMWarehouseLeaveInventory = cancelRequest;

  $('inventoryRefresh').addEventListener('click', load);
  const exportButton = document.createElement('button');
  exportButton.id = 'inventoryExport';
  exportButton.type = 'button';
  exportButton.className = 'button secondary';
  exportButton.textContent = 'Export current page';
  exportButton.addEventListener('click', exportCsv);
  $('inventoryRefresh').after(exportButton);

  $('inventoryLocation').addEventListener('change', () => {
    $('inventoryCategory').value = '';
    state.sortLocationId = null;
    reloadFirstPage();
  });
  $('inventoryCategory').addEventListener('change', reloadFirstPage);
  $('inventoryBack').addEventListener('click', () => {
    $('inventoryCategory').value = '';
    reloadFirstPage();
  });
  $('inventorySearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(reloadFirstPage, 220);
  });
  $('inventoryPrev').addEventListener('click', () => {
    if (state.page > 1) {
      state.page -= 1;
      load();
    }
  });
  $('inventoryNext').addEventListener('click', () => {
    if (state.lastData && state.page < state.lastData.totalPages) {
      state.page += 1;
      load();
    }
  });
  $('inventoryPageSize').addEventListener('change', () => {
    state.pageSize = Math.min(100, Math.max(1, Number($('inventoryPageSize').value) || 50));
    reloadFirstPage();
  });
})();
