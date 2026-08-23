(() => {
  const formats = ['code_39', 'code_128', 'qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar'];
  const zxingFormats = () => (window.Html5QrcodeSupportedFormats ? [
    Html5QrcodeSupportedFormats.CODE_39, Html5QrcodeSupportedFormats.CODE_128,
    Html5QrcodeSupportedFormats.QR_CODE, Html5QrcodeSupportedFormats.EAN_13,
    Html5QrcodeSupportedFormats.EAN_8, Html5QrcodeSupportedFormats.UPC_A,
    Html5QrcodeSupportedFormats.UPC_E, Html5QrcodeSupportedFormats.ITF,
    Html5QrcodeSupportedFormats.CODABAR
  ] : undefined);

  async function open({ onScan, onError, title = 'Scan barcode', help = 'Hold the printed barcode inside the camera view.' }) {
    if (!navigator.mediaDevices?.getUserMedia) return onError('Camera access is not available in this browser. Enter the barcode number instead.');
    const overlay = document.createElement('div'), targetId = 'warehouse-camera-' + Date.now();
    overlay.className = 'warehouse-camera-overlay';
    overlay.innerHTML = '<section class="card warehouse-camera-panel"><div class="warehouse-camera-head"><div><div class="transfer-kicker">Camera scanner</div><h2>' + title + '</h2><p class="muted">' + help + '</p></div><button class="button secondary" type="button">Close</button></div><div id="' + targetId + '" class="warehouse-camera-view"></div></section>';
    document.body.append(overlay);
    let stream, frame, reader, closed = false;
    const close = async () => {
      if (closed) return; closed = true; cancelAnimationFrame(frame);
      try { await reader?.stop(); } catch (_) {}
      stream?.getTracks().forEach(track => track.stop()); overlay.remove();
    };
    overlay.querySelector('button').addEventListener('click', close);
    const complete = async value => { await close(); onScan(value); };
    try {
      if ('BarcodeDetector' in window) {
        const video = document.createElement('video'); video.playsInline = true; video.muted = true; video.className = 'warehouse-camera-video'; document.getElementById(targetId).append(video);
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        video.srcObject = stream; await video.play(); const detector = new BarcodeDetector({ formats });
        const detect = async () => { try { const [code] = await detector.detect(video); if (code?.rawValue) return complete(code.rawValue); } catch (_) {} if (!closed) frame = requestAnimationFrame(detect); };
        detect(); return;
      }
      if (!window.Html5Qrcode) throw Error('barcode_decoder_unavailable');
      reader = new Html5Qrcode(targetId, { formatsToSupport: zxingFormats(), verbose: false });
      await reader.start({ facingMode: { ideal: 'environment' } }, { fps: 10, qrbox: { width: 280, height: 180 }, aspectRatio: 1.333 }, value => complete(value), () => {});
    } catch (error) {
      await close();
      const denied = error?.name === 'NotAllowedError' || /permission|denied/i.test(String(error?.message || ''));
      onError(denied ? 'Camera permission was not granted. Allow camera access, then try again.' : 'The camera could not start. Enter the barcode number instead.');
    }
  }
  window.BMWarehouseCamera = { open };
})();
