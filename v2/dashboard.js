(() => {
  const $ = id => document.getElementById(id);
  const number = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value || 0));
  const view = $('overviewView');
  if (!view) return;
  let started = false;
  function show() {
    const resetScroll = () => { window.scrollTo(0, 0); if (document.scrollingElement) document.scrollingElement.scrollTop = 0; document.querySelector('.page')?.scrollTo?.(0, 0); };
    resetScroll();
    document.querySelectorAll('main > section, #atGlanceView').forEach(node => { if (node && node !== view) node.hidden = true; });
    view.hidden = false;
    requestAnimationFrame(resetScroll);
    setTimeout(resetScroll, 50);
    document.querySelectorAll('.nav-item').forEach(node => node.classList.toggle('active', node.id === 'overviewNav'));
    load();
  }
  function set(id, value) { const node = $(id); if (node) node.textContent = value; }
  async function load() {
    try {
      const [statusResponse, replenishmentResponse] = await Promise.all([
        fetch('/api/dashboard-status', { credentials: 'same-origin', cache: 'no-store' }),
        fetch('/api/replenishment', { credentials: 'same-origin', cache: 'no-store' })
      ]);
      const status = await statusResponse.json(), replenishment = await replenishmentResponse.json();
      if (!statusResponse.ok) throw Error(status.error || 'Could not load dashboard');
      if (!replenishmentResponse.ok) throw Error(replenishment.error || 'Could not load low stock');
      const location = status.location || {};
      const low = (replenishment.items || []).filter(item => Number(item.locationId) === Number(location.id));
      set('dashboardLocation', location.name || 'No warehouse assigned');
      set('dashboardSubtitle', location.name ? 'Today’s work for ' + location.name + '.' : 'No warehouse is assigned to this account.');
      set('dashboardPo', number(status.purchaseOrders));
      set('dashboardTransfers', number(status.transfers));
      set('dashboardReviews', number(status.cycleReviews));
      set('dashboardLow', number(low.length));
    } catch (error) {
      ['dashboardPo','dashboardTransfers','dashboardReviews','dashboardLow'].forEach(id => set(id, '—'));
      set('dashboardLocation', 'Dashboard unavailable');
    }
  }
  $('overviewNav')?.addEventListener('click', show);
  $('dashboardRefresh')?.addEventListener('click', load);
  document.querySelectorAll('[data-dashboard-target]').forEach(button => button.addEventListener('click', () => $(button.dataset.dashboardTarget)?.click()));
  document.addEventListener('DOMContentLoaded', () => { if (!started) { started = true; load(); } });
  window.openAtGlance = show;
})();