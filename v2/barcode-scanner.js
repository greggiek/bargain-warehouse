/* Phone barcode scanner: ZXing is more reliable than native iPhone detection for small 1D receipt barcodes. */
(() => {
  let stream = null, zxingControls = null, closed = false;
  const constraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, focusMode: { ideal: 'continuous' } }, audio: false };
  function loadZxing() {
    if (window.ZXingBrowser) return Promise.resolve(window.ZXingBrowser);
    if (window.bmZxingPromise) return window.bmZxingPromise;
    window.bmZxingPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/@zxing/browser@latest'; script.crossOrigin = 'anonymous';
      script.onload = () => window.ZXingBrowser ? resolve(window.ZXingBrowser) : reject(Error('Barcode reader did not load'));
      script.onerror = () => reject(Error('Could not load the barcode reader. Check your internet connection.'));
      document.head.append(script);
    });
    return window.bmZxingPromise;
  }
  function message(error) {
    if (!window.isSecureContext) return 'Camera scanning requires the secure https:// BM Warehouse address.';
    if (error?.name === 'NotAllowedError') return 'Camera permission is blocked. On iPhone: Settings → Firefox → Camera → Allow, then reload BM Warehouse.';
    if (error?.name === 'NotFoundError') return 'No rear camera was found on this device.';
    return 'Could not start the camera' + (error?.message ? ': ' + error.message : '.');
  }
  async function open({ onScan, onError, title = 'Scan barcode', help = 'Hold the barcode inside the green box.' }) {
    if (!navigator.mediaDevices?.getUserMedia) return onError('Camera access is unavailable in this browser. Enter the barcode number instead.');
    const overlay = document.createElement('div'); closed = false;
    overlay.className = 'warehouse-camera-overlay';
    overlay.innerHTML = '<section class="card warehouse-camera-panel" role="dialog" aria-modal="true"><div class="warehouse-camera-head"><div><div class="transfer-kicker">Camera scanner</div><h2>' + title + '</h2><p class="muted">' + help + '</p></div><button class="button secondary" type="button">Close</button></div><div class="warehouse-camera-viewport"><video playsinline muted></video><div class="warehouse-camera-guide"></div></div><div class="warehouse-camera-actions"><label class="button secondary warehouse-camera-photo">Take photo<input type="file" accept="image/*" capture="environment" hidden></label></div><p class="warehouse-camera-status">Starting rear camera…</p><p class="warehouse-camera-error" hidden></p></section>';
    (document.querySelector('dialog[open]') || document.body).append(overlay);
    const video = overlay.querySelector('video'), status = overlay.querySelector('.warehouse-camera-status');
    const errorBox = overlay.querySelector('.warehouse-camera-error'), photo = overlay.querySelector('input[type=file]');
    const close = async () => { if (closed) return; closed = true; try { zxingControls?.stop?.(); } catch (_) {} zxingControls = null; stream?.getTracks().forEach(track => track.stop()); stream = null; overlay.remove(); };
    overlay.querySelector('button').onclick = close;
    const complete = async value => { const code = String(value || '').trim(); if (!code) return; await close(); onScan(code); };
    const showError = text => { errorBox.hidden = false; errorBox.textContent = text; };
    try {
      status.textContent = 'Loading scanner…';
      const ZXing = await loadZxing();
      const hints = new Map();
      if (ZXing.DecodeHintType && ZXing.BarcodeFormat) {
        hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.CODE_39, ZXing.BarcodeFormat.ITF, ZXing.BarcodeFormat.CODABAR, ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E, ZXing.BarcodeFormat.QR_CODE]);
        hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      }
      const reader = new ZXing.BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 90, delayBetweenScanSuccess: 300 });
      photo.onchange = async () => {
        const file = photo.files?.[0]; if (!file) return;
        try {
          status.textContent = 'Reading photo…';
          const url = URL.createObjectURL(file);
          const result = await reader.decodeFromImageUrl(url);
          URL.revokeObjectURL(url);
          await complete(result.getText?.() || result.text);
        } catch (_) { status.textContent = 'Photo could not read the barcode.'; showError('Try again with the barcode filling most of the photo, in bright light, with no glare.'); }
        finally { photo.value = ''; }
      };
      zxingControls = await reader.decodeFromConstraints(constraints, video, result => { if (result && !closed) complete(result.getText?.() || result.text); });
      stream = video.srcObject;
      const track = stream?.getVideoTracks?.()[0];
      const capabilities = track?.getCapabilities?.() || {};
      if (capabilities.focusMode?.includes?.('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      status.textContent = 'Fill the green box with the barcode. For a small receipt barcode, tap Take photo.';
    } catch (error) { status.textContent = 'Camera scanner unavailable'; showError(message(error)); }
  }
  window.BMWarehouseCamera = { open };
  window.addEventListener('pagehide', () => { try { zxingControls?.stop?.(); } catch (_) {} stream?.getTracks().forEach(track => track.stop()); });
})();
