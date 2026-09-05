(() => {
  const $ = id => document.getElementById(id), TIMEOUT = 12000;
  const state = { locationsLoaded: false, request: null, sequence: 0, saving: false };
  const setStatus = (text, error = false) => { $('cycleCountStatus').textContent = text; $('cycleCountStatus').classList.toggle('error', error); };
  function setBusy(busy) { $('dailyCycleCountDialog').setAttribute('aria-busy', String(busy)); ['cycleCountLocation', 'cycleCountStart', 'cycleCountRetry'].forEach(id => { $(id).disabled = busy || state.saving; }); }
  function cancelActive() { state.sequence += 1; state.request?.abort(); state.request = null; }
  async function request(path, options = {}) {
    const controller = new AbortController(), external = options.signal, onAbort = () => controller.abort(external.reason), timer = setTimeout(() => controller.abort('timeout'), TIMEOUT);
    external?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(data.error || 'Daily Count request failed.');
      return data;
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason === 'timeout') { const timeout = Error('Daily Count took longer than 12 seconds.'); timeout.name = 'TimeoutError'; throw timeout; }
      throw error;
    } finally { clearTimeout(timer); external?.removeEventListener('abort', onAbort); }
  }
  function renderRows(lines) {
    const host = $('cycleCountRows'); host.replaceChildren();
    lines.forEach(line => {
      const done = line.status !== 'pending', item = document.createElement('article'); item.className = 'daily-count-line';
      const info = document.createElement('div'), sku = document.createElement('strong'), name = document.createElement('span');
      sku.textContent = line.products?.sku || '—'; name.textContent = line.products?.name || 'Unnamed item'; info.append(sku, name); item.append(info);
      if (done) { const counted = document.createElement('div'); counted.className = 'daily-count-state'; counted.textContent = 'Counted: ' + line.counted_quantity; item.append(counted); }
      else {
        const input = document.createElement('input'); input.className = 'inventory-search'; input.type = 'number'; input.min = '0'; input.step = '1'; input.inputMode = 'numeric'; input.placeholder = 'Count';
        const button = document.createElement('button'); button.className = 'button'; button.type = 'button'; button.textContent = 'Save'; button.addEventListener('click', () => save(line.id, input.value, button)); item.append(input, button);
      }
      host.append(item);
    });
  }
  function render(data) {
    const location = $('cycleCountLocation');
    if (!state.locationsLoaded) { location.replaceChildren(); data.locations.forEach(entry => { const option = document.createElement('option'); option.value = entry.id; option.textContent = entry.name; location.append(option); }); state.locationsLoaded = true; }
    if (data.run?.location_id) location.value = data.run.location_id;
    const lines = data.run?.lines || []; renderRows(lines); $('cycleCountStart').hidden = Boolean(data.run); $('cycleCountRetry').hidden = true;
    if (!data.run) return setStatus('No count has been started for ' + data.businessDate + '. Opening this dialog made no changes.');
    setStatus(lines.filter(line => line.status !== 'pending').length + ' of ' + lines.length + ' counted.');
  }
  function showError(error) { if (error?.name === 'AbortError') return; setStatus(error?.message || 'Could not load Daily Count.', true); $('cycleCountRetry').hidden = false; }
  async function load() {
    cancelActive(); const sequence = state.sequence, controller = new AbortController(); state.request = controller; setBusy(true); setStatus('Looking up today’s count…');
    try { const data = await request('/api/daily-cycle-count?locationId=' + encodeURIComponent($('cycleCountLocation').value), { signal: controller.signal }); if (sequence !== state.sequence || controller.signal.aborted) return; render(data); }
    catch (error) { if (sequence === state.sequence) showError(error); }
    finally { if (sequence === state.sequence) { state.request = null; setBusy(false); } }
  }
  async function start() {
    if (state.saving) return; state.saving = true; setBusy(true); setStatus('Starting today’s five-SKU count…');
    try { render(await request('/api/daily-cycle-count', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', locationId: Number($('cycleCountLocation').value) }) })); }
    catch (error) { showError(error); }
    finally { state.saving = false; setBusy(false); }
  }
  async function save(lineId, value, button) {
    if (state.saving) return; state.saving = true; button.disabled = true; button.textContent = 'Saving…'; setBusy(true);
    try { const data = await request('/api/daily-cycle-count', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save', locationId: Number($('cycleCountLocation').value), lineId, countedQuantity: Number(value) }) }); render(data); setStatus('Count saved.'); }
    catch (error) { showError(error); button.disabled = false; button.textContent = 'Save'; }
    finally { state.saving = false; setBusy(false); }
  }
  function open() { $('dailyCycleCountDialog').showModal(); load(); }
  function close() { cancelActive(); state.saving = false; }
  window.BMWarehouseQuickDailyCount = open;
  $('overviewDailyCycleCount').addEventListener('click', open); $('cycleCountLocation').addEventListener('change', load); $('cycleCountStart').addEventListener('click', start); $('cycleCountRetry').addEventListener('click', load); $('dailyCycleCountDialog').addEventListener('close', close); $('dailyCycleCountDialog').addEventListener('cancel', close);
})();
