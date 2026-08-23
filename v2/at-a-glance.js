(() => {
  const $ = id => document.getElementById(id);
  const view = $('atGlanceView');
  if (!view) return;
  const number = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(n || 0));
  let started = false;

  function open(targetId) {
    $(targetId)?.click();
  }
  function setText(id, text) {
    const el = $(id); if (el) el.textContent = text;
  }
  function renderLocations(locations, lowItems) {
    const host = $('atGlanceLocationRows'); host.replaceChildren();
    const lowByLocation = new Map();
    lowItems.forEach(item => lowByLocation.set(item.locationId, (lowByLocation.get(item.locationId) || 0) + 1));
    locations.sort((a, b) => a.name.localeCompare(b.name)).forEach(location => {
      const low = lowByLocation.get(location.id) || 0;
      const row = document.createElement('tr');
      [location.name, number(location.purchaseOrders), number(location.transfers), number(location.inventorySkus), number(low), low ? 'Attention' : 'Good'].forEach((value, index) => {
        const td = document.createElement('td'); td.textContent = value;
        if (index === 5) td.innerHTML = '<span class="at-glance-state ' + (low ? 'attention' : 'good') + '">' + value + '</span>';
        row.append(td);
      });
      host.append(row);
    });
    if (!locations.length) host.innerHTML = '<tr><td colspan="6" class="muted">No assigned warehouses.</td></tr>';
  }
  function renderAlerts(items, cycleReviews) {
    const host = $('atGlanceAlerts'); host.replaceChildren();
    const alerts = items.slice().sort((a, b) => b.shortage - a.shortage).slice(0, 8);
    alerts.forEach(item => {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'at-glance-alert';
      row.innerHTML = '<span class="at-glance-alert-type">Low stock</span><strong></strong><span></span><em>Review →</em>';
      row.querySelector('strong').textContent = item.sku + ' is below par';
      row.querySelectorAll('span')[1].textContent = item.location + ' · ' + number(item.onHand) + ' on hand / ' + number(item.parQuantity) + ' par';
      row.onclick = () => open('replenishmentNav');
      host.append(row);
    });
    if (cycleReviews) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'at-glance-alert';
      row.innerHTML = '<span class="at-glance-alert-type review">Count review</span><strong></strong><span></span><em>Review →</em>';
      row.querySelector('strong').textContent = number(cycleReviews) + ' cycle count variance' + (cycleReviews === 1 ? '' : 's') + ' need review';
      row.querySelectorAll('span')[1].textContent = 'Inventory does not change until a manager approves the variance.';
      row.onclick = () => open('cycleCountReviewNav');
      host.append(row);
    }
    if (!alerts.length && !cycleReviews) host.innerHTML = '<p class="muted">No V2 inventory items need immediate attention.</p>';
  }
  async function load() {
    setText('atGlanceStatus', 'Loading live V2 operations…');
    try {
      const [statusResponse, replenishmentResponse] = await Promise.all([
        fetch('/api/dashboard-status', { credentials: 'same-origin', cache: 'no-store' }),
        fetch('/api/replenishment', { credentials: 'same-origin', cache: 'no-store' })
      ]);
      const status = await statusResponse.json(), replenishment = await replenishmentResponse.json();
      if (!statusResponse.ok) throw Error(status.error || 'Unable to load the operations dashboard');
      if (!replenishmentResponse.ok) throw Error(replenishment.error || 'Unable to load low stock');
      const low = replenishment.items || [];
      setText('atGlancePo', number(status.purchaseOrders));
      setText('atGlanceTransfers', number(status.transfers));
      setText('atGlanceReviews', number(status.cycleReviews));
      setText('atGlanceLow', number(low.length));
      setText('atGlanceInventory', number(status.inventorySkus));
      setText('atGlanceLedger', 'Open');
      renderAlerts(low, status.cycleReviews);
      renderLocations(status.locations || [], low);
      setText('atGlanceStatus', 'Live V2 data · updated ' + new Date(status.generatedAt || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    } catch (error) {
      setText('atGlanceStatus', error.message || 'Unable to load live operations.');
    }
  }
  function show() {
    ['overviewView', 'inventoryView', 'snapshotView', 'transferView', 'productionView', 'productSyncView', 'parLevelsView', 'bomManagementView', 'inventoryLedgerView', 'cycleCountReviewView', 'replenishmentView'].forEach(id => { const node = $(id); if (node) node.hidden = true; });
    view.hidden = false;
    document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.id === 'atGlanceNav'));
    if (!started) { started = true; load(); } else load();
  }
  $('atGlanceNav').addEventListener('click', show);
  $('atGlanceRefresh').addEventListener('click', load);
  document.querySelectorAll('[data-at-glance-target]').forEach(button => button.addEventListener('click', () => open(button.dataset.atGlanceTarget)));
  window.openAtGlance = show;
})();