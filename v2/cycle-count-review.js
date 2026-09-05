(() => {
  const $ = id => document.getElementById(id), TIMEOUT = 12000;
  const state = { ready: false, request: null, actionRequest: null, sequence: 0, action: false, retryAction: null };
  const setStatus = (text, error = false) => { const status = $('cycleReviewStatus'); if (status) { status.textContent = text; status.classList.toggle('error', error); } };
  const setTotal = total => { const value = Number(total || 0); $('cycleReviewTotal').textContent = value + ' pending variance' + (value === 1 ? '' : 's'); };
  function setBusy(busy) { const refresh = $('cycleReviewRefresh'); $('cycleCountReviewView')?.setAttribute('aria-busy', String(busy)); if (refresh) { refresh.disabled = busy || state.action; refresh.textContent = busy ? 'Loading…' : 'Refresh'; } if (busy) $('cycleReviewRows').innerHTML = '<tr><td colspan="9">Loading manager review…</td></tr>'; }
  function cancelLoad() { state.sequence += 1; state.request?.abort(); state.request = null; }
  async function request(options = {}, path = '/api/cycle-count-review') {
    const controller = new AbortController(), external = options.signal, onAbort = () => controller.abort(external.reason), timer = setTimeout(() => controller.abort('timeout'), TIMEOUT);
    external?.addEventListener('abort', onAbort, { once: true });
    try { const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal }); const data = await response.json().catch(() => ({})); if (!response.ok) throw Error(data.error || 'Cycle Count Review request failed.'); return data; }
    catch (error) { if (controller.signal.aborted && controller.signal.reason === 'timeout') { const timeout = Error('Cycle Count Review took longer than 12 seconds. Retry.'); timeout.name = 'TimeoutError'; throw timeout; } throw error; }
    finally { clearTimeout(timer); external?.removeEventListener('abort', onAbort); }
  }
  function fail(error) { if (error?.name === 'AbortError') return; setStatus(error?.message || 'Could not load Cycle Count Review.', true); const refresh = $('cycleReviewRefresh'); if (refresh) { refresh.disabled = false; refresh.textContent = 'Retry'; } }
  function row(line) {
    const tr = document.createElement('tr'), variance = Number(line.counted_quantity) - Number(line.expected_quantity);
    [line.cycle_count_runs?.locations?.name || '—', line.products?.sku || '—', line.products?.name || '—', line.expected_quantity, line.counted_quantity, (variance > 0 ? '+' : '') + variance, line.counted_by_name || '—', line.counted_at ? new Date(line.counted_at).toLocaleString() : '—'].forEach(value => { const td = document.createElement('td'); td.textContent = value; tr.append(td); });
    const actions = document.createElement('td'), approve = document.createElement('button'), recount = document.createElement('button'), dismiss = document.createElement('button'), history = document.createElement('button'), buttons = [approve, recount, dismiss, history];
    approve.className = 'button'; approve.textContent = 'Approve adjustment';
    recount.className = dismiss.className = history.className = 'button secondary';
    recount.textContent = 'Request recount'; dismiss.textContent = 'Dismiss'; history.textContent = 'History';
    approve.addEventListener('click', () => act(line.id, 'approve', buttons));
    recount.addEventListener('click', () => act(line.id, 'recount', buttons));
    dismiss.addEventListener('click', () => act(line.id, 'dismiss', buttons));
    history.addEventListener('click', () => showHistory(line.id));
    actions.append(approve, recount, dismiss, history); tr.append(actions); return tr;
  }
  async function load() {
    cancelLoad(); const sequence = state.sequence, controller = new AbortController(); state.request = controller; setBusy(true); setStatus('Loading manager review…');
    try { const data = await request({ signal: controller.signal }); if (sequence !== state.sequence || controller.signal.aborted) return; const body = $('cycleReviewRows'); body.replaceChildren(); if (!data.lines?.length) body.innerHTML = '<tr><td colspan="9">No cycle count variances are waiting for review.</td></tr>'; else data.lines.forEach(line => body.append(row(line))); setTotal(data.totalPending); setStatus('Review is current.'); }
    catch (error) { if (sequence === state.sequence) fail(error); }
    finally { if (sequence === state.sequence) { state.request = null; setBusy(false); } }
  }
  function resolutionNote(action) {
    return new Promise(resolve => {
      const dialog = $('cycleReviewActionDialog'), form = $('cycleReviewActionForm'), title = $('cycleReviewActionTitle'), help = $('cycleReviewActionHelp'), note = $('cycleReviewActionNote'), submit = $('cycleReviewActionSubmit'), cancel = $('cycleReviewActionCancel');
      title.textContent = action === 'approve' ? 'Approve inventory adjustment' : action === 'recount' ? 'Request recount' : 'Dismiss variance';
      help.textContent = action === 'approve' ? 'Confirm the physical count. A manager note is optional.' : action === 'recount' ? 'Explain why this item must be counted again.' : 'Explain why this variance should be closed without changing inventory.';
      submit.textContent = action === 'approve' ? 'Approve adjustment' : action === 'recount' ? 'Request recount' : 'Dismiss variance';
      submit.hidden = false;
      note.value = '';
      note.required = action !== 'approve';
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        form.removeEventListener('submit', onSubmit);
        cancel.removeEventListener('click', onCancel);
        dialog.removeEventListener('cancel', onCancel);
        if (dialog.open) dialog.close();
        resolve(value);
      };
      const onSubmit = event => { event.preventDefault(); finish(note.value.trim()); };
      const onCancel = event => { event.preventDefault(); finish(null); };
      form.addEventListener('submit', onSubmit);
      cancel.addEventListener('click', onCancel);
      dialog.addEventListener('cancel', onCancel);
      dialog.showModal();
      note.focus();
    });
  }
  async function act(lineId, action, buttons, replay = null) {
    if (state.action) return;
    const note = replay ? replay.note : await resolutionNote(action);
    if (note === null) return;
    if (replay && $('cycleReviewActionDialog').open) $('cycleReviewActionDialog').close();
    const idempotencyKey = replay?.idempotencyKey || 'review-' + action + '-' + lineId + '-' + crypto.randomUUID();
    state.retryAction = null;
    $('cycleReviewActionRetry').hidden = true;
    state.action = true; buttons.forEach(button => { button.disabled = true; }); $('cycleReviewRefresh').disabled = true;
    const controller = new AbortController(); state.actionRequest = controller;
    try {
      await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lineId, action, note, idempotencyKey }), signal: controller.signal });
      state.retryAction = null; await load();
      setStatus(action === 'approve' ? 'Adjustment approved and recorded in the Inventory Ledger.' : action === 'recount' ? 'Item sent back for a new blind count.' : 'Variance dismissed without changing inventory.');
    }
    catch (error) {
      if (error?.name !== 'AbortError') {
        state.retryAction = { lineId, action, note, idempotencyKey, buttons };
        $('cycleReviewActionTitle').textContent = 'Action did not complete';
        $('cycleReviewActionHelp').textContent = error?.message || 'Retry the same protected request.';
        $('cycleReviewActionSubmit').hidden = true;
        $('cycleReviewActionRetry').hidden = false;
        if (!$('cycleReviewActionDialog').open) $('cycleReviewActionDialog').showModal();
        fail(error);
      }
    }
    finally { state.actionRequest = null; state.action = false; buttons.forEach(button => { button.disabled = false; }); $('cycleReviewRefresh').disabled = false; }
  }
  async function showHistory(lineId) {
    if (state.action) return;
    const dialog = $('cycleReviewHistoryDialog'), rows = $('cycleReviewHistoryRows');
    rows.textContent = 'Loading count history…'; dialog.showModal();
    try {
      const data = await request({}, '/api/cycle-count-review?historyLineId=' + encodeURIComponent(lineId));
      rows.replaceChildren();
      if (!data.history?.length) rows.textContent = 'No recorded attempt or resolution events.';
      else data.history.forEach(event => {
        const item = document.createElement('li'), title = document.createElement('strong'), detail = document.createElement('span');
        title.textContent = event.action_type.replaceAll('_', ' ');
        const attempt = event.metadata?.attemptNumber ? ' · Attempt ' + event.metadata.attemptNumber : '';
        const count = event.metadata?.countedQuantity !== undefined ? ' · Count ' + event.metadata.countedQuantity : '';
        detail.textContent = new Date(event.created_at).toLocaleString() + ' · ' + (event.user_name || 'System') + attempt + count + (event.metadata?.reason ? ' · ' + event.metadata.reason : '');
        item.append(title, detail); rows.append(item);
      });
    } catch (error) { rows.textContent = error?.message || 'Could not load count history. Close and retry.'; }
  }
  function initialize() {
    if (state.ready) return; if (!$('cycleCountReviewNav') || !$('cycleReviewRefresh') || !$('cycleCountReviewView') || !$('cycleReviewRows') || !$('cycleReviewStatus') || !$('cycleReviewTotal')) return console.error('[cycle-count-review] required DOM is not ready');
    state.ready = true; window.BMWarehouseQuickCountReview = load; window.BMWarehouseLeaveCountReview = () => { cancelLoad(); state.actionRequest?.abort('route_change'); state.actionRequest = null; state.retryAction = null; $('cycleReviewActionRetry').hidden = true; if ($('cycleReviewActionDialog')?.open) $('cycleReviewActionDialog').close(); if ($('cycleReviewHistoryDialog')?.open) $('cycleReviewHistoryDialog').close(); }; $('overviewCycleReview')?.addEventListener('click', () => $('cycleCountReviewNav').click()); $('cycleReviewRefresh').addEventListener('click', load);
    $('cycleReviewActionRetry').addEventListener('click', () => { const retry = state.retryAction; if (retry) act(retry.lineId, retry.action, retry.buttons, retry); });
    $('cycleReviewActionCancel').addEventListener('click', () => { if (!state.retryAction) return; state.retryAction = null; $('cycleReviewActionRetry').hidden = true; if ($('cycleReviewActionDialog').open) $('cycleReviewActionDialog').close(); });
    $('cycleReviewHistoryClose').addEventListener('click', () => $('cycleReviewHistoryDialog').close());
    if (!$('cycleCountReviewView').hidden && sessionStorage.getItem('bm-active-view') === 'cycle-count-review') load();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true }); else initialize();
})();
