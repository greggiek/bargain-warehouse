(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const view = $('forecastingView');
  if (!view || view.dataset.forecastInitialized === 'true') return;
  view.dataset.forecastInitialized = 'true';

  const defaults = { history: '90', growth: '10', coverage: '90', safety: '14', category: '', search: '', sort: 'suggested_desc', pageSize: '25' };
  const whole = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value || 0));
  const rate = value => new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value || 0));
  const exact = value => new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 6 }).format(Number(value || 0));
  const dateLabel = value => value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(value + 'T00:00:00Z')) : 'Unavailable';
  const timeLabel = value => value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value)) : 'Unavailable';

  let state = { data: null, page: 1, controller: null, searchTimer: null, requestSeq: 0 };

  function params(page = state.page) {
    return new URLSearchParams({
      historyDays: $('forecastHistory').value,
      growth: $('forecastGrowth').value,
      coverageDays: $('forecastCoverage').value,
      safetyStockDays: $('forecastSafety').value,
      category: $('forecastCategory').value,
      search: $('forecastSearch').value.trim(),
      sort: $('forecastSort').value,
      page: String(page),
      pageSize: $('forecastPageSize').value
    });
  }

  function setLoading(loading) {
    const button = $('forecastRecalculate');
    button.disabled = loading;
    button.textContent = loading ? 'Calculating…' : 'Apply forecast';
  }

  function setStatus(kind, headline, detail, actionLabel = 'View data status', action = toggleDataStatus) {
    const strip = $('forecastDataStatus');
    const icon = strip.querySelector('.forecast-ready-icon');
    const strong = strip.querySelector('.forecast-status-copy strong');
    const copy = strip.querySelector('.forecast-status-copy div span');
    const button = $('forecastStatusToggle');
    icon.textContent = kind === 'error' ? '!' : kind === 'loading' ? '…' : '✓';
    icon.style.background = kind === 'error' ? '#b42318' : kind === 'loading' ? '#60718a' : '#2f9f68';
    strong.textContent = headline;
    strong.style.color = kind === 'error' ? '#b42318' : kind === 'loading' ? '#526a87' : '#23794d';
    copy.textContent = detail;
    button.textContent = actionLabel;
    button.onclick = action;
  }

  function toggleDataStatus() {
    const panel = $('forecastDataDetails');
    const opening = panel.hidden;
    panel.hidden = !opening;
    $('forecastStatusToggle').textContent = opening ? 'Hide data status' : 'View data status';
    $('forecastStatusToggle').setAttribute('aria-expanded', String(opening));
  }

  function addNotice(text) {
    const p = document.createElement('p');
    p.textContent = text;
    $('forecastDataDetails').append(p);
  }

  function renderFreshness(data) {
    const ui = data.uiStatus || {};
    $('forecastFreshDate').textContent = ui.dataCurrentThrough
      ? 'Data current through ' + dateLabel(ui.dataCurrentThrough)
      : 'Data freshness unavailable';
    $('forecastCoverageStatus').textContent = (ui.cacheCoverageDays ?? '—') + '/' + (ui.cacheCoverageTarget || 120) + ' days synchronized';

    const details = $('forecastDataDetails');
    details.replaceChildren();
    addNotice('Returns are not currently deducted from forecast demand.');
    addNotice('Historical-only products are excluded from current SKU recommendations.');
    addNotice('Custom and non-catalog products are excluded from stocked replenishment.');
    addNotice((data.status?.manualExclusions || 0) + ' valid Shopify products are manually excluded from stocked replenishment.');
    addNotice('Supplier ordering multiples are not configured; suggested requirements are raw pieces.');
    (ui.storeSync || []).forEach(store => addNotice(store.label + ' last synchronized ' + timeLabel(store.lastSynchronizedAt) + '.'));
  }

  function signedDisplay(value) {
    const number = Number(value || 0);
    if (number > 0) return { text: whole(number) + ' shortage', className: 'forecast-shortage' };
    if (number < 0) return { text: '−' + whole(Math.abs(number)) + ' surplus', className: 'forecast-surplus' };
    return { text: '0', className: 'forecast-neutral' };
  }

  function cell(row, text, className = '', label = '') {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    if (label) td.dataset.label = label;
    row.append(td);
    return td;
  }

  function productCell(row, item) {
    const td = document.createElement('td');
    td.className = 'forecast-product-cell';
    td.dataset.label = 'Product';
    const sku = document.createElement('span');
    sku.className = 'forecast-product-sku';
    sku.textContent = item.sku;
    const name = document.createElement('span');
    name.className = 'forecast-product-name';
    name.textContent = item.product;
    td.append(sku, name);
    if (item.bulkOrderInfluenced) {
      const badge = document.createElement('span');
      badge.className = 'forecast-bulk-badge';
      badge.textContent = 'Bulk-order influenced';
      td.append(badge);
    }
    row.append(td);
  }

  function detailList(entries) {
    const dl = document.createElement('dl');
    dl.className = 'forecast-detail-list';
    entries.forEach(([label, value]) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value;
      dl.append(dt, dd);
    });
    return dl;
  }

  function detailGroup(title, entries) {
    const group = document.createElement('section');
    group.className = 'forecast-detail-group';
    const heading = document.createElement('h3');
    heading.textContent = title;
    group.append(heading, detailList(entries));
    return group;
  }

  function renderDetail(cellElement, item) {
    const data = item;
    const bulk = data.bulk || {};
    const growth = Number($('forecastGrowth').value || 0);
    const coverage = Number($('forecastCoverage').value || 0);
    const safety = Number($('forecastSafety').value || 0);
    const signed = signedDisplay(data.projectedShortageSurplus);
    const panel = document.createElement('div');
    panel.className = 'forecast-detail-panel';

    panel.append(detailGroup('Forecast calculation', [
      ['History days', whole(data.completedHistoryDays)],
      ['Gross fulfilled units', exact(data.grossUnitsSold)],
      ['Average daily demand', exact(data.averageDailyDemand)],
      ['Growth percentage', rate(growth) + '%'],
      ['Growth-adjusted daily demand', exact(data.growthAdjustedDailyDemand)],
      ['Coverage days', whole(coverage)],
      ['Safety-stock days', whole(safety)],
      ['Target calculation', exact(data.growthAdjustedDailyDemand) + ' × ' + whole(coverage + safety) + ' days = ' + exact(data.target730)],
      ['Available at 730', exact(data.usable730)],
      ['Incoming PO quantity', exact(data.validInboundPoQuantity)],
      ['Shortage / surplus', signed.text],
      ['Suggested requirement', whole(data.suggestedRequirement)]
    ]));

    panel.append(detailGroup('Bulk-order analysis', [
      ['Orders', whole(bulk.orders)],
      ['Average units per order', rate(bulk.averageUnitsPerOrder)],
      ['Largest order', whole(bulk.largestOrder)],
      ['Five-largest-order units', whole(bulk.fiveLargestOrderUnits)],
      ['Top-five share', rate(Number(bulk.topFiveShare || 0) * 100) + '%'],
      ['Median line quantity', rate(bulk.medianLineQuantity)],
      ['Unusually large lines', whole(bulk.unusuallyLargeLines)],
      ['Units from unusually large lines', whole(bulk.unitsFromUnusuallyLargeLines)]
    ]));

    const purchasing = document.createElement('section');
    purchasing.className = 'forecast-detail-group';
    const heading = document.createElement('h3');
    heading.textContent = 'Purchasing configuration';
    const note = document.createElement('p');
    note.className = 'forecast-detail-note';
    note.textContent = data.supplierOrderingMultiple
      ? 'Supplier ordering multiple: ' + data.supplierOrderingMultiple
      : 'Supplier ordering multiple not configured.';
    purchasing.append(heading, note);
    panel.append(purchasing);
    cellElement.replaceChildren(panel);
  }

  async function expandRow(row, button, item) {
    const existing = row.nextElementSibling;
    if (existing?.classList.contains('forecast-detail')) {
      existing.remove();
      button.setAttribute('aria-expanded', 'false');
      return;
    }

    button.setAttribute('aria-expanded', 'true');
    const detail = document.createElement('tr');
    detail.className = 'forecast-detail';
    const detailCell = document.createElement('td');
    detailCell.colSpan = 9;
    const loading = document.createElement('div');
    loading.className = 'forecast-loading-detail';
    loading.textContent = 'Loading calculation details…';
    detailCell.append(loading);
    detail.append(detailCell);
    row.after(detail);

    try {
      const response = await fetch('/api/forecast?detailSku=' + encodeURIComponent(item.sku) + '&' + params(1), {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.timeout(15000)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Detail failed');
      renderDetail(detailCell, data.item);
    } catch (error) {
      detailCell.replaceChildren();
      const message = document.createElement('div');
      message.className = 'forecast-loading-detail';
      message.textContent = error.name === 'TimeoutError' ? 'Detail request timed out. Collapse and retry.' : error.message;
      detailCell.append(message);
    }
  }

  function renderRows(items) {
    const body = $('forecastRows');
    const fragment = document.createDocumentFragment();
    body.replaceChildren();

    items.forEach(item => {
      const row = document.createElement('tr');
      row.className = 'forecast-main';
      productCell(row, item);
      cell(row, whole(item.grossUnitsSold), 'numeric', 'Gross sold');
      cell(row, rate(item.averageDailyDemand), 'numeric', 'Average/day');
      cell(row, whole(item.target730), 'numeric', 'Target at 730');
      cell(row, whole(item.usable730), 'numeric', 'Available at 730');
      cell(row, whole(item.validInboundPoQuantity), 'numeric', 'Incoming');
      const signed = signedDisplay(item.projectedShortageSurplus);
      cell(row, signed.text, 'numeric ' + signed.className, 'Shortage/surplus');
      const requirement = Number(item.suggestedRequirement || 0);
      cell(row, whole(requirement), 'numeric forecast-requirement ' + (requirement > 0 ? 'positive' : 'zero'), 'Suggested requirement');
      const actionCell = document.createElement('td');
      actionCell.dataset.label = 'Details';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'forecast-expand';
      button.textContent = '⌄';
      button.setAttribute('aria-label', 'Expand calculation details for ' + item.sku);
      button.setAttribute('aria-expanded', 'false');
      button.addEventListener('click', event => {
        event.stopPropagation();
        expandRow(row, button, item);
      });
      actionCell.append(button);
      row.append(actionCell);
      fragment.append(row);
    });

    if (!items.length) {
      const row = document.createElement('tr');
      const empty = cell(row, 'No eligible products match these filters.');
      empty.colSpan = 9;
      fragment.append(row);
    }
    body.append(fragment);
  }

  function renderPager(pagination) {
    const page = Number(pagination.page || 1);
    const totalPages = Math.max(1, Number(pagination.totalPages || 1));
    const pageSize = Number(pagination.pageSize || $('forecastPageSize').value);
    const total = Number(pagination.total || 0);
    const start = total ? (page - 1) * pageSize + 1 : 0;
    const end = Math.min(page * pageSize, total);
    $('forecastResultCount').textContent = 'Showing ' + start + '–' + end + ' of ' + whole(total) + ' products';

    const pager = $('forecastPager');
    pager.replaceChildren();
    const copy = document.createElement('span');
    copy.className = 'forecast-pager-copy';
    copy.textContent = 'Showing ' + start + '–' + end + ' of ' + whole(total) + ' products';
    const controls = document.createElement('div');
    controls.className = 'forecast-page-buttons';

    const makeButton = (label, target, disabled = false, current = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.disabled = disabled;
      if (current) {
        button.className = 'current';
        button.setAttribute('aria-current', 'page');
      } else {
        button.addEventListener('click', () => load(target));
      }
      return button;
    };

    controls.append(makeButton('Previous', page - 1, page <= 1));
    const first = Math.max(1, Math.min(page - 2, totalPages - 4));
    const last = Math.min(totalPages, first + 4);
    for (let number = first; number <= last; number += 1) {
      controls.append(makeButton(String(number), number, false, number === page));
    }
    controls.append(makeButton('Next', page + 1, page >= totalPages));
    pager.append(copy, controls);
  }

  function render(data) {
    const renderStarted = performance.now();
    state.data = data;
    const summary = data.summary || {};
    const status = data.status || {};
    const pagination = data.pagination || {};
    const items = data.items || [];

    $('forecastGross').textContent = whole(summary.grossUnits);
    $('forecastTarget').textContent = whole(summary.target);
    $('forecastUsable').textContent = whole(summary.usable730);
    $('forecastInbound').textContent = whole(summary.validInbound);
    const suggested = status.recommendationsEnabled ? Number(summary.suggestedRequirement || 0) : null;
    $('forecastSuggested').textContent = suggested === null ? 'Disabled' : whole(suggested);
    $('forecastRequirementCard').classList.toggle('positive', suggested > 0);
    $('forecastRequirementCard').classList.toggle('zero', suggested === 0);

    const productCount = Number(pagination.total || 0);
    setStatus(
      'ready',
      status.recommendationsEnabled ? 'Forecast ready' : 'Recommendations disabled',
      whole(status.completedHistoryDays) + ' synchronized days • ' + whole(productCount) + ' products shown • ' + whole(status.manualExclusions) + ' manually excluded'
    );
    renderFreshness(data);
    renderRows(items);
    renderPager(pagination);

    const category = $('forecastCategory');
    if (category.options.length === 1) (data.categories || []).forEach(value => category.add(new Option(value, value)));
    view.dataset.lastRenderMs = (performance.now() - renderStarted).toFixed(1);
  }

  async function load(page = 1) {
    const requestStarted = performance.now();
    const seq = ++state.requestSeq;
    view.dataset.requestCount = String(Number(view.dataset.requestCount || 0) + 1);
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    state.page = page;
    setLoading(true);
    setStatus('loading', 'Calculating forecast', 'Reading the bounded local Forecasting cache…');
    const timeout = setTimeout(() => controller.abort('timeout'), 15000);

    try {
      const response = await fetch('/api/forecast?' + params(page), {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal
      });
      const data = await response.json();
      if (seq !== state.requestSeq) return;
      if (!response.ok) throw Object.assign(new Error(data.error || 'Forecast failed'), { requestId: data.requestId });
      view.dataset.lastApiMs = (performance.now() - requestStarted).toFixed(1);
      view.dataset.lastDbMs = response.headers.get('X-Forecast-Db-Ms') || String(data.metrics?.dbMs || '');
      view.dataset.lastPayloadBytes = response.headers.get('X-Forecast-Bytes') || String(data.metrics?.payloadBytes || '');
      view.dataset.lastRequestId = response.headers.get('X-Request-Id') || data.requestId || '';
      render(data);
      console.info('[forecast request]', {
        requestId: view.dataset.lastRequestId,
        apiMs: Number(view.dataset.lastApiMs),
        dbMs: Number(view.dataset.lastDbMs),
        payloadBytes: Number(view.dataset.lastPayloadBytes),
        rows: (data.items || []).length,
        renderMs: Number(view.dataset.lastRenderMs)
      });
    } catch (error) {
      if (seq !== state.requestSeq) return;
      const timedOut = error.name === 'AbortError' || error.name === 'TimeoutError';
      const message = timedOut ? 'Forecast request timed out. Navigation remains available.' : error.message;
      setStatus('error', 'Forecast could not load', message + (error.requestId ? ' Request ' + error.requestId + '.' : ''), 'Retry', () => load(state.page));
    } finally {
      clearTimeout(timeout);
      if (seq === state.requestSeq) {
        setLoading(false);
        state.controller = null;
      }
    }
  }

  function show() {
    const clickStarted = performance.now();
    ['overviewView','inventoryView','snapshotView','transferView','productionView','productSyncView','parLevelsView','bomManagementView','inventoryLedgerView','cycleCountReviewView','replenishmentView','binLocationsView','purchaseOrdersView','poArrivalsView','vendorDirectoryView','shopifyWebhookView','skuFixView'].forEach(id => {
      const element = $(id);
      if (element) element.hidden = true;
    });
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.id === 'forecastNav'));
    $('appView')?.classList.add('forecast-active');
    view.hidden = false;
    setStatus('loading', 'Forecast ready to load', 'Preparing the purchasing worksheet…');
    requestAnimationFrame(() => {
      view.dataset.lastViewSwitchMs = (performance.now() - clickStarted).toFixed(1);
      setTimeout(() => load(1), 0);
    });
  }

  function resetDefaults() {
    $('forecastHistory').value = defaults.history;
    $('forecastGrowth').value = defaults.growth;
    $('forecastCoverage').value = defaults.coverage;
    $('forecastSafety').value = defaults.safety;
    $('forecastCategory').value = defaults.category;
    $('forecastSearch').value = defaults.search;
    $('forecastSort').value = defaults.sort;
    $('forecastPageSize').value = defaults.pageSize;
    load(1);
  }

  function exportCsv() {
    if (!state.data) return;
    const headers = ['SKU', 'Product', 'Gross units sold', 'Completed history days', 'Average daily demand', 'Growth-adjusted daily demand', 'Target at 730', 'Available inventory at 730', 'Valid inbound PO quantity', 'Projected shortage or surplus', 'Suggested requirement', 'Confidence'];
    const rows = state.data.items.map(item => [
      item.sku, item.product, item.grossUnitsSold, item.completedHistoryDays, item.averageDailyDemand,
      item.growthAdjustedDailyDemand, item.target730, item.usable730, item.validInboundPoQuantity,
      item.projectedShortageSurplus, item.suggestedRequirement, item.confidence
    ]);
    const output = [headers, ...rows].map(row => row.map(value => '"' + String(value ?? '').replaceAll('"', '""') + '"').join(',')).join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([output], { type: 'text/csv' }));
    link.download = 'forecast-page-' + state.page + '.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  }

  $('forecastNav')?.addEventListener('click', show, { passive: true });
  $('forecastRecalculate').addEventListener('click', () => load(1));
  $('forecastExport').addEventListener('click', exportCsv);
  $('forecastReset').addEventListener('click', resetDefaults);
  $('forecastSearch').addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => load(1), 300);
  });
  $('forecastCategory').addEventListener('change', () => load(1));
  $('forecastSort').addEventListener('change', () => load(1));
  $('forecastPageSize').addEventListener('change', () => load(1));
  $('forecastStatusToggle').addEventListener('click', toggleDataStatus);

  document.querySelectorAll('.nav-item').forEach(element => {
    if (element.id !== 'forecastNav') {
      element.addEventListener('click', () => {
        state.controller?.abort('navigation');
        $('appView')?.classList.remove('forecast-active');
      }, { passive: true });
    }
  });
})();
