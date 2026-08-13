/* BM Warehouse - secure BM Time clock/session adapter */
(function () {
  function notifyError(message) {
    if (typeof notify === 'function') notify(message);
  }
  async function api(action, options = {}) {
    const response = await fetch(`/api/warehouse?action=${encodeURIComponent(action)}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to continue.');
    return data;
  }

  renderLogin = function () {
    pageTitle.textContent = 'Employee Login';
    app.appendChild(cloneTemplate('loginTemplate'));
    const card = app.querySelector('.login-card');
    card.querySelector('.muted').textContent = 'Enter your BM Time employee PIN.';
    card.querySelector('.permission-note').textContent = 'Secure BM Time employee login.';
    let pin = '', busy = false;
    const display = document.getElementById('pinDisplay');
    const draw = () => { display.textContent = pin ? '•'.repeat(pin.length) : '----'; };
    const submit = async () => {
      if (busy || pin.length !== 4) return;
      busy = true;
      try {
        const data = await api('login', { method: 'POST', body: JSON.stringify({ pin }) });
        state.employee = data.employee;
        state.clockedIn = Boolean(data.clockedIn);
        state.route = state.clockedIn ? 'home' : 'clock';
        render();
      } catch (error) {
        notifyError(error.message);
        pin = ''; draw();
      } finally { busy = false; }
    };
    const grid = document.getElementById('pinGrid');
    [1,2,3,4,5,6,7,8,9,0].forEach(number => {
      const button = document.createElement('button');
      button.className = 'pin-key'; button.textContent = number;
      button.onclick = () => { if (!busy && pin.length < 4) { pin += number; draw(); if (pin.length === 4) submit(); } };
      grid.appendChild(button);
    });
    document.getElementById('pinClear').onclick = () => { if (!busy) { pin = ''; draw(); } };
  };

  renderClock = function () {
    pageTitle.textContent = 'Time Clock';
    app.appendChild(cloneTemplate('clockTemplate'));
    document.getElementById('clockEmployee').textContent = state.employee.name;
    const select = document.getElementById('clockLocation');
    const clockLocations = warehouses.filter(name => name !== 'Outpost - Ronkonkoma');
    select.innerHTML = clockLocations.map(name => `<option ${name === state.location ? 'selected' : ''}>${name}</option>`).join('');
    document.getElementById('clockInBtn').onclick = async () => {
      try {
        const data = await api('clock', { method: 'POST', body: JSON.stringify({ clockAction: 'clock_in', location: select.value }) });
        state.location = data.location; locationSelect.value = state.location;
        state.clockedIn = true; state.clockInTime = new Date(); state.route = 'home';
        render(); notifyError('Clocked in');
      } catch (error) { notifyError(error.message); }
    };
  };

  logout = async function () {
    try { await api('logout', { method: 'POST', body: '{}' }); } catch (_) {}
    state.employee = null; state.clockedIn = false; state.clockInTime = null; state.route = 'login'; render();
  };
  clockOut = async function () {
    try {
      await api('clock', { method: 'POST', body: JSON.stringify({ clockAction: 'clock_out', location: state.location }) });
      state.clockedIn = false; state.clockInTime = null; state.route = 'clock'; render(); notifyError('Clocked out');
    } catch (error) { notifyError(error.message); }
  };

  api('session')
    .then(data => {
      state.employee = data.employee; state.clockedIn = Boolean(data.clockedIn);
      if (data.location) { state.location = data.location; locationSelect.value = data.location; }
      state.route = state.clockedIn ? 'home' : 'clock'; render();
    })
    .catch(() => {});
})();
