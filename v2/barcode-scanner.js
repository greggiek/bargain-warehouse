/* Cross-browser phone camera scanner. Mirrors the proven V1 ZXing fallback. */
(() => {
  const formats = ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar', 'qr_code'];
  let stream = null, loop = 0, zxingControls = null, closed = false;
  const constraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
  function loadZxing() {
    if (window.ZXingBrowser) return Promise.resolve(window.ZXingBrowser);
    if (window.bmZxingPromise) return window.bmZxingPromise;
    window.bmZxingPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = 'https://unpkg.com/@zxing/browser@latest'; script.crossOrigin = 'anonymous';
      script.onload = () => window.ZXingBrowser ? resolve(window.ZXingBrowser) : reject(Error('Barcode reader did not load'));
      script.onerror = () => reject(Error('Could not load the iPhone barcode reader')); document.head.append(script);
    });
    return window.bmZxingPromise;
  }
  function message(error) {
    if (!window.isSecureContext) return 'Camera scanning requires the secure https:// app address.';
    if (error?.name === 'NotAllowedError') return 'Camera permission is blocked. On iPhone: Settings → Firefox → Camera → Allow, then reload BM Warehouse.';
    if (error?.name === 'NotFoundError') return 'No rear camera was found on this device.';
    return 'Could not start the camera' + (error?.message ? ': ' + error.message : '.') + ' Enter the barcode number instead.';
  }
  async function open({ onScan, onError, title = 'Scan barcode', help = 'Hold the printed barcode inside the green box.' }) {
    if (!navigator.mediaDevices?.getUserMedia) return onError('Camera access is unavailable in this browser. Enter the barcode number instead.');
    const overlay = document.createElement('div'); closed = false;
    overlay.className = 'warehouse-camera-overlay';
    overlay.innerHTML = '<section class="card warehouse-camera-panel" role="dialog" aria-modal="true"><div class="warehouse-camera-head"><div><div class="transfer-kicker">Camera scanner</div><h2>' + title + '</h2><p class="muted">' + help + '</p></div><button class="button secondary" type="button">Close</button></div><div class="warehouse-camera-viewport"><video playsinline muted></video><div class="warehouse-camera-guide"></div></div><p class="warehouse-camera-status">Starting rear camera…</p><p class="warehouse-camera-error" hidden></p></section>';
    // A native <dialog> is drawn in the browser's top layer. Mount the camera UI
    // inside the open dialog so it stays visible instead of running behind it.
    (document.querySelector('dialog[open]') || document.body).append(overlay); const video = overlay.querySelector('video'), status = overlay.querySelector('.warehouse-camera-status'), errorBox = overlay.querySelector('.warehouse-camera-error');
    const close = async () => { if (closed) return; closed = true; cancelAnimationFrame(loop); loop = 0; try { zxingControls?.stop?.(); } catch (_) {} zxingControls = null; stream?.getTracks().forEach(track => track.stop()); stream = null; overlay.remove(); };
    overlay.querySelector('button').onclick = close;
    const complete = async value => { await close(); onScan(String(value || '').trim()); };
    try {
      if ('BarcodeDetector' in window) {
        const detector = new BarcodeDetector({ formats }); stream = await navigator.mediaDevices.getUserMedia(constraints); video.srcObject = stream; await video.play(); status.textContent = 'Hold the barcode inside the green box.';
        const detect = async () => { if (!stream || closed) return; try { const codes = await detector.detect(video); if (codes[0]?.rawValue) return complete(codes[0].rawValue); } catch (_) {} loop = requestAnimationFrame(detect); }; detect();
      } else {
        status.textContent = 'Loading iPhone barcode reader…'; const ZXing = await loadZxing(), reader = new ZXing.BrowserMultiFormatReader();
        zxingControls = await reader.decodeFromConstraints(constraints, video, result => { if (result) complete(result.getText?.() || result.text); });
        stream = video.srcObject; status.textContent = 'Hold the barcode inside the green box.';
      }
    } catch (error) { status.textContent = 'Camera scanner unavailable'; errorBox.hidden = false; errorBox.textContent = message(error); }
  }
  window.BMWarehouseCamera = { open };
  window.addEventListener('pagehide', () => { try { zxingControls?.stop?.(); } catch (_) {} stream?.getTracks().forEach(track => track.stop()); });
})();
