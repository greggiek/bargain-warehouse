(() => {
  const $ = id => document.getElementById(id), TIMEOUT = 12000;
  const state = { ready: false, request: null, sequence: 0, action: false };
  const setStatus = (text, error = false) => { const status = $('cycleReviewStatus'); if (status) { status.textContent = text; status.classList.toggle('error', error); } };
  const setTotal = total => { const value = Number(total || 0); $('cycleReviewTotal').textContent = value + ' pending variance' + (value === 1 ? '' : 's'); };
  function setBusy(busy) { const refresh = $('cycleReviewRefresh'); $('cycleCountReviewView')?.setAttribute('aria-busy', String(busy)); if (refresh) { refresh.disabled = busy || state.action; refresh.textContent = busy ? 'Loading…' : 'Refresh'; } if (busy) $('cycleReviewRows').innerHTML = '<tr><td colspan="9">Loading manager review…</td></tr>'; }
  function cancelLoad() { state.sequence += 1; state.request?.abort(); state.request = null; }
  async function request(options = {}) {
    const controller = new AbortController(), external = options.signal, onAbort = () => controller.abort(external.reason), timer = setTimeout(() => controller.abort('timeout'), TIMEOUT);
    external?.addEventListener('abort', onAbort, { once: true });
    try { const response = await fetch('/api/cycle-count-review', { ...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal }); const data = await response.json().catch(() => ({})); if (!response.ok) throw Error(data.error || 'Cycle Count Review request failed.'); return data; }
    catch (error) { if (controller.signal.aborted && controller.signal.reason === 'timeout') { const timeout = Error('Cycle Count Review took longer than 12 seconds. Retry.'); timeout.name = 'TimeoutError'; throw timeout; } throw error; }
    finally { clearTimeout(timer); external?.removeEventListener('abort', onAbort); }
  }
  function fail(error) { if (error?.name === 'AbortError') return; setStatus(error?.message || 'Could not load Cycle Count Review.', true); const refresh = $('cycleReviewRefresh'); if (refresh) { refresh.disabled = false; refresh.textContent = 'Retry'; } }
  function row(line) {
    const tr = document.createElement('tr'), variance = Number(line.counted_quantity) - Number(line.expected_quantity);
    [line.cycle_count_runs?.locations?.name || '—', line.products?.sku || '—', line.products?.name || '—', line.expected_quantity, line.counted_quantity, (variance > 0 ? '+' : '') + variance, line.counted_by_name || '—', line.counted_at ? new Date(line.counted_at).toLocaleString() : '—'].forEach(value => { const td = document.createElement('td'); td.textContent = value; tr.append(td); });
    const actions = document.createElement('td'), approve = document.createElement('button'), recount = document.createElement('button'), buttons = [approve, recount]; approve.className = 'button'; approve.textContent = 'Approve adjustment'; recount.className = 'button secondary'; recount.textContent = 'Recount'; approve.addEventListener('click', () => act(line.id, 'approve', buttons)); recount.addEventListener('click', () => act(line.id, 'recount', buttons)); actions.append(approve, recount); tr.append(actions); return tr;
  }
  async function load() {
    cancelLoad(); const sequence = state.sequence, controller = new AbortController(); state.request = controller; setBusy(true); setStatus('Loading manager review…');
    try { const data = await request({ signal: controller.signal }); if (sequence !== state.sequence || controller.signal.aborted) return; const body = $('cycleReviewRows'); body.replaceChildren(); if (!data.lines?.length) body.innerHTML = '<tr><td colspan="9">No cycle count variances are waiting for review.</td></tr>'; else data.lines.forEach(line => body.append(row(line))); setTotal(data.totalPending); setStatus('Review is current.'); }
    catch (error) { if (sequence === state.sequence) fail(error); }
    finally { if (sequence === state.sequence) { state.request = null; setBusy(false); } }
  }
  async function act(lineId, action, buttons) {
    if (state.action) return; const note = action === 'approve' ? prompt('Optional manager note:') ?? null : prompt('Why should this be recounted?') ?? null; if (note === null) return;
    state.action = true; buttons.forEach(button => { button.disabled = true; }); $('cycleReviewRefresh').disabled = true;
    try { await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lineId, action, note }) }); await load(); setStatus(action === 'approve' ? 'Adjustment approved and recorded in the Inventory Ledger.' : 'Item sent back for a new blind count.'); }
    catch (error) { fail(error); }
    finally { state.action = false; buttons.forEach(button => { button.disabled = false; }); $('cycleReviewRefresh').disabled = false; }
  }
  function initialize() {
    if (state.ready) return; if (!$('cycleCountReviewNav') || !$('cycleReviewRefresh') || !$('cycleCountReviewView') || !$('cycleReviewRows') || !$('cycleReviewStatus') || !$('cycleReviewTotal')) return console.error('[cycle-count-review] required DOM is not ready');
    state.ready = true; window.BMWarehouseQuickCountReview = load; window.BMWarehouseLeaveCountReview = cancelLoad; $('overviewCycleReview')?.addEventListener('click', () => $('cycleCountReviewNav').click()); $('cycleReviewRefresh').addEventListener('click', load);
    if (!$('cycleCountReviewView').hidden && sessionStorage.getItem('bm-active-view') === 'cycle-count-review') load();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true }); else initialize();
})();
