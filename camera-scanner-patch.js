/* BM Warehouse phone-camera barcode scanner.
   Enhances existing scan inputs without changing hardware-scanner behavior. */
(function(){
  const scanSelector='input.scan-input[placeholder*="Scan"],input.scan-input[placeholder*="scan"]';
  let stream=null,loop=0,detector=null,target=null,zxingControls=null;

  const style=document.createElement('style');
  style.textContent=`
    .scan-row:has(.bm-camera-button){grid-template-columns:minmax(0,1fr) auto auto}
    .bm-camera-button{min-width:52px;min-height:48px;border:1px solid #bfdbfe;border-radius:12px;background:#eff6ff;color:#1d4ed8;font-weight:900;font-size:22px}
    .bm-camera-overlay{position:fixed;inset:0;z-index:1000;background:rgba(15,23,42,.82);display:grid;place-items:center;padding:16px}
    .bm-camera-card{width:min(560px,100%);background:#fff;border-radius:18px;padding:16px;box-shadow:0 24px 80px rgba(0,0,0,.35)}
    .bm-camera-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.bm-camera-head h2{margin:0;font-size:20px}
    .bm-camera-close{border:0;background:#eef2f7;border-radius:10px;width:42px;height:42px;font-size:24px}
    .bm-camera-viewport{position:relative;overflow:hidden;border-radius:14px;background:#020617;aspect-ratio:4/3}
    .bm-camera-viewport video{width:100%;height:100%;object-fit:cover}.bm-camera-guide{position:absolute;inset:24% 8%;border:3px solid #22c55e;border-radius:12px;box-shadow:0 0 0 999px rgba(0,0,0,.18)}
    .bm-camera-status{margin:12px 0 0;color:#475569;font-weight:700}.bm-camera-help{display:none;margin-top:12px;padding:12px;border-radius:12px;background:#fff7ed;color:#9a3412}
    @media(max-width:760px){.scan-row:has(.bm-camera-button){grid-template-columns:minmax(0,1fr) auto}.scan-row:has(.bm-camera-button)>button:not(.bm-camera-button){grid-column:1/-1}}
  `;
  document.head.appendChild(style);

  function closeScanner(){
    cancelAnimationFrame(loop);loop=0;
    try{zxingControls?.stop?.();}catch(_){}zxingControls=null;
    if(stream)stream.getTracks().forEach(t=>t.stop());
    stream=null;target=null;
    document.querySelector('.bm-camera-overlay')?.remove();
  }
  function loadZxing(){
    if(window.ZXingBrowser)return Promise.resolve(window.ZXingBrowser);
    if(window.bmZxingPromise)return window.bmZxingPromise;
    window.bmZxingPromise=new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src='https://unpkg.com/@zxing/browser@latest';script.crossOrigin='anonymous';
      script.onload=()=>window.ZXingBrowser?resolve(window.ZXingBrowser):reject(new Error('Barcode reader did not load'));
      script.onerror=()=>reject(new Error('Could not load the iPhone barcode reader'));
      document.head.appendChild(script);
    });
    return window.bmZxingPromise;
  }
  function submit(value){
    if(!target)return;
    target.value=String(value||'').trim();
    target.dispatchEvent(new Event('input',{bubbles:true}));
    target.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));
    closeScanner();
  }
  function errorMessage(err){
    if(!window.isSecureContext)return 'Camera scanning requires the secure https:// app address.';
    if(err?.name==='NotAllowedError')return 'Camera permission is blocked. On iPhone: Settings → Safari → Camera → Allow. On Android Chrome: tap the lock icon → Permissions → Camera → Allow, then reload.';
    if(err?.name==='NotFoundError')return 'No rear camera was found on this device.';
    if(err?.name==='UnsupportedError')return 'The barcode reader could not load. Check the internet connection, reload BM Warehouse, and try again.';
    return `Could not start the camera${err?.message?`: ${err.message}`:''}.`;
  }
  async function openScanner(input){
    target=input;
    const overlay=document.createElement('div');overlay.className='bm-camera-overlay';
    overlay.innerHTML=`<section class="bm-camera-card" role="dialog" aria-modal="true" aria-label="Scan barcode"><div class="bm-camera-head"><h2>Scan barcode</h2><button class="bm-camera-close" aria-label="Close camera">×</button></div><div class="bm-camera-viewport"><video playsinline muted></video><div class="bm-camera-guide"></div></div><p class="bm-camera-status">Starting rear camera…</p><div class="bm-camera-help"></div></section>`;
    document.body.appendChild(overlay);overlay.querySelector('.bm-camera-close').onclick=closeScanner;
    const status=overlay.querySelector('.bm-camera-status'),help=overlay.querySelector('.bm-camera-help'),video=overlay.querySelector('video');
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('Camera access is unavailable in this browser');
      const constraints={video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false};
      if('BarcodeDetector' in window){
        detector=new BarcodeDetector({formats:['code_128','code_39','ean_13','ean_8','upc_a','upc_e','itf','codabar','qr_code']});
        stream=await navigator.mediaDevices.getUserMedia(constraints);video.srcObject=stream;await video.play();status.textContent='Hold the barcode inside the green box.';
        const detect=async()=>{if(!stream)return;try{const codes=await detector.detect(video);if(codes[0]?.rawValue){submit(codes[0].rawValue);return;}}catch(_){}loop=requestAnimationFrame(detect)};detect();
      }else{
        status.textContent='Loading iPhone barcode reader…';
        const ZXing=await loadZxing(),reader=new ZXing.BrowserMultiFormatReader();
        zxingControls=await reader.decodeFromConstraints(constraints,video,(result)=>{if(result){const value=result.getText?.()||result.text;if(value)submit(value)}});
        stream=video.srcObject;status.textContent='Hold the barcode inside the green box.';
      }
    }catch(err){status.textContent='Camera scanner unavailable';help.style.display='block';help.textContent=errorMessage(err);}
  }
  function enhance(root=document){
    root.querySelectorAll?.(scanSelector).forEach(input=>{
      if(input.dataset.cameraScanner==='1')return;input.dataset.cameraScanner='1';
      const button=document.createElement('button');button.type='button';button.className='bm-camera-button';button.title='Scan with phone camera';button.setAttribute('aria-label','Scan with phone camera');button.textContent='▣';
      button.onclick=()=>openScanner(input);input.insertAdjacentElement('afterend',button);
    });
  }
  enhance();new MutationObserver(records=>records.forEach(r=>r.addedNodes.forEach(n=>n.nodeType===1&&enhance(n)))).observe(document.body,{childList:true,subtree:true});
  window.addEventListener('pagehide',closeScanner);
})();
