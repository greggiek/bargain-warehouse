(() => {
  const $ = id => document.getElementById(id), view = $('forecastingView');
  if (!view) return;
  const fmt = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(n || 0));
  const set = (text, error = false) => { $('forecastStatus').textContent = text; $('forecastStatus').classList.toggle('error', error); };
  const clearMetrics = () => ['forecastSales30','forecastSales60','forecastSales90','forecastHubTarget','forecastHubAvailable','forecastBuyTotal'].forEach(id => { $(id).textContent = '—'; });
  const emptyTable = message => { $('forecastRows').innerHTML = '<tr><td colspan="10" class="muted">' + message + '</td></tr>'; };
  function cell(row, value) { const td = document.createElement('td'); td.textContent = value; row.append(td); }
  let forecastData = null;

  function render(data) {
    forecastData = data;
    $('forecastSales30').textContent = fmt(data.summary.sales30);
    $('forecastSales60').textContent = fmt(data.summary.sales60);
    $('forecastSales90').textContent = fmt(data.summary.sales90);
    $('forecastHubTarget').textContent = fmt(data.summary.hubBackstockTarget);
    $('forecastHubAvailable').textContent = fmt(data.summary.hubAvailable);
    $('forecastBuyTotal').textContent = fmt(data.summary.purchasePieces);
    const tbody = $('forecastRows'); tbody.replaceChildren();
    const sort = $('forecastSort').value;
    const items = [...(data.items || [])].sort((a, b) => sort === 'sales' ? b.sales30 - a.sales30 || b.purchaseRecommendation - a.purchaseRecommendation : b.purchaseRecommendation - a.purchaseRecommendation || b.sales30 - a.sales30);
    items.forEach(item => {
      const row = document.createElement('tr');
      [item.category || 'Uncategorized', item.sku, item.product, fmt(item.sales30), fmt(item.sales60), fmt(item.sales90), fmt(item.hubAvailable), fmt(item.retailShortage), fmt(item.hubBackstockTarget), fmt(item.purchaseRecommendation)].forEach(value => cell(row, value));
      tbody.append(row);
    });
    if (!items.length) emptyTable('No sales-backed purchase recommendations in this category yet.');
    $('forecastMeta').textContent = data.lastSyncedAt ? 'Showing ' + data.category + '. Sales mirror last refreshed ' + new Date(data.lastSyncedAt).toLocaleString() + '.' : 'Showing ' + data.category + '. No Shopify sales have been mirrored yet—use the separate 90-day sync when ready.';
    set(data.summary.purchaseSkus + ' SKUs in ' + data.category + ' need purchase coverage at 730 after retail needs and hub back stock are accounted for.');
  }

  async function loadCategories() {
    const select = $('forecastCategory');
    select.disabled = true; $('forecastRefresh').disabled = true; set('Loading product categories…');
    const response = await fetch('/api/forecast?mode=categories', { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Unable to load product categories');
    select.replaceChildren(new Option('Choose a category', ''));
    (data.categories || []).forEach(category => select.add(new Option(category, category)));
    select.disabled = false; $('forecastRefresh').disabled = false;
    clearMetrics(); forecastData = null; $('forecastMeta').textContent = 'Choose a category, then load just that category’s forecast. This does not call Shopify.';
    emptyTable('Choose a category, then select Load category forecast.'); set('Ready. Select a category to load a small, focused forecast.');
  }

  async function loadCategory() {
    const category = $('forecastCategory').value;
    if (!category) { set('Choose a category first.', true); return; }
    try {
      $('forecastRefresh').disabled = true; set('Loading ' + category + ' forecast…');
      const response = await fetch('/api/forecast?category=' + encodeURIComponent(category), { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Unable to load forecast');
      render(data);
    } catch (error) { set(error.message, true); } finally { $('forecastRefresh').disabled = false; }
  }

  async function sync(mode = 'daily') {
    const isBackfill = mode === 'next';
    try {
      $('forecastSync').disabled = true; $('forecastBackfill').disabled = true;
      set(isBackfill ? 'Backfilling one prior day of Shopify sales…' : 'Syncing yesterday’s Shopify sales…');
      const response = await fetch('/api/sales-history-sync', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ mode, days: 1 }) });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Sales sync failed');
      const windowLabel = data.startDate + ' through ' + data.endDate;
      if ($('forecastCategory').value) { set('Sales saved for ' + windowLabel + '. Loading the selected category…'); await loadCategory(); }
      else set('Sales saved for ' + windowLabel + ': ' + fmt(data.orders) + ' orders and ' + fmt(data.lines) + ' sales lines.');
    } catch (error) { set(error.message, true); } finally { $('forecastSync').disabled = false; $('forecastBackfill').disabled = false; }
  }

  $('forecastNav').addEventListener('click', () => {
    ['overviewView','inventoryView','snapshotView','transferView','receivingView','productionView','productSyncView','parLevelsView','bomManagementView','replenishmentView'].forEach(id => { const el = $(id); if (el) el.hidden = true; });
    view.hidden = false; document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.id === 'forecastNav'));
    loadCategories().catch(error => { clearMetrics(); emptyTable('Unable to load categories.'); set(error.message, true); });
  });
  ['overviewNav','inventoryNav','productSyncNav','snapshotNav','transfersNav','receivingNav','productionNav','parLevelsNav','bomManagementNav','replenishmentNav'].forEach(id => $(id)?.addEventListener('click', () => view.hidden = true));
  $('forecastRefresh').addEventListener('click', loadCategory);
  $('forecastSync').addEventListener('click', () => sync('daily'));
  $('forecastBackfill').addEventListener('click', () => sync('next'));
  $('forecastCategory').addEventListener('change', () => {
    forecastData = null; clearMetrics(); $('forecastMeta').textContent = 'Category selected. Load its forecast when you are ready.';
    emptyTable('Select Load category forecast to view this category.'); set('Ready to load ' + ($('forecastCategory').value || 'a category') + '.');
  });
  $('forecastSort').addEventListener('change', () => forecastData && render(forecastData));
})();