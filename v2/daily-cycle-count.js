(() => {
  const $ = id => document.getElementById(id), TIMEOUT = 12000;
  const state = { locationsLoaded: false, request: null, sequence: 0, saving: false, run: null, drafts: new Map() };
  const setStatus = (text, error = false) => { $('cycleCountStatus').textContent = text; $('cycleCountStatus').classList.toggle('error', error); };
  const dirtyCount = () => [...state.drafts.values()].filter(draft => draft.dirty).length;
  function setView(name) {
    ['Loading', 'NoRun', 'Empty', 'Rows', 'Error', 'Complete'].forEach(view => {
      const element = $('cycleCount' + view);
      if (element) element.hidden = view.toLowerCase() !== name;
    });
  }
  function setBusy(busy) {
    $('dailyCycleCountDialog').setAttribute('aria-busy', String(busy));
    ['cycleCountLocation', 'cycleCountStart', 'cycleCountRetry', 'cycleCountSave'].forEach(id => {
      const element = $(id);
      if (element) element.disabled = busy || state.saving;
    });
  }
  function cancelActive(reason = 'cancelled') {
    state.sequence += 1;
    state.request?.abort(reason);
    state.request = null;
  }
  async function request(path, options = {}) {
    const controller = new AbortController(), external = options.signal;
    const onAbort = () => controller.abort(external.reason || 'cancelled');
    const timer = setTimeout(() => controller.abort('timeout'), TIMEOUT);
    external?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(data.error || 'Daily Count request failed.');
      return data;
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason === 'timeout') {
        const timeout = Error('Daily Count took longer than 12 seconds.');
        timeout.name = 'TimeoutError';
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }
  function progress() {
    const lines = state.run?.lines || [], counted = lines.filter(line => line.status !== 'pending').length;
    $('cycleCountProgressText').textContent = counted + ' of ' + lines.length + ' counted';
    $('cycleCountProgressBar').style.width = (lines.length ? Math.round(counted / lines.length * 100) : 0) + '%';
    $('cycleCountUnsaved').textContent = dirtyCount() ? dirtyCount() + ' unsaved' : 'All changes saved';
    $('cycleCountSave').disabled = state.saving || dirtyCount() === 0;
  }
  function focusNext(input) {
    const inputs = [...$('cycleCountRows').querySelectorAll('input[data-line-id]')];
    const next = inputs[inputs.indexOf(input) + 1];
    if (next) next.focus(); else $('cycleCountSave').focus();
  }
  function renderRows(lines) {
    const host = $('cycleCountRows');
    host.replaceChildren();
    state.drafts.clear();
    lines.forEach(line => {
      const done = line.status !== 'pending', item = document.createElement('article');
      item.className = 'daily-count-line';
      const info = document.createElement('div'), sku = document.createElement('strong'), name = document.createElement('span');
      sku.textContent = line.products?.sku || '—';
      name.textContent = line.products?.name || 'Unnamed item';
      info.append(sku, name);
      const field = document.createElement('label');
      field.className = 'daily-count-field';
      const label = document.createElement('span');
      label.textContent = 'Physical count';
      const input = document.createElement('input');
      input.className = 'inventory-search';
      input.type = 'number';
      input.min = '0';
      input.step = '1';
      input.inputMode = 'numeric';
      input.autocomplete = 'off';
      input.dataset.lineId = line.id;
      input.setAttribute('aria-label', 'Physical count for ' + sku.textContent + ' ' + name.textContent);
      input.value = done ? line.counted_quantity : '';
      const saved = document.createElement('span');
      saved.className = 'daily-count-save-state';
      saved.textContent = done ? 'Saved' : 'Not counted';
      state.drafts.set(Number(line.id), { value: input.value, original: input.value, dirty: false, input, saved });
      input.addEventListener('input', () => {
        const draft = state.drafts.get(Number(line.id));
        draft.value = input.value;
        draft.dirty = input.value !== draft.original;
        saved.textContent = draft.dirty ? 'Unsaved' : (done ? 'Saved' : 'Not counted');
        saved.classList.toggle('unsaved', draft.dirty);
        progress();
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          focusNext(input);
        }
      });
      field.append(label, input, saved);
      item.append(info, field);
      host.append(item);
    });
    host.querySelector('input[data-line-id]')?.focus();
    progress();
  }
  function render(data) {
    const location = $('cycleCountLocation');
    if (!state.locationsLoaded) {
      location.replaceChildren();
      data.locations.forEach(entry => {
        const option = document.createElement('option');
        option.value = entry.id;
        option.textContent = entry.name;
        location.append(option);
      });
      state.locationsLoaded = true;
    }
    state.run = data.run || null;
    if (data.run?.location_id) location.value = data.run.location_id;
    $('cycleCountStart').hidden = Boolean(data.run);
    $('cycleCountRetry').hidden = true;
    if (!data.run) {
      state.drafts.clear();
      setView('norun');
      setStatus('No count has been started for ' + data.businessDate + '. Opening this dialog made no changes.');
      return;
    }
    const lines = data.run.lines || [];
    if (!lines.length) {
      state.drafts.clear();
      setView('empty');
      setStatus('This count contains no products.');
      return;
    }
    renderRows(lines);
    const complete = lines.every(line => line.status !== 'pending');
    setView(complete ? 'complete' : 'rows');
    if (complete) $('cycleCountComplete').append($('cycleCountRows'));
    else $('cycleCountRowsHost').append($('cycleCountRows'));
    setStatus(complete ? 'Today’s five items are counted and ready for review when required.' : 'Enter counts, then save all changes together.');
  }
  function showError(error) {
    if (error?.name === 'AbortError') return;
    setView('error');
    setStatus(error?.message || 'Could not load Daily Count.', true);
    $('cycleCountErrorMessage').textContent = error?.message || 'Could not load Daily Count.';
    $('cycleCountRetry').hidden = false;
  }
  async function load() {
    if (state.saving) return;
    if (dirtyCount() && !confirm('Discard unsaved counts and change warehouse?')) {
      $('cycleCountLocation').value = state.run?.location_id || $('cycleCountLocation').value;
      return;
    }
    cancelActive();
    state.drafts.clear();
    const sequence = state.sequence, controller = new AbortController();
    state.request = controller;
    setBusy(true);
    setView('loading');
    setStatus('Looking up today’s count…');
    try {
      const data = await request('/api/daily-cycle-count?locationId=' + encodeURIComponent($('cycleCountLocation').value), { signal: controller.signal });
      if (sequence !== state.sequence || controller.signal.aborted) return;
      render(data);
    } catch (error) {
      if (sequence === state.sequence) showError(error);
    } finally {
      if (sequence === state.sequence) {
        state.request = null;
        setBusy(false);
      }
    }
  }
  async function start() {
    if (state.saving) return;
    cancelActive();
    const sequence = state.sequence, controller = new AbortController();
    state.request = controller;
    state.saving = true;
    setBusy(true);
    setView('loading');
    setStatus('Starting today’s five-SKU count…');
    try {
      const data = await request('/api/daily-cycle-count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', locationId: Number($('cycleCountLocation').value) }),
        signal: controller.signal
      });
      if (sequence !== state.sequence || controller.signal.aborted) return;
      render(data);
    } catch (error) {
      if (sequence === state.sequence) showError(error);
    } finally {
      if (sequence === state.sequence) {
        state.request = null;
        state.saving = false;
        setBusy(false);
      }
    }
  }
  async function saveAll() {
    if (state.saving) return;
    const changes = [...state.drafts.entries()].filter(([, draft]) => draft.dirty);
    if (!changes.length) return;
    if (changes.some(([, draft]) => draft.value === '' || !Number.isFinite(Number(draft.value)) || Number(draft.value) < 0)) {
      return setStatus('Enter a physical count of zero or more for every changed row.', true);
    }
    cancelActive();
    const sequence = state.sequence, controller = new AbortController();
    state.request = controller;
    state.saving = true;
    setBusy(true);
    setStatus('Saving ' + changes.length + ' count' + (changes.length === 1 ? '' : 's') + '…');
    try {
      let data;
      for (const [lineId, draft] of changes) {
        data = await request('/api/daily-cycle-count', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'save', locationId: Number($('cycleCountLocation').value), lineId, countedQuantity: Number(draft.value) }),
          signal: controller.signal
        });
        if (sequence !== state.sequence || controller.signal.aborted) return;
      }
      render(data);
      setStatus(changes.length + ' count' + (changes.length === 1 ? '' : 's') + ' saved.');
    } catch (error) {
      if (sequence === state.sequence) showError(error);
    } finally {
      if (sequence === state.sequence) {
        state.request = null;
        state.saving = false;
        setBusy(false);
      }
    }
  }
  function open() {
    if (!$('dailyCycleCountDialog').open) $('dailyCycleCountDialog').showModal();
    load();
  }
  function close() {
    cancelActive('dialog_closed');
    state.saving = false;
    state.drafts.clear();
    setBusy(false);
    if ($('dailyCycleCountDialog').open) $('dailyCycleCountDialog').close();
  }
  window.BMWarehouseQuickDailyCount = open;
  window.BMWarehouseCloseDailyCount = close;
  $('overviewDailyCycleCount').addEventListener('click', open);
  $('cycleCountLocation').addEventListener('change', load);
  $('cycleCountStart').addEventListener('click', start);
  $('cycleCountRetry').addEventListener('click', load);
  $('cycleCountSave').addEventListener('click', saveAll);
  $('cycleCountClose').addEventListener('click', close);
  $('dailyCycleCountDialog').addEventListener('close', () => {
    cancelActive('dialog_closed');
    state.saving = false;
    state.drafts.clear();
    setBusy(false);
  });
  $('dailyCycleCountDialog').addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  window.addEventListener('bm:route-change', close);
  window.addEventListener('bm:sign-out', close);
})();