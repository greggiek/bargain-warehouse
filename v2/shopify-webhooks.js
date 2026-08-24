(() => {
  let data = null;
  const $ = id => document.getElementById(id);

  function setStatus(message, error = false) {
    const node = $('shopifyWebhookStatus');
    node.textContent = message;
    node.className = error ? 'inventory-status error' : 'inventory-status';
  }

  function option(value, label, selected) {
    const node = document.createElement('option');
    node.value = value; node.textContent = label; node.selected = String(value) === String(selected || '');
    return node;
  }

  function render() {
    const body = $('shopifyWebhookMappings');
    body.replaceChildren();
    const map = new Map((data.mappings || []).map(item => [item.store_key + ':' + item.shopify_location_id, item]));
    (data.stores || []).forEach(store => {
      if (store.error) {
        const row = document.createElement('tr');
        const cell = document.createElement('td'); cell.colSpan = 4; cell.textContent = store.label + ': ' + store.error; row.append(cell); body.append(row);
        return;
      }
      (store.locations || []).forEach(location => {
        const row = document.createElement('tr');
        const mapping = map.get(store.key + ':' + location.id);
        const select = document.createElement('select');
        select.className = 'inventory-search';
        select.append(option('', 'Not mapped', mapping?.location_id));
        (data.locations || []).forEach(warehouse => select.append(option(warehouse.id, warehouse.name, mapping?.location_id)));
        select.dataset.storeKey = store.key;
        select.dataset.shopifyLocationId = location.id;
        select.dataset.shopifyLocationName = location.name;
        [store.label, location.name].forEach(value => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); });
        const warehouseCell = document.createElement('td'); warehouseCell.append(select); row.append(warehouseCell);
        const status = document.createElement('td');
        status.textContent = mapping ? 'Mapped for Shopify operations' : 'Not mapped';
        row.append(status); body.append(row);
      });
    });

    const events = $('shopifyWebhookEvents');
    events.replaceChildren();
    (data.events || []).forEach(event => {
      const row = document.createElement('tr');
      [event.store_key === 'store_1' ? 'Shopify NY' : 'Shopify CT', event.shopify_order_number || '—', event.shopify_location_id || 'No sale location', event.status, String(event.processed_lines || 0), String(event.skipped_lines || 0), event.error || '—', event.received_at ? new Date(event.received_at).toLocaleString() : '—'].forEach(value => {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      });
      events.append(row);
    });
    if (!(data.events || []).length) events.innerHTML = '<tr><td colspan="8">No Shopify sales webhooks have been received yet.</td></tr>';
  }

  async function load() {
    setStatus('Loading Shopify locations and operation mappings…');
    const response = await fetch('/api/shopify-webhooks', { credentials: 'same-origin', cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || 'Could not load Shopify webhook setup.');
    data = result; render();
    setStatus('Map each Shopify location to its matching V2 warehouse. This enables safe transfer previews only; it does not enable sales webhooks or change inventory.');
  }

  function show() {
    document.querySelectorAll('main > section[id$="View"]').forEach(section => { section.hidden = section.id !== 'shopifyWebhookView'; });
    $('shopifyWebhookView').hidden = false;
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.id === 'shopifyWebhooksNav'));
    load().catch(error => setStatus(error.message, true));
  }

  async function saveMappings() {
    const mappings = [...document.querySelectorAll('#shopifyWebhookMappings select')].filter(select => select.value).map(select => ({
      storeKey: select.dataset.storeKey,
      shopifyLocationId: select.dataset.shopifyLocationId,
      shopifyLocationName: select.dataset.shopifyLocationName,
      locationId: Number(select.value)
    }));
    if (!mappings.length) return setStatus('Choose at least one Shopify sale location to map.', true);
    setStatus('Saving location mappings…');
    const response = await fetch('/api/shopify-webhooks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'save_mappings', mappings }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || 'Could not save mappings.');
    setStatus('Saved ' + result.saved + ' Shopify sale-location mapping(s).');
    await load();
  }

  async function testTransferSetup() {
    setStatus('Testing both Shopify connections…');
    const response = await fetch('/api/shopify-transfer-preview', { credentials: 'same-origin', cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || 'Could not test Shopify transfer setup.');
    const healthy = (result.stores || []).filter(store => store.ok).map(store => store.label);
    const failed = (result.stores || []).filter(store => !store.ok);
    setStatus(failed.length ? healthy.join(' and ') + ' connected. ' + failed.map(store => store.label + ': ' + store.error).join(' · ') : healthy.join(' and ') + ' connected. ' + (result.mappings || []).length + ' warehouse mapping(s) are ready for preview-only transfer planning.');
  }

  // Sales webhooks remain disabled while Shopify is the inventory authority.
  $('shopifyWebhookEnable').hidden = true;
  const test = document.createElement('button');
  test.type = 'button'; test.className = 'button secondary'; test.textContent = 'Test Shopify connections';
  $('shopifyWebhookRefresh').parentElement.append(test);

  $('shopifyWebhooksNav').addEventListener('click', show);
  $('shopifyWebhookRefresh').addEventListener('click', () => load().catch(error => setStatus(error.message, true)));
  $('shopifyWebhookSave').addEventListener('click', () => saveMappings().catch(error => setStatus(error.message, true)));
  test.addEventListener('click', () => testTransferSetup().catch(error => setStatus(error.message, true)));
})();
