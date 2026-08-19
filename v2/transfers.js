(() => {
  const nav = document.getElementById('transfersNav');
  const view = document.getElementById('transferView');
  if (!nav || !view) return;
  const otherViews = ['overviewView', 'inventoryView', 'productSyncView', 'snapshotView'].map((id) => document.getElementById(id));
  const otherNavs = ['overviewNav', 'inventoryNav', 'productSyncNav', 'snapshotNav'].map((id) => document.getElementById(id));
  const from = document.getElementById('transferFrom'), to = document.getElementById('transferTo');
  const sku = document.getElementById('transferSku'), quantity = document.getElementById('transferQty');
  const create = document.getElementById('transferCreate'), status = document.getElementById('transferStatus');

  const show = (message, failed = false) => { status.textContent = message; status.classList.toggle('error', failed); };
  const locationOption = (location) => {
    const option = document.createElement('option');
    option.value = location.id;
    option.textContent = location.name + (location.canManage ? '' : ' (view only)');
    option.disabled = !location.canManage;
    return option;
  };
  async function loadLocations() {
    show('Loading your V2 locations…');
    const response = await fetch('/api/transfers', { credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) return show(data.error || 'Could not load locations.', true);
    [from, to].forEach((select) => {
      select.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Choose location';
      select.append(placeholder);
      data.locations.forEach((location) => select.append(locationOption(location)));
    });
    show('Choose locations, an exact SKU, and a quantity. This allocates V2 stock only.');
  }
  nav.addEventListener('click', async () => {
    otherViews.forEach((element) => { if (element) element.hidden = true; });
    otherNavs.forEach((element) => element && element.classList.remove('active'));
    nav.classList.add('active');
    view.hidden = false;
    if (!from.options.length) await loadLocations();
  });
  create.addEventListener('click', async () => {
    if (!from.value || !to.value || !sku.value.trim() || !quantity.value) return show('Choose locations, an exact SKU, and a quantity.', true);
    if (from.value === to.value) return show('Choose two different locations.', true);
    create.disabled = true;
    show('Allocating transfer…');
    try {
      const response = await fetch('/api/transfers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ fromLocationId: from.value, toLocationId: to.value, sku: sku.value, quantity: quantity.value })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Transfer could not be allocated.');
      show('Transfer ' + data.transfer.transferNumber + ' created and allocated. It has not shipped yet.');
      sku.value = ''; quantity.value = '';
    } catch (error) { show(error.message, true); } finally { create.disabled = false; }
  });
})();
