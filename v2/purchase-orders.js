(() => {
  const $ = id => document.getElementById(id), view = $('purchaseOrdersView');
  if (!view) return;
  let orders = [], locations = [], vendors = [], capabilities = {}, draftLines = [], selectedProduct = null, scanned = new Map();
  let searchTimer;
  const fmt = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value || 0));
  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
  const set = (text, error = false) => { $('purchaseOrdersStatus').textContent = text; $('purchaseOrdersStatus').classList.toggle('error', error); };
  const scanSet = (text, error = false) => { $('poScanStatus').textContent = text; $('poScanStatus').classList.toggle('error', error); };
  const cell = (row, value) => { const td = document.createElement('td'); td.textContent = value; row.append(td); };
  const activeOrder = () => orders.find(order => String(order.id) === $('poReceiveOrder').value);
  const expectedOrders = () => orders.filter(order => ['ordered', 'partially_received'].includes(order.status));

  async function request(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'Purchase order request failed');
    return data;
  }
  function setLocationOptions() {
    const select = $('poReceivingLocation'); select.replaceChildren();
    locations.forEach(location => { const option = document.createElement('option'); option.value = location.id; option.textContent = location.name + (location.code === '730' ? ' (procurement hub)' : ''); select.append(option); });
    const hub = locations.find(location => location.code === '730'); if (hub) select.value = hub.id;
  }
  function setVendorOptions() {
    const list = $('poVendors'); list.replaceChildren();
    vendors.forEach(vendor => { const option = document.createElement('option'); option.value = vendor.name; option.label = vendor.code ? vendor.code + ' · ' + vendor.name : vendor.name; list.append(option); });
  }
  function renderDraft() {
    const host = $('poDraftLineRows'); host.replaceChildren();
    draftLines.forEach(line => { const row = document.createElement('tr'); cell(row, line.sku || '—'); cell(row, line.name || 'Unnamed product'); cell(row, line.uom || 'EA'); cell(row, fmt(line.quantity)); cell(row, money(line.unitCost)); cell(row, money(line.quantity * line.unitCost)); const action = document.createElement('td'), button = document.createElement('button'); button.className = 'button secondary'; button.type = 'button'; button.textContent = 'Remove'; button.onclick = () => { draftLines = draftLines.filter(item => item.productId !== line.productId); renderDraft(); }; action.append(button); row.append(action); host.append(row); });
    if (!draftLines.length) { const row = document.createElement('tr'), empty = document.createElement('td'); empty.colSpan = 7; empty.className = 'muted'; empty.textContent = 'Add PO items by scanning or searching a SKU, barcode, or product.'; row.append(empty); host.append(row); }
    const material = draftLines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitCost || 0), 0), shipping = Math.max(0, Number($('poShippingCost')?.value || 0));
    $('poDraftMaterial').textContent = 'Material: ' + money(material); $('poDraftShipping').textContent = 'Shipping: ' + money(shipping); $('poDraftTotal').textContent = 'PO total: ' + money(material + shipping);
  }
  function renderMaster() {
    const host = $('purchaseOrderMasterRows'); host.replaceChildren();
    orders.forEach(order => {
      const row = document.createElement('tr'), lines = order.purchase_order_lines || [];
      cell(row, order.purchase_order_number); cell(row, order.vendor_name || '—'); cell(row, order.supplier_reference_number || '—'); cell(row, order.expected_date || '—'); cell(row, order.locations?.name || '—'); cell(row, String(lines.length)); cell(row, order.status.replaceAll('_', ' '));
      const action = document.createElement('td'), open = document.createElement('button'); open.className = 'button secondary'; open.type = 'button';
      const closed = ['received', 'cancelled'].includes(order.status);
      open.textContent = order.status === 'draft' && capabilities.canManagePurchaseOrders ? 'Send PO' : (closed ? 'Closed' : 'Open scanner');
      open.disabled = closed;
      open.onclick = async () => { try {
        if (order.status === 'draft' && capabilities.canManagePurchaseOrders) {
          if (!confirm('Send ' + order.purchase_order_number + ' to the supplier? Warehouse receiving will then be enabled.')) return;
          await request('/api/purchase-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'send', purchaseOrderId: order.id }) });
          set(order.purchase_order_number + ' sent.'); await load(); return;
        }
        if (!['ordered', 'partially_received'].includes(order.status)) throw Error('This PO is already closed.');
        $('poReceiveOrder').value = String(order.id); selectOrder(); $('poScannerCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (error) { set(error.message, true); } };
      action.append(open); row.append(action); host.append(row);
    });
    if (!orders.length) { const row = document.createElement('tr'), empty = document.createElement('td'); empty.colSpan = 8; empty.className = 'muted'; empty.textContent = 'No purchase orders are visible for your locations.'; row.append(empty); host.append(row); }
  }
  function renderReceiverOptions() {
    const select = $('poReceiveOrder'), previous = select.value; select.replaceChildren(); const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose sent PO to receive'; select.append(placeholder);
    expectedOrders().forEach(order => { const option = document.createElement('option'); option.value = order.id; option.textContent = order.purchase_order_number + ' · ' + (order.locations?.name || 'Receiving location'); select.append(option); });
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }
  function renderScanRows() {
    const host = $('poScanRows'), order = activeOrder(); host.replaceChildren();
    if (!order) { const row = document.createElement('tr'), empty = document.createElement('td'); empty.colSpan = 6; empty.className = 'muted'; empty.textContent = 'Choose a sent purchase order to view its expected lines.'; row.append(empty); host.append(row); return; }
    (order.purchase_order_lines || []).forEach(line => { const now = Number(scanned.get(line.id) || 0), remaining = Number(line.ordered_quantity) - Number(line.received_quantity) - now, row = document.createElement('tr'); cell(row, line.products?.sku || '—'); cell(row, line.products?.name || 'Unnamed product'); cell(row, fmt(line.ordered_quantity)); cell(row, fmt(line.received_quantity)); cell(row, fmt(now)); cell(row, fmt(remaining)); host.append(row); });
  }
  function selectOrder() { scanned = new Map(); renderScanRows(); const order = activeOrder(); scanSet(order ? 'Ready to scan ' + order.purchase_order_number + ' into ' + (order.locations?.name || 'its receiving location') + '.' : 'Choose a sent PO to begin scanning.'); }
  function renderAll() { $('poMasterCard').hidden = !capabilities.canManagePurchaseOrders; setLocationOptions(); setVendorOptions(); renderDraft(); renderMaster(); renderReceiverOptions(); renderScanRows(); }
  async function load() { const data = await request('/api/purchase-orders'); orders = data.orders || []; locations = data.locations || []; vendors = data.vendors || []; capabilities = data.capabilities || {}; renderAll(); set(capabilities.canManagePurchaseOrders ? 'Admin PO master ready. Create a draft, then send it before receipt.' : 'Scan-first receiving is ready for POs at your managed locations.'); }

  function renderSuggestions(products) {
    const host = $('poProductSuggestions'); host.replaceChildren();
    products.slice(0, 8).forEach(product => { const button = document.createElement('button'); button.type = 'button'; button.className = 'product-suggestion'; button.textContent = (product.sku || 'No SKU') + ' — ' + (product.name || 'Unnamed product'); button.onclick = () => { selectedProduct = product; $('poProductSearch').value = button.textContent; host.hidden = true; }; host.append(button); });
    host.hidden = !products.length;
  }
  async function searchProducts() { const term = $('poProductSearch').value.trim(); selectedProduct = null; if (term.length < 2) return renderSuggestions([]); const data = await request('/api/purchase-orders?productSearch=' + encodeURIComponent(term)); renderSuggestions(data.products || []); }
  function addDraftLine() {
    const quantity = Number($('poLineQuantity').value), unitCost = Number($('poLineCost').value), uom = String($('poLineUom').value || 'EA').trim().toUpperCase();
    if (!selectedProduct || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitCost) || unitCost < 0 || !uom) throw Error('Choose a product, positive quantity, UOM, and non-negative unit cost.');
    const existing = draftLines.find(line => Number(line.productId) === Number(selectedProduct.id));
    if (existing) { existing.quantity += quantity; existing.unitCost = unitCost; existing.uom = uom; }
    else draftLines.push({ productId: Number(selectedProduct.id), sku: selectedProduct.sku, name: selectedProduct.name, quantity, unitCost, uom });
    selectedProduct = null; $('poProductSearch').value = ''; $('poLineQuantity').value = '1'; $('poLineUom').value = 'EA'; $('poLineCost').value = '0.00'; renderSuggestions([]); renderDraft();
  }
  async function createDraft() {
    if (!draftLines.length) throw Error('Add at least one PO item.');
    const data = await request('/api/purchase-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create-detailed', purchaseOrderNumber: $('poNumber').value, vendorName: $('poVendor').value, supplierReferenceNumber: $('poSupplierReference').value, receivingLocationId: Number($('poReceivingLocation').value), orderDate: $('poOrderDate').value || null, expectedDate: $('poExpectedDate').value || null, shippingCost: Number($('poShippingCost').value || 0), notes: $('poNotes').value, lines: draftLines.map(line => ({ productId: line.productId, quantity: line.quantity, uom: line.uom, unitCost: line.unitCost })), idempotencyKey: crypto.randomUUID() }) });
    draftLines = []; ['poNumber', 'poVendor', 'poSupplierReference', 'poExpectedDate', 'poNotes'].forEach(id => { $(id).value = ''; }); $('poOrderDate').value = new Date().toISOString().slice(0, 10); $('poShippingCost').value = '0.00'; renderDraft(); set(data.purchaseOrder.purchaseOrderNumber + ' drafted with V1 PO details. Send it when it is ready for the supplier.'); await load();
  }
  function scan(value) {
    const order = activeOrder(), code = String(value || '').trim().toLowerCase();
    if (!order) throw Error('Choose a sent purchase order first.');
    if (!code) return;
    const line = (order.purchase_order_lines || []).find(item => [item.products?.sku, item.products?.barcode].filter(Boolean).some(candidate => String(candidate).trim().toLowerCase() === code));
    if (!line) throw Error('That SKU/barcode is not an expected line on ' + order.purchase_order_number + '.');
    const count = Number(scanned.get(line.id) || 0), outstanding = Number(line.ordered_quantity) - Number(line.received_quantity);
    if (count >= outstanding) throw Error((line.products?.sku || 'This item') + ' is already fully scanned for this PO.');
    scanned.set(line.id, count + 1); $('poScanInput').value = ''; renderScanRows(); scanSet((line.products?.sku || 'Item') + ' scanned · ' + (count + 1) + ' of ' + fmt(outstanding) + ' for this receipt.');
  }
  async function postReceipt() {
    const order = activeOrder(), lines = [...scanned.entries()].map(([lineId, quantity]) => ({ lineId, quantity }));
    if (!order || !lines.length) throw Error('Scan at least one expected PO item before posting.');
    const data = await request('/api/purchase-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'receive-lines', purchaseOrderId: order.id, lines, idempotencyKey: crypto.randomUUID() }) });
    scanSet(data.purchaseOrder.purchaseOrderNumber + ' updated: ' + data.purchaseOrder.status.replaceAll('_', ' ') + '.'); scanned = new Map(); await load();
  }

  $('purchaseOrdersNav').addEventListener('click', () => { document.querySelectorAll('main > section, #overviewView').forEach(element => { if (element.id !== 'purchaseOrdersView') element.hidden = true; }); view.hidden = false; document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.id === 'purchaseOrdersNav')); load().catch(error => set(error.message, true)); });
  document.querySelectorAll('.nav-item').forEach(item => { if (item.id !== 'purchaseOrdersNav') item.addEventListener('click', () => { view.hidden = true; }); });
  $('purchaseOrdersRefresh').onclick = () => load().catch(error => set(error.message, true));
  $('poProductSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => searchProducts().catch(error => set(error.message, true)), 180); });
  $('poAddLine').onclick = () => { try { addDraftLine(); } catch (error) { set(error.message, true); } };
  $('poCreate').onclick = () => createDraft().catch(error => set(error.message, true));
  $('poShippingCost').oninput = renderDraft;
  $('poOrderDate').value = new Date().toISOString().slice(0, 10);
  $('poReceiveOrder').onchange = selectOrder;
  $('poScanInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); try { scan(event.currentTarget.value); } catch (error) { scanSet(error.message, true); } } });
  $('poPostReceipt').onclick = () => postReceipt().catch(error => scanSet(error.message, true));
})();
