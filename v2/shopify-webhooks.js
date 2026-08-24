(() => {
  let data = null;
  const $ = id => document.getElementById(id);
  const callbackUrl = () => location.origin + '/api/webhooks/shopify-order-paid';

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
        const subscription = (store.subscriptions || []).some(item => item.endpoint?.callbackUrl === callbackUrl());
        status.textContent = subscription ? 'Paid-order webhook active' : 'Not enabled';
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
    setStatus('Loading Shopify locations and webhook status…');
    const response = await fetch('/api/shopify-webhooks', { credentials: 'same-origin', cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || 'Could not load Shopify webhook setup.');
    data = result; render();
    setStatus('Map each Shopify sale location to its matching V2 warehouse, then enable the paid-order webhook.');
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

  async function enable() {
    if (!confirm('Enable paid-order webhooks for both Shopify stores? A mapped paid sale will deduct V2 inventory immediately and create an Inventory Ledger entry.')) return;
    setStatus('Registering paid-order webhooks with Shopify…');
    const response = await fetch('/api/shopify-webhooks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'enable_paid_orders', callbackUrl: callbackUrl() }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || 'Could not enable webhooks.');
    const problems = (result.outcomes || []).filter(item => item.status === 'error');
    setStatus(problems.length ? problems.map(item => item.store + ': ' + item.error).join(' · ') : 'Paid-order webhooks are enabled. The next mapped Shopify sale will deduct from V2 inventory.');
    await load();
  }

  $('shopifyWebhooksNav').addEventListener('click', show);
  $('shopifyWebhookRefresh').addEventListener('click', () => load().catch(error => setStatus(error.message, true)));
  $('shopifyWebhookSave').addEventListener('click', () => saveMappings().catch(error => setStatus(error.message, true)));
  $('shopifyWebhookEnable').addEventListener('click', () => enable().catch(error => setStatus(error.message, true)));
})();