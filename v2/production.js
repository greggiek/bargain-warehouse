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
  const add = (s, t, v) => {
    const o = document.createElement('option');
    o.textContent = t; o.value = v; s.append(o);
  };
  const say = (m, bad = false) => {
    $('productionStatus').textContent = m;
    $('productionStatus').classList.toggle('error', bad);
  };

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
      const td = document.createElement('td'), b = document.createElement('button');
      b.className = 'button'; b.textContent = 'Complete';
      b.onclick = async () => {
        try {
          if (!confirm('Complete ' + j.job_number + '? This consumes reserved 730 components and creates one allocated transfer.')) return;
          const d = await post({ action: 'completeProductionJob', jobId: j.id });
          say(d.alreadyCompleted ? 'Already completed.' : d.jobNumber + ' complete. ' + d.transferNumber + ' is ready to ship.');
          await refresh();
        } catch (e) { say(e.message, true); }
      };
      td.append(b); tr.append(td); h.append(tr);
    });
  }

  async function refresh() {
    const d = await get('');
    renderJobs(d.activeProductionJobs || []);
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
    ['overviewView', 'inventoryView', 'snapshotView', 'transferView', 'receivingView', 'productSyncView', 'parLevelsView', 'replenishmentView', 'bomManagementView'].forEach(id => {
      if ($(id)) $(id).hidden = true;
    });
    view.hidden = false;
    document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.id === 'productionNav'));
    const d = await get();
    locations = d.locations || [];
    boms = d.activeBoms || [];
    const floor = locations.find(x => x.name === '730 Windham Rd');
    const p = $('productionLocation'), dest = $('productionDestination'), pick = $('productionBom');
    p.replaceChildren(); add(p, '730 Windham Rd (production floor)', floor?.id || ''); p.disabled = true;
    dest.replaceChildren(); add(dest, 'Choose final destination', '');
    locations.filter(x => x.canManage && x.id !== floor?.id).forEach(x => add(dest, x.name, x.id));
    pick.replaceChildren(); add(pick, 'Choose BOM by finished SKU', '');
    boms.forEach(x => add(pick, x.products.sku + ' — ' + x.products.name, x.id));
    renderJobs(d.activeProductionJobs || []);
    renderLines(); preview();
    say('Choose a BOM by SKU, add door lines, then release the job to reserve 730 components.');
  }

  window.openProduction = async () => {
    try { await open(); } catch (e) { view.hidden = false; say(e.message, true); }
  };

  document.addEventListener('DOMContentLoaded', () => {
    view = $('productionView');
    $('productionNav').addEventListener('click', () => open().catch(e => say(e.message, true)));
    $('productionBom').onchange = async e => {
      try {
        const base = boms.find(x => x.id === Number(e.target.value));
        bom = null; preview();
        if (!base) return;
        const d = await get('?bomForProductId=' + base.products.id + '&locationId=' + $('productionLocation').value);
        bom = d.bom; preview();
      } catch (e) { say(e.message, true); }
    };
    $('productionAddLine').onclick = () => {
      try {
        const q = Number($('productionQty').value);
        if (!bom) throw Error('Choose an active BOM first.');
        if (!(q > 0)) throw Error('Enter the finished quantity.');
        const x = lines.find(x => x.b.id === bom.id);
        if (x) x.q += q; else lines.push({ b: bom, p: bom.products, q });
        $('productionQty').value = ''; $('productionBom').value = ''; bom = null;
        preview(); renderLines(); say('Door added. Add more SKUs, then release the full job.');
      } catch (e) { say(e.message, true); }
    };
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
