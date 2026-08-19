(() => {
  const nav = document.getElementById('transfersNav');
  const view = document.getElementById('transferView');
  if (!nav || !view) return;
  const otherViews = ['overviewView', 'inventoryView', 'productSyncView', 'snapshotView'].map((id) => document.getElementById(id));
  const otherNavs = ['overviewNav', 'inventoryNav', 'productSyncNav', 'snapshotNav'].map((id) => document.getElementById(id));
  const from = document.getElementById('transferFrom'), to = document.getElementById('transferTo');
  const sku = document.getElementById('transferSku'), quantity = document.getElementById('transferQty');
  const create = document.getElementById('transferCreate'), status = document.getElementById('transferStatus');
  const rows = document.getElementById('transferRows');
  const suggestions = document.getElementById('transferSuggestions');
  let searchTimer;
  let searchRequest = 0;
  const show = (message, failed = false) => { status.textContent = message; status.classList.toggle('error', failed); };
  const quantityInput = (label, max) => {
    const value = prompt(label + ' (0–' + max + ')', '0');
    if (value === null) return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > max) throw new Error('Enter a quantity between 0 and ' + max + '.');
    return number;
  };
  const locationOption = (location) => {
    const option = document.createElement('option');
    option.value = location.id; option.textContent = location.name; option.disabled = !location.canManage;
    return option;
  };
  const cell = (row, value) => { const element = document.createElement('td'); element.textContent = value; row.append(element); };
  const actionButton = (label, transfer, action) => {
    const button = document.createElement('button');
    button.className = 'button secondary'; button.type = 'button'; button.textContent = label;
    button.addEventListener('click', () => runAction(transfer, action, button));
    return button;
  };
  function renderTransfers(transfers) {
    rows.replaceChildren();
    if (!transfers.length) {
      const row = document.createElement('tr'), empty = document.createElement('td');
      empty.colSpan = 6; empty.className = 'muted'; empty.textContent = 'No V2 transfers yet.'; row.append(empty); rows.append(row); return;
    }
    transfers.forEach((transfer) => {
      const row = document.createElement('tr');
      const line = transfer.transfer_lines && transfer.transfer_lines[0];
      cell(row, transfer.transfer_number);
      cell(row, transfer.from_location?.name || '—'); cell(row, transfer.to_location?.name || '—');
      cell(row, line ? line.products?.sku || '—' : '—'); cell(row, line ? String(line.requested_quantity) : '—');
      const actionCell = document.createElement('td');
      if (transfer.status === 'allocated') actionCell.append(actionButton('Ship', transfer, 'ship'));
      else if (transfer.status === 'in_transit' || transfer.status === 'partially_received') actionCell.append(actionButton('Receive', transfer, 'receive'));
      else actionCell.textContent = transfer.status.replace('_', ' ');
      row.append(actionCell); rows.append(row);
    });
  }
  function hideSuggestions() { suggestions.replaceChildren(); suggestions.hidden = true; }
  function showSuggestions(products) {
    suggestions.replaceChildren();
    if (!products.length) return hideSuggestions();
    products.forEach((product) => {
      const button = document.createElement('button');
      button.className = 'product-suggestion'; button.type = 'button';
      const primary = document.createElement('strong');
      primary.textContent = product.sku + ' — ' + product.name;
      const detail = document.createElement('small');
      detail.textContent = [product.barcode ? 'Barcode: ' + product.barcode : '', product.category || ''].filter(Boolean).join(' · ');
      button.append(primary, detail);
      button.addEventListener('click', () => { sku.value = product.sku; hideSuggestions(); quantity.focus(); });
      suggestions.append(button);
    });
    suggestions.hidden = false;
  }
  async function searchProducts() {
    const term = sku.value.trim();
    if (term.length < 2) return hideSuggestions();
    const request = ++searchRequest;
    try {
      const response = await fetch('/api/transfers?productSearch=' + encodeURIComponent(term), { credentials: 'same-origin' });
      const data = await response.json();
      if (request !== searchRequest || !response.ok) return;
      showSuggestions(data.products || []);
    } catch { hideSuggestions(); show('Product lookup is unavailable. Please retry.', true); }
  }
  sku.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchProducts, 180);
  });
  sku.addEventListener('blur', () => setTimeout(hideSuggestions, 160));
    async function load() {
    show('Loading your V2 transfers…');
    const response = await fetch('/api/transfers', { credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) return show(data.error || 'Could not load transfers.', true);
    [from, to].forEach((select) => {
      select.replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose location'; select.append(placeholder);
      data.locations.forEach((location) => select.append(locationOption(location)));
    });
    renderTransfers(data.transfers || []);
    show('Create, ship, and receive transfers in the V2 ledger. Shopify and Qoblex are not changed.');
  }
  function receiptLines(transfer) {
    const lines = transfer.transfer_lines || [];
    if (lines.length !== 1) throw new Error('Multi-line receipts are not enabled in this screen yet.');
    const line = lines[0];
    const outstanding = Number(line.shipped_quantity) - Number(line.received_quantity) - Number(line.damaged_quantity) - Number(line.missing_quantity);
    if (outstanding <= 0) throw new Error('There is nothing left to receive.');
    const receivedQuantity = quantityInput('Quantity received for ' + (line.products?.sku || 'this SKU'), outstanding);
    if (receivedQuantity === null) return null;
    const damagedQuantity = quantityInput('Quantity damaged', outstanding - receivedQuantity);
    if (damagedQuantity === null) return null;
    const missingQuantity = quantityInput('Quantity missing', outstanding - receivedQuantity - damagedQuantity);
    if (missingQuantity === null) return null;
    if (receivedQuantity + damagedQuantity + missingQuantity === 0) throw new Error('Enter at least one quantity.');
    const note = damagedQuantity || missingQuantity ? prompt('Optional note for the discrepancy', '') : '';
    if (note === null) return null;
    return [{ lineId: line.id, receivedQuantity, damagedQuantity, missingQuantity, note }];
  }
  async function runAction(transfer, action, button) {
    const word = action === 'ship' ? 'ship' : 'record this receipt for';
    let lines;
    try { if (action === 'receive') { lines = receiptLines(transfer); if (!lines) return; } }
    catch (error) { return show(error.message, true); }
    if (!confirm('Confirm you want to ' + word + ' transfer ' + transfer.transfer_number + ' in V2?')) return;
    button.disabled = true; show((action === 'ship' ? 'Shipping' : 'Recording receipt for') + ' transfer…');
    try {
      const response = await fetch('/api/transfers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ action, transferId: transfer.id, lines })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Transfer action failed.');
      await load();
      show('Transfer ' + data.transfer.transferNumber + ' is now ' + data.transfer.status.replace('_', ' ') + '.');
    } catch (error) { show(error.message, true); } finally { button.disabled = false; }
  }
  nav.addEventListener('click', async () => {
    otherViews.forEach((element) => { if (element) element.hidden = true; });
    otherNavs.forEach((element) => element && element.classList.remove('active'));
    nav.classList.add('active'); view.hidden = false; await load();
  });
  create.addEventListener('click', async () => {
    if (!from.value || !to.value || !sku.value.trim() || !quantity.value) return show('Choose locations, an exact SKU, and a quantity.', true);
    if (from.value === to.value) return show('Choose two different locations.', true);
    create.disabled = true; show('Allocating transfer…');
    try {
      const response = await fetch('/api/transfers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ action: 'create', fromLocationId: from.value, toLocationId: to.value, sku: sku.value, quantity: quantity.value })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Transfer could not be allocated.');
      sku.value = ''; quantity.value = ''; await load();
      show('Transfer ' + data.transfer.transferNumber + ' created and allocated. Ship it when it leaves.');
    } catch (error) { show(error.message, true); } finally { create.disabled = false; }
  });
})();
