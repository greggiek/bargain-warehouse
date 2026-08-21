(() => {
  const $ = id => document.getElementById(id), view = $('forecastingView');
  if (!view) return;
  const fmt = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(n || 0));
  const set = (text, error = false) => { $('forecastStatus').textContent = text; $('forecastStatus').classList.toggle('error', error); };
  function cell(row, value) { const td = document.createElement('td'); td.textContent = value; row.append(td); }
  function render(data) {
    $('forecastSales30').textContent = fmt(data.summary.sales30);
    $('forecastSales60').textContent = fmt(data.summary.sales60);
    $('forecastSales90').textContent = fmt(data.summary.sales90);
    $('forecastHubTarget').textContent = fmt(data.summary.hubBackstockTarget);
    $('forecastHubAvailable').textContent = fmt(data.summary.hubAvailable);
    $('forecastBuyTotal').textContent = fmt(data.summary.purchasePieces);
    const tbody = $('forecastRows'); tbody.replaceChildren();
    (data.items || []).forEach(item => {
      const row = document.createElement('tr');
      [item.sku, item.product, fmt(item.sales30), fmt(item.sales60), fmt(item.sales90), fmt(item.hubAvailable), fmt(item.retailShortage), fmt(item.hubBackstockTarget), fmt(item.purchaseRecommendation)].forEach(value => cell(row, value));
      tbody.append(row);
    });
    if (!(data.items || []).length) tbody.innerHTML = '<tr><td colspan="9" class="muted">No sales-backed purchase recommendations yet.</td></tr>';
    $('forecastMeta').textContent = data.lastSyncedAt ? 'Sales mirror last refreshed ' + new Date(data.lastSyncedAt).toLocaleString() + '. Forecasts use fulfilled sales history from both Shopify stores.' : 'No sales history has been mirrored yet. Sync the last 90 days to begin.';
    set(data.summary.purchaseSkus + ' SKUs need purchase coverage at 730 after retail needs and hub back stock are accounted for.');
  }
  async function load() {
    set('Loading sales forecast…');
    const response = await fetch('/api/forecast', { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json(); if (!response.ok) throw Error(data.error || 'Unable to load forecast'); render(data);
  }
  async function sync() {
    try {
      $('forecastSync').disabled = true; set('Syncing the last 90 days of Shopify sales. This can take a minute…');
      const response = await fetch('/api/sales-history-sync', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ days: 90 }) });
      const data = await response.json(); if (!response.ok) throw Error(data.error || 'Sales sync failed');
      set('Sales mirror refreshed: ' + fmt(data.orders) + ' orders and ' + fmt(data.lines) + ' sales lines from both Shopify stores.'); await load();
    } catch (error) { set(error.message, true); } finally { $('forecastSync').disabled = false; }
  }
  $('forecastNav').addEventListener('click', () => {
    ['overviewView','inventoryView','snapshotView','transferView','receivingView','productionView','productSyncView','parLevelsView','bomManagementView','replenishmentView'].forEach(id => { const el = $(id); if (el) el.hidden = true; });
    view.hidden = false; document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.id === 'forecastNav'));
    load().catch(error => set(error.message, true));
  });
  ['overviewNav','inventoryNav','productSyncNav','snapshotNav','transfersNav','receivingNav','productionNav','parLevelsNav','bomManagementNav','replenishmentNav'].forEach(id => $(id)?.addEventListener('click', () => view.hidden = true));
  // Keep this action meaningful even before the local sales mirror has data.
  // It refreshes Shopify history first, then recalculates the forecast.
  $('forecastRefresh').addEventListener('click', sync);
  $('forecastSync').addEventListener('click', sync);
})();
