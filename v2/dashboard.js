(() => {
  const $ = id => document.getElementById(id), number = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value || 0));
  const view = $('overviewView'); if (!view) return;
  let requestSequence = 0, controller = null; const locationKey = 'bmWarehouse.activeLocationId';
  const activeLocationId = () => localStorage.getItem(locationKey) || '';
  const setActiveLocationId = value => value ? localStorage.setItem(locationKey, value) : localStorage.removeItem(locationKey);
  function show() {
    const resetScroll = () => { window.scrollTo(0, 0); if (document.scrollingElement) document.scrollingElement.scrollTop = 0; document.querySelector('.page')?.scrollTo?.(0, 0); };
    resetScroll(); document.querySelectorAll('main > section, #atGlanceView').forEach(node => { if (node && node !== view) node.hidden = true; }); view.hidden = false; requestAnimationFrame(resetScroll); setTimeout(resetScroll, 50); document.querySelectorAll('.nav-item').forEach(node => node.classList.toggle('active', node.id === 'overviewNav')); return load();
  }
  const set = (id, value) => { const node = $(id); if (node) node.textContent = value; };
  function setLocationControl(status) {
    const control = $('dashboardLocation'), mobile = $('mobileCurrentLocation'); if (!control) return;
    const selected = String(status.location?.id || '');
    if (control.tagName === 'SELECT') { control.replaceChildren(); if (status.canViewAll) control.add(new Option('All locations', 'all')); (status.locations || []).forEach(x => control.add(new Option(x.name, String(x.id)))); control.value = selected; control.hidden = (status.locations || []).length < 2 && !status.canViewAll; }
    else control.textContent = status.location?.name || 'No warehouse assigned';
    if (mobile) mobile.textContent = status.location?.name || 'No warehouse assigned';
  }
  async function load() {
    controller?.abort('superseded'); controller = new AbortController(); const signal = controller.signal, sequence = ++requestSequence;
    try {
      const query = activeLocationId() ? '?locationId=' + encodeURIComponent(activeLocationId()) : '';
      const statusResponse = await fetch('/api/dashboard-status' + query, { credentials: 'same-origin', cache: 'no-store', signal, headers: { 'x-request-id': crypto.randomUUID() } });
      const status = await statusResponse.json();
      if (sequence !== requestSequence) return;
      if (!statusResponse.ok) throw Error(status.error || 'Could not load dashboard');
      const location = status.location || {};
      setLocationControl(status); set('dashboardSubtitle', location.name ? 'Today’s work for ' + location.name + '.' : 'No warehouse is assigned to this account.'); set('dashboardPo', number(status.purchaseOrders)); set('dashboardTransfers', number(status.transfers)); set('dashboardReviews', number(status.cycleReviews)); set('dashboardLow', number(status.lowStock));
    } catch (error) { if (error.name === 'AbortError' || sequence !== requestSequence) return; ['dashboardPo','dashboardTransfers','dashboardReviews','dashboardLow'].forEach(id => set(id, '—')); const control = $('dashboardLocation'); if (control?.tagName === 'SELECT') control.replaceChildren(new Option('Dashboard unavailable', '')); else set('dashboardLocation', 'Dashboard unavailable'); }
  }
  const quickActions = {overviewReceiveTransfer:()=>window.BMWarehouseQuickReceiveTransfer?.(),overviewWillCallScan:()=>window.BMWarehouseQuickWillCall?.(),overviewDeliveryScan:()=>window.BMWarehouseQuickDelivery?.(),overviewManufacturing:()=>document.getElementById('productionNav')?.click(),overviewDailyCycleCount:()=>window.BMWarehouseQuickDailyCount?.(),overviewCycleReview:()=>window.BMWarehouseQuickCountReview?.(),overviewInventoryAdjustment:()=>window.BMWarehouseQuickAdjustment?.(),overviewBinLocations:()=>window.BMWarehouseQuickBin?.()};
  document.addEventListener('click', event => { const button = event.target.closest?.('.dashboard-compact-actions .warehouse-action-card'); if (!button || !quickActions[button.id]) return; event.preventDefault(); event.stopImmediatePropagation(); try { Promise.resolve(quickActions[button.id]()).catch(error => { console.error(error); set('dashboardSubtitle', error.message || 'That action could not be opened. Please try again.'); }); } catch (error) { console.error(error); set('dashboardSubtitle', error.message || 'That action could not be opened. Please try again.'); } }, true);
  $('dashboardLocation')?.addEventListener('change', event => { setActiveLocationId(event.target.value); load(); });
  $('dashboardRefresh')?.addEventListener('click', load); document.querySelectorAll('[data-dashboard-target]').forEach(button => button.addEventListener('click', () => $(button.dataset.dashboardTarget)?.click())); window.enterDashboard = show; window.openAtGlance = show;
})();
