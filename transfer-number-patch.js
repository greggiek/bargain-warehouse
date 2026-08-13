(() => {
  let pendingTransferNumber = null;

  function pad(value, size = 2) { return String(value).padStart(size, '0'); }
  function nextTransferNumber() {
    const now = new Date();
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const sequence = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
    return `TR-${date}-${sequence}`;
  }

  const originalRenderTransferCreate = renderTransferCreate;
  renderTransferCreate = function () {
    pendingTransferNumber = nextTransferNumber();
    originalRenderTransferCreate();
    const heading = app.querySelector('.section-head > div');
    if (heading) {
      const number = document.createElement('div');
      number.className = 'transfer-number-card';
      number.innerHTML = `<span>TRANSFER NUMBER</span><strong>${esc(pendingTransferNumber)}</strong><small>Assigned now and printed on all transfer paperwork</small>`;
      heading.appendChild(number);
    }
  };

  const originalShowCompletion = showCompletion;
  showCompletion = function (tx, kind) {
    if (kind === 'transfer' && pendingTransferNumber) {
      const oldRef = tx.ref;
      tx.ref = pendingTransferNumber;
      const activity = state.activity.find(row => row.ref === oldRef);
      if (activity) activity.ref = tx.ref;
      backendTransfers[tx.ref] = {
        ref: tx.ref,
        from: tx.from,
        to: tx.to,
        status: tx.status,
        createdBy: tx.employee,
        lines: (tx.lines || []).map(line => ({
          sku: line.sku,
          name: line.name,
          barcode: line.barcode || line.sku,
          expected: Number(line.qty || 0)
        }))
      };
      pendingTransferNumber = null;
    }
    return originalShowCompletion(tx, kind);
  };

  const style = document.createElement('style');
  style.textContent = `.transfer-number-card{display:grid;gap:3px;margin-top:14px;padding:12px 14px;border:1px solid #99f6e4;border-radius:12px;background:#f0fdfa;width:fit-content}.transfer-number-card span{font-size:11px;font-weight:900;letter-spacing:.1em;color:#0f766e}.transfer-number-card strong{font-size:20px;letter-spacing:.03em}.transfer-number-card small{color:#64748b}`;
  document.head.appendChild(style);
})();
