(() => {
  const openTransfers = () => {
    const nav = document.getElementById('transfersNav');
    const view = document.getElementById('transferView');
    if (!nav || !view) return;

    // Keep the sidebar responsive even if a worker clicks before the larger
    // Transfers module has finished initializing.
    document.querySelectorAll('main > section, #overviewView').forEach((element) => {
      if (element !== view) element.hidden = true;
    });
    view.hidden = false;
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.classList.toggle('active', item === nav);
    });

    if (typeof window.BMWarehouseOpenTransfers === 'function') {
      window.BMWarehouseOpenTransfers(false);
    } else {
      window.BMWarehousePendingTransfersOpen = true;
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('transfersNav')?.addEventListener('click', openTransfers);
  });
})();
