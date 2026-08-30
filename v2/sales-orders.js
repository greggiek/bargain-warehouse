(() => {
  const $ = id => document.getElementById(id); let order = null; let expectedRoute = null;
  const set = (text, error = false) => { $('salesOrderStatus').textContent = text; $('salesOrderStatus').classList.toggle('error', error); };
  const dialog = $('salesOrderDialog');
  const show = route => { expectedRoute = route; order = null; render(); const will = route === 'will_call'; $('salesOrderTitle').textContent = will ? 'Pick will call' : 'Load local delivery'; $('salesOrderScanInput').value = ''; set('Scan a receipt to start.'); if (!dialog.open) dialog.showModal(); $('salesOrderScanInput').focus(); };
  function render() {
    const host = $('salesOrderTicket'); if (!order) { host.hidden = true; return; } host.hidden = false;
    const will = order.route === 'will_call';
    host.innerHTML = '<section class="card section"><div class="transfer-kicker">' + (will ? 'Will Call' : 'Local Delivery') + '</div><h2>' + order.number + ' · ' + order.customer + '</h2><p class="muted">' + order.storeLabel + ' · ' + order.deliveryMethod + '</p><div class="inventory-table-wrap"><table class="inventory-table"><thead><tr><th>SKU</th><th>Item</th><th>To pick</th></tr></thead><tbody>' + order.lines.map(line => '<tr><td>' + line.sku + '</td><td>' + line.name + '</td><td>' + line.remaining + '</td></tr>').join('') + '</tbody></table></div><p class="inventory-status">Read-only test: verify and pick this order. BM Warehouse will not change Shopify yet.</p></section>';
  }
  async function lookup() {
    const scan = $('salesOrderScanInput').value.trim(); if (!scan) return set('Scan or enter the receipt order number.', true);
    set('Finding the unfulfilled ' + (expectedRoute === 'will_call' ? 'Will Call' : 'Local Delivery') + ' order…');
    const response = await fetch('/api/sales-orders?scan=' + encodeURIComponent(scan), {credentials:'same-origin'}), data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'Could not find the order.');
    order = data.order; $('salesOrderScanInput').value = order.number;
    if (order.route !== expectedRoute) { const correct = order.route === 'will_call' ? 'Will Call' : 'Local Delivery'; order = null; render(); throw Error('This receipt belongs in ' + correct + '. Start it from the ' + correct + ' button.'); }
    set((order.route === 'will_call' ? 'Will Call' : 'Local Delivery') + ' order found.'); render();
  }
  $('overviewWillCallScan').onclick = () => show('will_call');
  $('overviewDeliveryScan').onclick = () => show('local_delivery');
  $('salesOrderFind').onclick = () => lookup().catch(error => set(error.message, true));
  $('salesOrderScanInput').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); lookup().catch(error => set(error.message, true)); } };
  $('salesOrderCamera').onclick = () => window.BMWarehouseCamera?.open({onScan:value => { $('salesOrderScanInput').value = value; lookup().catch(error => set(error.message, true)); }, onError:message => set(message, true), title:'Scan customer receipt'});
})();
