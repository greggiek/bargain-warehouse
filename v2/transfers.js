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

  const show = (message, failed = false) => { status.textContent = message; status.classList.toggle('error', failed); };
  const locationOption = (location) => {
    const option = document.createElement('option');
    option.value = location.id;
    option.textContent = location.name;
    option.disabled = !location.canManage;
    return option;
  };
  const cell = (row, value) => {
    const element = document.createElement('td');
    element.textContent = value;
    row.append(element);
  };
  const actionButton = (label, id, action) => {
    const button = document.createElement('button');
    button.className = 'button secondary';
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => runAction(id, action, button));
    return button;
  };
  function renderTransfers(transfers) {
    rows.replaceChildren();
    if (!transfers.length) {
      const row = document.createElement('tr'), empty = document.createElement('td');
      empty.colSpan = 6; empty.className = 'muted'; empty.textContent = 'No V2 transfers yet.';
      row.append(empty); rows.append(row); return;
    }
    transfers.forEach((transfer) => {
      const row = document.createElement('tr');
      const line = transfer.transfer_lines && transfer.transfer_lines[0];
      cell(row, transfer.transfer_number);
      cell(row, transfer.from_location?.name || '—');
      cell(row, transfer.to_location?.name || '—');
      cell(row, line ? line.products?.sku || '—' : '—');
      cell(row, line ? String(line.requested_quantity) : '—');
      const actionCell = document.createElement('td');
      if (transfer.status === 'allocated') actionCell.append(actionButton('Ship', transfer.id, 'ship'));
      else if (transfer.status === 'in_transit') actionCell.append(actionButton('Receive', transfer.id, 'receive'));
      else actionCell.textContent = transfer.status.replace('_', ' ');
      row.append(actionCell);
      rows.append(row);
    });
  }
  async function load() {
    show('Loading your V2 transfers…');
    const response = await fetch('/api/transfers', { credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) return show(data.error || 'Could not load transfers.', true);
    [from, to].forEach((select) => {
      select.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = ''; placeholder.textContent = 'Choose location'; select.append(placeholder);
      data.locations.forEach((location) => select.append(locationOption(location)));
    });
    renderTransfers(data.transfers || []);
    show('Create, ship, and receive transfers in the V2 ledger. Shopify and Qoblex are not changed.');
  }
  async function runAction(transferId, action, button) {
    const word = action === 'ship' ? 'ship' : 'receive';
    if (!confirm('Confirm you want to ' + word + ' this transfer in V2?')) return;
    button.disabled = true; show((action === 'ship' ? 'Shipping' : 'Receiving') + ' transfer…');
    try {
      const response = await fetch('/api/transfers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ action, transferId })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Transfer action failed.');
      show('Transfer ' + data.transfer.transferNumber + ' is now ' + data.transfer.status.replace('_', ' ') + '.');
      await load();
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
