(() => {
  const nav = document.getElementById('skuFixNav'), view = document.getElementById('skuFixView');
  if (!nav || !view) return;
  const status = document.getElementById('skuFixStatus'), rows = document.getElementById('skuFixRows');
  const show = (message, error = false) => { status.textContent = message; status.classList.toggle('error', error); };
  function cell(row, value) { const td = document.createElement('td'); td.textContent = value || '—'; row.append(td); }
  async function load() {
    show('Loading products without SKUs…');
    try { const response = await fetch('/api/sku-fix-queue', { credentials: 'same-origin', cache: 'no-store' }), data = await response.json(); if (!response.ok) throw Error(data.error || 'Could not load SKU Fix Queue'); rows.replaceChildren();
      (data.products || []).forEach(product => { const row = document.createElement('tr'); cell(row, product.name); cell(row, product.category); cell(row, product.barcode); const input = document.createElement('input'); input.className = 'inventory-search'; input.placeholder = 'Warehouse SKU'; input.maxLength = 80; const inputCell = document.createElement('td'); inputCell.append(input); row.append(inputCell); const action = document.createElement('td'), save = document.createElement('button'); save.className = 'button'; save.type = 'button'; save.textContent = 'Assign SKU'; save.onclick = async () => { try { save.disabled = true; const response = await fetch('/api/sku-fix-queue', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: product.id, sku: input.value }) }), data = await response.json(); if (!response.ok) throw Error(data.error || 'Could not assign SKU'); show(data.product.sku + ' assigned. This item is now eligible for operations.'); await load(); } catch (error) { show(error.message, true); } finally { save.disabled = false; } }; action.append(save); row.append(action); rows.append(row); });
      if (!(data.products || []).length) rows.innerHTML = '<tr><td colspan="5" class="muted">No missing-SKU products. The catalog is clean.</td></tr>'; show((data.products || []).length + ' products need a SKU before operations.');
    } catch (error) { show(error.message, true); }
  }
  nav.addEventListener('click', () => { document.querySelectorAll('main > section').forEach(section => section.hidden = true); view.hidden = false; document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item === nav)); load(); });
  document.getElementById('skuFixRefresh').addEventListener('click', load);
})();
