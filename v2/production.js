(() => {
  const $ = id => document.getElementById(id);
  let view, locations = [], boms = [], bom = null, lines = [];
  const get = async (q = '') => {
    const r = await fetch('/api/production' + q), d = await r.json();
    if (!r.ok) throw Error(d.error || 'Request failed');
    return d;
  };
  const post = async b => {
    const r = await fetch('/api/production', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }), d = await r.json();
    if (!r.ok) throw Error(d.error || 'Request failed');
    return d;
  };
  const manufacturing = async (body) => {
    const options = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    const r = await fetch('/api/manufacturing-work-orders', options), d = await r.json();
    if (!r.ok) throw Error(d.error || 'Manufacturing request failed');
    return d;
  };
  const add = (s, t, v) => {
    const o = document.createElement('option');
    o.textContent = t; o.value = v; s.append(o);
  };
  const say = (m, bad = false) => {
    $('productionStatus').textContent = m;
    $('productionStatus').classList.toggle('error', bad);
  };
  async function selectBom(bomId) {
    const base = boms.find(x => x.id === Number(bomId));
    bom = null;
    preview();
    if (!base) return;
    const d = await get('?bomForProductId=' + base.products.id + '&locationId=' + $('productionLocation').value);
    bom = d.bom;
    $('productionBomSearch').value = base.products.sku + ' — ' + (base.finishedTitle || base.products.name);
    $('productionBomGroups').hidden = true;
    preview();
  }
  function renderBomPicker() {
    const term = $('productionBomSearch').value.trim().toLowerCase();
    const groups = new Map();
    boms.filter(row => {
      const label = row.products.sku + ' ' + (row.finishedTitle || '') + ' ' + (row.products.name || '');
      return !term || label.toLowerCase().includes(term);
    }).forEach(row => {
      const parent = row.products.name || 'Other doors';
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(row);
    });
    const holder = $('productionBomGroups');
    holder.replaceChildren();
    [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([parent, children]) => {
      const details = document.createElement('details');
      details.className = 'bom-group';
      details.open = Boolean(term);
      const summary = document.createElement('summary');
      summary.textContent = parent + ' · ' + children.length;
      details.append(summary);
      children.sort((a, b) => String(a.products.sku).localeCompare(String(b.products.sku))).forEach(row => {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.className = 'bom-child';
        choice.textContent = row.products.sku + ' — ' + (row.finishedTitle || row.products.name);
        choice.onclick = () => selectBom(row.id).catch(e => say(e.message, true));
        details.append(choice);
      });
      holder.append(details);
    });
    holder.hidden = groups.size === 0;
  }

  function preview() {
    const h = $('bomPreview');
    h.replaceChildren();
    $('productionBomStatus').textContent = bom
      ? 'Ready: ' + bom.products.sku + ' · yield ' + bom.yield_quantity
      : 'Choose a BOM to preview its components.';
    (bom?.product_bom_components || []).forEach(c => {
      const tr = document.createElement('tr'), p = c.products || {}, x = c.balance || {};
      [p.sku, p.name, c.quantity_per_yield, x.quantity ?? '—', x.allocated_quantity ?? '—'].forEach(v => {
        const td = document.createElement('td'); td.textContent = v; tr.append(td);
      });
      h.append(tr);
    });
  }

  function renderLines() {
    const h = $('productionJobLines');
    h.replaceChildren();
    lines.forEach((x, i) => {
      const tr = document.createElement('tr');
      [x.p.sku, x.p.name, x.q, 'Yield ' + x.b.yield_quantity].forEach(v => {
        const td = document.createElement('td'); td.textContent = v; tr.append(td);
      });
      const td = document.createElement('td'), b = document.createElement('button');
      b.className = 'button secondary'; b.textContent = 'Remove';
      b.onclick = () => { lines.splice(i, 1); renderLines(); };
      td.append(b); tr.append(td); h.append(tr);
    });
  }

  function printWorkOrder(job) {
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const lines = job.production_job_lines || [];
    if (!lines.length) throw Error('This work order has no finished-door lines to print.');
    const components = new Map();
    lines.forEach(line => {
      const recipe = line.product_boms || {}, output = Number(line.output_quantity || 0), yieldQty = Number(recipe.yield_quantity || 1);
      (recipe.product_bom_components || []).forEach(component => {
        const product = component.products || {}, key = component.component_product_id || product.sku || product.name;
        const row = components.get(key) || { sku: product.sku || '—', name: product.name || 'Unnamed component', quantity: 0, uom: component.uom || 'EA' };
        row.quantity += output * Number(component.quantity_per_yield || 0) / yieldQty;
        components.set(key, row);
      });
    });
    const finishedRows = lines.map(line => {
      const recipe = line.product_boms || {}, product = recipe.products || {};
      return '<tr><td><b>'+esc(product.sku || '—')+'</b><br>'+esc(product.name || recipe.finishedTitle || 'Finished door')+'</td><td>'+esc(line.output_quantity)+'</td><td>'+esc(recipe.yield_quantity || 1)+'</td></tr>';
    }).join('');
    const componentRows = [...components.values()].sort((a,b) => String(a.sku).localeCompare(String(b.sku))).map(row => '<tr><td><b>'+esc(row.sku)+'</b></td><td>'+esc(row.name)+'</td><td>'+Number(row.quantity).toLocaleString('en-US',{maximumFractionDigits:2})+' '+esc(row.uom)+'</td></tr>').join('') || '<tr><td colspan="3">Component detail is unavailable for this work order.</td></tr>';
    const popup = window.open('','_blank'); if (!popup) throw Error('Allow pop-ups to print this work order.');
    popup.document.write('<!doctype html><html><head><title>'+esc(job.job_number)+' work order</title><style>body{font:14px Arial;color:#172b48;margin:30px}.header{border-bottom:3px solid #123b61;padding-bottom:16px;margin-bottom:22px}.eyebrow{font-size:11px;color:#159765;font-weight:800;letter-spacing:1.5px}.number{font-size:30px;font-weight:800;margin:5px 0}.route{font-size:16px;margin:8px 0}h2{margin:26px 0 8px;font-size:18px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #cfd9e6;padding:10px;text-align:left;vertical-align:top}th{background:#edf3fa;font-size:12px}.notes{margin-top:28px;border:1px solid #cfd9e6;border-radius:8px;min-height:100px;padding:12px;color:#61718a}@media print{body{margin:12mm}tr{break-inside:avoid}}</style></head><body><div class="header"><div class="eyebrow">BARGAIN MOULDING · MANUFACTURING WORK ORDER</div><div class="number">'+esc(job.job_number)+'</div><div class="route"><b>Build at:</b> 730 Windham Rd<br><b>Destination:</b> '+esc(job.destination?.name || '—')+'<br><b>Reference:</b> '+esc(job.reference || '—')+'<br><b>Printed:</b> '+esc(new Date().toLocaleString())+'</div></div><h2>Finished doors to build</h2><table><thead><tr><th>SKU / finished door</th><th>Build qty</th><th>BOM yield</th></tr></thead><tbody>'+finishedRows+'</tbody></table><h2>Components to pull</h2><table><thead><tr><th>SKU</th><th>Component</th><th>Total required</th></tr></thead><tbody>'+componentRows+'</tbody></table><div class="notes"><b>Production notes</b><br><br>____________________________________________________________<br><br>____________________________________________________________</div></body></html>');
    popup.document.close(); popup.focus(); setTimeout(() => popup.print(), 250);
  }
  function renderJobs(rows) {
    const h = $('activeWorkOrderRows');
    h.replaceChildren();
    if (!rows.length) {
      h.innerHTML = '<tr><td colspan="5" class="muted">No released production jobs.</td></tr>';
      return;
    }
    rows.forEach(j => {
      const tr = document.createElement('tr'), l = j.production_job_lines || [];
      [j.job_number, l.map(x => (x.product_boms?.products?.sku || '—') + ' × ' + x.output_quantity).join(', '), j.destination?.name || '—', j.reference || '—'].forEach(v => {
        const td = document.createElement('td'); td.textContent = v; tr.append(td);
      });
      const td = document.createElement('td'), reservations = new Map();
      l.forEach(line => {
        const recipe = line.product_boms || {};
        const output = Number(line.output_quantity || 0), yieldQty = Number(recipe.yield_quantity || 1);
        (recipe.product_bom_components || []).forEach(component => {
          const product = component.products || {};
          const key = Number(component.component_product_id);
          const current = reservations.get(key) || { sku: product.sku || '—', name: product.name || '—', reserved: 0, balance: component.balance || { quantity: 0, allocated_quantity: 0 } };
          current.reserved += output * Number(component.quantity_per_yield || 0) / yieldQty;
          reservations.set(key, current);
        });
      });
      const toggle = document.createElement('button');
      toggle.type = 'button'; toggle.className = 'button secondary'; toggle.textContent = 'Reservations';
      const detail = document.createElement('tr');
      detail.hidden = true;
      const detailCell = document.createElement('td');
      detailCell.colSpan = 5;
      const table = document.createElement('table');
      table.className = 'inventory-table reservation-table';
      const head = document.createElement('thead');
      head.innerHTML = '<tr><th>Component SKU</th><th>Component</th><th>Reserved for this job</th><th>730 on hand</th><th>Total allocated</th><th>Available after allocation</th></tr>';
      const body = document.createElement('tbody');
      [...reservations.values()].sort((a, b) => a.sku.localeCompare(b.sku)).forEach(row => {
        const line = document.createElement('tr');
        const available = Number(row.balance.quantity || 0) - Number(row.balance.allocated_quantity || 0);
        [row.sku, row.name, row.reserved, row.balance.quantity || 0, row.balance.allocated_quantity || 0, available].forEach(value => {
          const cell = document.createElement('td'); cell.textContent = Number.isFinite(value) ? String(value) : value; line.append(cell);
        });
        body.append(line);
      });
      if (!reservations.size) body.innerHTML = '<tr><td colspan="6" class="muted">No component reservation details were found for this job.</td></tr>';
      table.append(head, body); detailCell.append(table); detail.append(detailCell);
      toggle.onclick = () => {
        detail.hidden = !detail.hidden;
        toggle.textContent = detail.hidden ? 'Reservations' : 'Hide reservations';
      };
      const b = document.createElement('button');
      b.className = 'button'; b.textContent = 'Complete';
      b.onclick = async () => {
        try {
          if (!confirm('Complete ' + j.job_number + '? This consumes reserved 730 components and creates one allocated transfer.')) return;
          const d = await post({ action: 'completeProductionJob', jobId: j.id });
          say(d.alreadyCompleted ? 'Already completed.' : d.jobNumber + ' complete. ' + d.transferNumber + ' is ready to ship.');
          await refresh();
        } catch (e) { say(e.message, true); }
      };
      const print = document.createElement('button'); print.type = 'button'; print.className = 'button secondary'; print.textContent = 'Print work order'; print.onclick = () => { try { printWorkOrder(j); } catch (error) { say(error.message, true); } }; td.append(print, toggle, b); tr.append(td); h.append(tr, detail);
    });
  }

  function renderMadeToOrder(rows) {
    const h = $('mtoWorkOrderRows');
    h.replaceChildren();
    if (!rows.length) {
      h.innerHTML = '<tr><td colspan="6" class="muted">No Shopify made-to-order sales have released work orders yet.</td></tr>';
      return;
    }
    rows.forEach(event => {
      const work = event.production_work_orders || {};
      const finished = event.product_boms?.products?.name || event.sku || '—';
      const tr = document.createElement('tr');
      [work.work_order_number || '—', event.shopify_order_name || event.shopify_order_id || '—', finished, work.destination?.name || '—', event.status].forEach(value => {
        const td = document.createElement('td'); td.textContent = value; tr.append(td);
      });
      const td = document.createElement('td');
      if (event.status === 'released' && work.status === 'allocated') {
        const complete = document.createElement('button');
        complete.type = 'button'; complete.className = 'button'; complete.textContent = 'Complete';
        complete.onclick = async () => {
          try {
            if (!confirm('Complete ' + work.work_order_number + '? This consumes the reserved 730 components and allocates the finished item to its destination.')) return;
            const result = await post({ action: 'completeWorkOrder', workOrderId: event.production_work_order_id });
            say(result.alreadyCompleted ? 'Work order was already completed.' : result.workOrderNumber + ' complete. ' + result.transferNumber + ' is ready to ship.');
            await refresh();
          } catch (error) { say(error.message, true); }
        };
        td.append(complete);
      } else {
        td.textContent = event.error || 'Review';
      }
      tr.append(td); h.append(tr);
    });
  }
  async function refreshMadeToOrder() {
    const d = await manufacturing();
    const destination = $('mtoDestination');
    const current = destination.value;
    destination.replaceChildren();
    add(destination, 'Choose final destination', '');
    (d.locations || []).forEach(location => add(destination, location.name, location.id));
    const trigger = (d.triggers || []).find(x => x.shopify_store_key === 'store_1' && x.shopify_product_id === $('mtoShopifyProductId').value.replace(/\\D/g, ''));
    destination.value = String(trigger?.destination?.id || current || '');
    $('mtoTriggerStatus').textContent = trigger
      ? 'Active: Shopify paid sales of product ' + trigger.shopify_product_id + ' create work orders for ' + (trigger.destination?.name || 'the selected destination') + '.'
      : 'Enter a Shopify product ID, choose its destination, then save the trigger.';
    renderMadeToOrder(d.workOrders || []);
  }

  async function refresh() {
    const d = await get('');
    renderJobs(d.activeProductionJobs || []);
    await refreshMadeToOrder();
    const h = $('productionHistoryRows');
    h.replaceChildren();
    (d.history || []).forEach(x => {
      const tr = document.createElement('tr');
      [x.document_number, x.description, x.user_name || '—', new Date(x.created_at).toLocaleString()].forEach(v => {
        const td = document.createElement('td'); td.textContent = v; tr.append(td);
      });
      h.append(tr);
    });
  }

  async function open() {
    ['overviewView', 'inventoryView', 'snapshotView', 'transferView', 'productSyncView', 'parLevelsView', 'replenishmentView', 'bomManagementView'].forEach(id => {
      if ($(id)) $(id).hidden = true;
    });
    view.hidden = false;
    document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.id === 'productionNav'));
    const d = await get();
    locations = d.locations || [];
    boms = d.activeBoms || [];
    const floor = locations.find(x => x.name === '730 Windham Rd');
    const p = $('productionLocation'), dest = $('productionDestination');
    p.replaceChildren(); add(p, '730 Windham Rd (production floor)', floor?.id || ''); p.disabled = true;
    dest.replaceChildren(); add(dest, 'Choose final destination', '');
    locations.filter(x => x.canManage && x.id !== floor?.id).forEach(x => add(dest, x.name, x.id));
    $('productionBomSearch').value = '';
    renderBomPicker();
    $('productionBomGroups').hidden = true;
    renderJobs(d.activeProductionJobs || []);
    renderLines(); preview();
    say('Choose a BOM by SKU, add door lines, then release the job to reserve 730 components.');
  }

  window.openProduction = async () => {
    try { await open(); } catch (e) { view.hidden = false; say(e.message, true); }
  };

  document.addEventListener('DOMContentLoaded', () => {
    view = $('productionView');
    const legacyBomSelect = $('productionBom');
    legacyBomSelect.hidden = true;
    const picker = document.createElement('div');
    picker.className = 'bom-picker';
    const search = document.createElement('input');
    search.id = 'productionBomSearch';
    search.className = 'inventory-search';
    search.type = 'search';
    search.autocomplete = 'off';
    search.placeholder = 'Search finished SKU or door';
    const groups = document.createElement('div');
    groups.id = 'productionBomGroups';
    groups.className = 'bom-groups';
    groups.hidden = true;
    picker.append(search, groups);
    legacyBomSelect.after(picker);
    $('productionNav').addEventListener('click', () => open().catch(e => say(e.message, true)));
    const overviewManufacturing = $('overviewManufacturing'); if (overviewManufacturing) overviewManufacturing.addEventListener('click', () => open().catch(e => say(e.message, true)));
    $('productionBomSearch').oninput = renderBomPicker;
    $('productionBomSearch').onfocus = renderBomPicker;
    $('productionAddLine').onclick = () => {
      try {
        const q = Number($('productionQty').value);
        if (!bom) throw Error('Choose an active BOM first.');
        if (!(q > 0)) throw Error('Enter the finished quantity.');
        const x = lines.find(x => x.b.id === bom.id);
        if (x) x.q += q; else lines.push({ b: bom, p: bom.products, q });
        $('productionQty').value = ''; $('productionBomSearch').value = ''; bom = null;
        preview(); renderLines(); say('Door added. Add more SKUs, then release the full job.');
      } catch (e) { say(e.message, true); }
    };
    $('mtoSaveTrigger').onclick = async () => {
      try {
        const shopifyProductId = $('mtoShopifyProductId').value.replace(/\\D/g, '');
        const destinationLocationId = Number($('mtoDestination').value);
        if (!shopifyProductId) throw Error('Enter the Shopify product ID from its Shopify admin URL.');
        if (!destinationLocationId) throw Error('Choose the final destination for this made-to-order product.');
        await manufacturing({ action: 'saveTrigger', storeKey: 'store_1', shopifyProductId, destinationLocationId, enabled: true });
        await refreshMadeToOrder();
        say('Shopify sale trigger saved. Paid sales will release a work order once the orders/paid webhook reaches BM Warehouse.');
      } catch (error) { $('mtoTriggerStatus').textContent = error.message; $('mtoTriggerStatus').classList.add('error'); }
    };
    $('mtoShopifyProductId').onchange = () => refreshMadeToOrder().catch(error => say(error.message, true));

    $('releaseProduction').onclick = async () => {
      try {
        if (!lines.length) throw Error('Add at least one door BOM.');
        const destinationLocationId = Number($('productionDestination').value);
        if (!destinationLocationId) throw Error('Choose the final destination.');
        const d = await post({
          action: 'startProductionJob',
          destinationLocationId,
          lines: lines.map(x => ({ bomId: x.b.id, quantity: x.q })),
          reference: $('productionReference').value,
          idempotencyKey: crypto.randomUUID()
        });
        lines = []; renderLines();
        say(d.jobNumber + ' released. Components are reserved at 730.');
        await refresh();
      } catch (e) { say(e.message, true); }
    };
  });
})();
