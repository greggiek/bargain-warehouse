(() => {
  let locations = [];
  let selectedProduct = null;
  let searchTimer;

  function option(value, label) {
    const item = document.createElement('option');
    item.value = value;
    item.textContent = label;
    return item;
  }

  function setStatus(message, error = false) {
    const status = document.getElementById('receivingStatus');
    status.textContent = message;
    status.className = error ? 'inventory-status error' : 'inventory-status';
  }

  function renderReceipts(receipts) {
    const body = document.getElementById('receiptHistoryRows');
    body.replaceChildren();
    if (!receipts.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.textContent = 'No V2 receipts yet.';
      row.append(cell);
      body.append(row);
      return;
    }
    receipts.forEach((receipt) => {
      const row = document.createElement('tr');
      const metadata = receipt.metadata || {};
      const values = [
        receipt.document_number || '—',
        metadata.sku || '—',
        Number(metadata.quantity || 0).toLocaleString('en-US'),
        receipt.description || 'Received into V2 inventory',
        new Date(receipt.created_at).toLocaleString()
      ];
      values.forEach((value) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      });
      body.append(row);
    });
  }

  function renderSuggestions(products) {
    const box = document.getElementById('receivingSuggestions');
    box.replaceChildren();
    if (!products.length) {
      box.hidden = true;
      return;
    }
    products.forEach((product) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'product-suggestion';
      button.innerHTML = '<strong></strong><small></small>';
      button.querySelector('strong').textContent = product.sku;
      button.querySelector('small').textContent = [product.name, product.barcode ? 'Barcode: ' + product.barcode : ''].filter(Boolean).join(' · ');
      button.addEventListener('click', () => {
        selectedProduct = product;
        document.getElementById('receivingSku').value = product.sku + ' — ' + product.name;
        box.hidden = true;
      });
      box.append(button);
    });
    box.hidden = false;
  }

  async function searchProducts() {
    const input = document.getElementById('receivingSku');
    const term = input.value.trim();
    selectedProduct = null;
    if (term.length < 2) return renderSuggestions([]);
    try {
      const response = await fetch('/api/receipts?productSearch=' + encodeURIComponent(term), { credentials: 'same-origin' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Product search failed');
      renderSuggestions(data.products || []);
    } catch (error) {
      renderSuggestions([]);
      setStatus(error.message, true);
    }
  }

  async function load() {
    setStatus('Loading receiving workspace…');
    try {
      const response = await fetch('/api/receipts', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Receiving workspace failed to load');
      locations = data.locations || [];
      const select = document.getElementById('receivingLocation');
      select.replaceChildren(option('', 'Choose location'));
      locations.forEach((location) => select.append(option(location.id, location.name)));
      renderReceipts(data.receipts || []);
      setStatus('Receive stock into the V2 ledger. Shopify and Qoblex are not changed.');
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  function show() {
    document.getElementById('overviewView').hidden = true;
    document.getElementById('inventoryView').hidden = true;
    document.getElementById('productSyncView').hidden = true;
    document.getElementById('snapshotView').hidden = true;
    document.getElementById('transferView').hidden = true;
    document.getElementById('receivingView').hidden = false;
    ['overviewNav', 'inventoryNav', 'productSyncNav', 'snapshotNav', 'transfersNav'].forEach((id) => document.getElementById(id).classList.remove('active'));
    document.getElementById('receivingNav').classList.add('active');
    load();
  }

  document.getElementById('receivingNav').addEventListener('click', show);
  ['overviewNav', 'inventoryNav', 'productSyncNav', 'snapshotNav', 'transfersNav'].forEach((id) => {
    document.getElementById(id).addEventListener('click', () => { document.getElementById('receivingView').hidden = true; document.getElementById('receivingNav').classList.remove('active'); });
  });
  document.getElementById('receivingSku').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchProducts, 180);
  });
  document.getElementById('receivingSubmit').addEventListener('click', async () => {
    const locationId = Number(document.getElementById('receivingLocation').value);
    const quantity = Number(document.getElementById('receivingQty').value);
    const reference = document.getElementById('receivingReference').value.trim();
    const note = document.getElementById('receivingNote').value.trim();
    if (!selectedProduct || !locationId || !Number.isFinite(quantity) || quantity <= 0) {
      return setStatus('Choose a suggested item, a location, and a positive quantity.', true);
    }
    const location = locations.find((item) => item.id === locationId);
    if (!confirm('Receive ' + quantity + ' of ' + selectedProduct.sku + ' into ' + (location?.name || 'this location') + '?')) return;
    const button = document.getElementById('receivingSubmit');
    button.disabled = true;
    const idempotencyKey = crypto.randomUUID();
    setStatus('Posting receipt to the V2 ledger…');
    try {
      const response = await fetch('/api/receipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ productId: selectedProduct.id, locationId, quantity, reference, note, idempotencyKey })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Receiving failed');
      const receipt = data.receipt || {};
      setStatus((receipt.alreadyReceived ? 'Receipt already posted.' : 'Received ' + receipt.quantity + ' of ' + receipt.sku + '.') + ' V2 on hand: ' + Number(receipt.onHand || 0).toLocaleString('en-US'));
      document.getElementById('receivingQty').value = '';
      document.getElementById('receivingReference').value = '';
      document.getElementById('receivingNote').value = '';
      document.getElementById('receivingSku').value = '';
      selectedProduct = null;
      await load();
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
})();
