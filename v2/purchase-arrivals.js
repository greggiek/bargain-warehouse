(() => {
  const $ = id => document.getElementById(id);
  const view = $('poArrivalsView');
  if (!view) return;
  let allOrders = [];
  let month = new Date();
  month = new Date(month.getFullYear(), month.getMonth(), 1);
  const dateKey = value => String(value || '').slice(0, 10);
  const dateLabel = value => new Date(value + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const status = (text, error = false) => { $('poArrivalsStatus').textContent = text; $('poArrivalsStatus').classList.toggle('error', error); };
  const monthLabel = () => month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const openOrder = order => document.dispatchEvent(new CustomEvent('bmwarehouse:open-po', { detail: { id: order.id } }));
  function render() {
    const orders = allOrders.filter(order => dateKey(order.expected_date));
    $('poArrivalsMonth').textContent = monthLabel();
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(first); start.setDate(start.getDate() - start.getDay());
    const cells = [];
    for (let i = 0; i < 42; i += 1) {
      const day = new Date(start); day.setDate(start.getDate() + i);
      const key = day.toISOString().slice(0, 10);
      const onThisDay = orders.filter(order => dateKey(order.expected_date) === key);
      const cell = document.createElement('article');
      cell.className = 'po-calendar-day' + (day.getMonth() !== month.getMonth() ? ' outside' : '') + (onThisDay.length ? ' has-arrival' : '');
      const heading = document.createElement('div'); heading.className = 'po-calendar-date'; heading.textContent = String(day.getDate()); cell.append(heading);
      onThisDay.slice(0, 3).forEach(order => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'po-calendar-event'; button.textContent = order.purchase_order_number + ' · ' + (order.vendor_name || 'Supplier');
        button.title = 'Open ' + order.purchase_order_number; button.onclick = () => openOrder(order); cell.append(button);
      });
      if (onThisDay.length > 3) {
        const extra = document.createElement('button'); extra.type = 'button'; extra.className = 'po-calendar-more'; extra.textContent = '+' + (onThisDay.length - 3) + ' more';
        extra.onclick = () => openOrder(onThisDay[3]); cell.append(extra);
      }
      cells.push(cell);
    }
    $('poCalendarDays').replaceChildren(...cells);
    const upcoming = orders.filter(order => dateKey(order.expected_date) >= new Date().toISOString().slice(0, 10)).sort((a,b) => dateKey(a.expected_date).localeCompare(dateKey(b.expected_date))).slice(0, 12);
    const rows = $('poArrivalsRows'); rows.replaceChildren();
    upcoming.forEach(order => {
      const row = document.createElement('tr');
      [dateLabel(dateKey(order.expected_date)), order.purchase_order_number, order.vendor_name || '—', order.locations?.name || '—', (order.purchase_order_lines || []).length + ' lines'].forEach(value => { const td = document.createElement('td'); td.textContent = value; row.append(td); });
      const action = document.createElement('td'), button = document.createElement('button');
      button.type = 'button'; button.className = 'button secondary'; button.textContent = 'Open PO'; button.onclick = () => openOrder(order);
      action.append(button); row.append(action); rows.append(row);
    });
    if (!upcoming.length) { const row=document.createElement('tr'), td=document.createElement('td');td.colSpan=6;td.className='muted';td.textContent='No open purchase orders have an expected ship date yet.';row.append(td);rows.append(row); }
    const without = allOrders.filter(order => !dateKey(order.expected_date)).length;
    status(allOrders.length + ' open PO' + (allOrders.length === 1 ? '' : 's') + ' · ' + orders.length + ' scheduled' + (without ? ' · ' + without + ' missing an expected ship date' : '.'));
  }
  async function load() {
    status('Loading incoming purchase orders…');
    const response = await fetch('/api/purchase-orders', { credentials:'same-origin', cache:'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'Could not load purchase orders.');
    allOrders = (data.orders || []).filter(order => ['ordered', 'partially_received'].includes(order.status));
    render();
  }
  $('poArrivalsNav').addEventListener('click', () => {
    document.querySelectorAll('main > section, #overviewView').forEach(section => { if (section.id !== 'poArrivalsView') section.hidden = true; });
    view.hidden = false; document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.id === 'poArrivalsNav'));
    load().catch(error => status(error.message, true));
  });
  $('poArrivalsRefresh').onclick = () => load().catch(error => status(error.message, true));
  $('poArrivalsPrevious').onclick = () => { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); render(); };
  $('poArrivalsNext').onclick = () => { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); render(); };
})();