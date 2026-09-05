// KAVACH file upload interception (MAIN world).
// change + drop + paste through one maskAndSubstitute() helper (Q9).
// Capture-phase block + synthetic re-dispatch so the page NEVER sees the
// raw file (Q10). Images masked, everything else fail-closed (Q5/Q11).
(function () {
  if (window.__KAVACH_UPLOAD) return;
  window.__KAVACH_UPLOAD = true;
  const K = window.__KAVACH || {};
  const enabled = () => K.enabled !== false;
  const emit = (t, p) => (K.emit || function () {})(t, p);
  const toast = (m) => (K.toast || function () {})(m);

  const REDISPATCH = '__kavach_redispatch';
  const MASK_TIMEOUT_MS = 2000;
  const IMAGE_RE = /^image\/(png|jpe?g|webp)$/i;

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('mask timeout')), ms)),
    ]);
  }

  async function maskFile(file) {
    if (typeof window.maskImageFile !== 'function') throw new Error('maskImageFile unavailable');
    const blob = await withTimeout(window.maskImageFile(file), MASK_TIMEOUT_MS);
    return new File([blob], file.name, { type: file.type || 'image/png' });
  }

  // Returns File[] on success, null when the batch must be blocked.
  async function maskAndSubstitute(files) {
    const list = Array.from(files || []);
    if (!list.length) return [];
    const out = [];
    for (const f of list) {
      if (!IMAGE_RE.test(f.type || '')) {
        toast('KAVACH: only masked images are supported — "' + (f.name || 'file') + '" blocked.');
        emit('upload-blocked', { label: 'non-image: ' + (f.name || f.type || 'file') });
        return null;
      }
      try {
        out.push(await maskFile(f));
      } catch (err) {
        toast('KAVACH masking unavailable — file blocked, try again.');
        emit('upload-blocked', { label: 'mask-failed: ' + (f.name || 'file') });
        return null;
      }
    }
    emit('upload-masked', { label: out.length + ' file(s) masked' });
    return out;
  }

  function setInputFiles(input, files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    input.files = dt.files;
  }

  function isFileInput(el) {
    return !!el && el.tagName === 'INPUT' && el.type === 'file';
  }

  // ---- change on <input type=file> ----
  document.addEventListener(
    'change',
    async (e) => {
      if (!enabled() || e[REDISPATCH]) return;
      const input = e.target;
      if (!isFileInput(input) || !input.files || !input.files.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const original = Array.from(input.files);
      input.value = '';
      const masked = await maskAndSubstitute(original);
      if (!masked) return; // fail-closed: input left empty
      setInputFiles(input, masked);
      const redispatch = new Event('change', { bubbles: true, cancelable: false });
      redispatch[REDISPATCH] = true;
      input.dispatchEvent(redispatch);
    },
    true
  );

  // ---- drop ----
  document.addEventListener(
    'drop',
    async (e) => {
      if (!enabled() || e[REDISPATCH]) return;
      const files = (e.dataTransfer && e.dataTransfer.files) || [];
      if (!files.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const masked = await maskAndSubstitute(files);
      if (isFileInput(e.target) && masked) {
        setInputFiles(e.target, masked);
        const redispatch = new Event('change', { bubbles: true, cancelable: false });
        redispatch[REDISPATCH] = true;
        e.target.dispatchEvent(redispatch);
      } else if (masked) {
        // Generic drop target (e.g. ChatGPT composer): re-dispatch a drop
        // carrying ONLY the masked files so the site handler picks them up.
        try {
          const dt = new DataTransfer();
          for (const f of masked) dt.items.add(f);
          const redispatch = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
          redispatch[REDISPATCH] = true;
          e.target.dispatchEvent(redispatch);
        } catch (err) {
          toast('KAVACH: files masked — please attach them again.');
        }
      }
    },
    true
  );

  // ---- paste (screenshots) ----
  document.addEventListener(
    'paste',
    async (e) => {
      if (!enabled() || e[REDISPATCH]) return;
      const files = (e.clipboardData && e.clipboardData.files) || [];
      if (!files.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const masked = await maskAndSubstitute(files);
      if (!masked) return;
      if (isFileInput(e.target)) {
        setInputFiles(e.target, masked);
        const redispatch = new Event('change', { bubbles: true, cancelable: false });
        redispatch[REDISPATCH] = true;
        e.target.dispatchEvent(redispatch);
      } else {
        // Contenteditable composers can't receive substituted paste data, so
        // put the MASKED image back on the clipboard: the user's next paste
        // carries the safe image. Original (raw) paste was already blocked.
        try {
          const item = {};
          for (const f of masked) item[f.type || 'image/png'] = f;
          await navigator.clipboard.write([new ClipboardItem(item)]);
          toast('KAVACH: screenshot masked — paste again to insert the safe image.');
        } catch (err) {
          toast('KAVACH: screenshot blocked (clipboard write failed).');
        }
      }
    },
    true
  );
})();
