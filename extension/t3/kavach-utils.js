// KAVACH shared MAIN-world utils. Loaded first in the MAIN bundle.
// No chrome.* APIs here — MAIN world talks to the bridge only via
// window CustomEvent('kavach-event') and window.postMessage toggle relay.
(function () {
  const K = (window.__KAVACH = window.__KAVACH || {});
  if (K.utils) return;
  K.enabled = K.enabled !== undefined ? K.enabled : true;
  K.ready = true;

  function emit(type, payload) {
    try {
      window.dispatchEvent(
        new CustomEvent('kavach-event', { detail: Object.assign({ type }, payload || {}) })
      );
    } catch (err) {
      /* event bus must never break page JS */
    }
  }

  // Toggle relay from the ISOLATED bridge (chrome.storage truth lives there).
  window.addEventListener('message', (e) => {
    const d = e && e.data;
    if (d && typeof d.__kavach_toggle === 'boolean') K.enabled = d.__kavach_toggle;
  });

  // Local PII rules (v1). Delegates to Teammate 1's window.containsPII when
  // present, otherwise uses this minimal set. Q6/Q22 fallback contract.
  const LOCAL_PATTERNS = [
    { name: 'aadhaar', re: /\b\d{4}\s?\d{4}\s?\d{4}\b/ },
    { name: 'phone', re: /\b[6-9]\d{9}\b/ },
    { name: 'pan', re: /\b[A-Z]{5}\s?[0-9]{4}\s?[A-Z]\b/ },
    { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  ];

  function localContainsPII(s) {
    if (typeof s !== 'string' || !s) return null;
    for (const p of LOCAL_PATTERNS) {
      if (p.re.test(s)) return p.name;
    }
    return null;
  }

  function containsPII(s) {
    try {
      const ext = window.containsPII;
      if (typeof ext === 'function' && ext !== containsPII) {
        const r = ext(s);
        if (r) return typeof r === 'string' ? r : 'external';
      }
    } catch (err) {
      /* fall through to local rules */
    }
    return localContainsPII(s);
  }

  function maskForDisplay(value, kind) {
    const v = String(value == null ? '' : value);
    if (!v) return '';
    if (kind === 'password' || /pass|pwd|otp|pin/i.test(kind || '')) return '••••••••';
    const digits = v.replace(/\D/g, '');
    if (digits.length >= 4) return 'XXXX-XXXX-' + digits.slice(-4);
    if (v.length <= 4) return '••••';
    return v.slice(0, 2) + '•••' + v.slice(-2);
  }

  function fieldLabel(el) {
    try {
      if (el.getAttribute && el.getAttribute('data-kavach-label')) return el.getAttribute('data-kavach-label');
      const id = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
      const text = (id && id.textContent) || el.getAttribute('aria-label') || el.placeholder || el.name || el.id || el.type || 'sensitive field';
      return String(text).trim().slice(0, 60) || 'sensitive field';
    } catch (err) {
      return 'sensitive field';
    }
  }

  function fieldKind(el) {
    try {
      const hay = [el.type, el.name, el.id, el.placeholder, el.autocomplete].filter(Boolean).join(' ');
      if (/pass|pwd|otp|pin/i.test(hay)) return 'password';
      const m = hay.match(/aadhaar|pan|phone|mobile|account|passport|address|dob|email/i);
      return m ? m[0].toLowerCase() : 'text';
    } catch (err) {
      return 'text';
    }
  }

  let toastHost = null;
  function toast(msg) {
    try {
      if (!toastHost) {
        toastHost = document.createElement('div');
        toastHost.setAttribute('data-kavach-toast', '1');
        toastHost.style.cssText =
          'position:fixed;bottom:16px;right:16px;z-index:2147483646;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
        (document.documentElement || document.body).appendChild(toastHost);
      }
      const t = document.createElement('div');
      t.textContent = String(msg);
      t.style.cssText =
        'background:#111827;color:#f9fafb;font:13px system-ui;padding:10px 12px;border-radius:8px;max-width:320px;box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:auto;';
      toastHost.appendChild(t);
      setTimeout(() => t.remove(), 4200);
    } catch (err) {
      /* never break page */
    }
  }

  K.utils = true;
  K.emit = emit;
  K.containsPII = containsPII;
  K.localContainsPII = localContainsPII;
  K.maskForDisplay = maskForDisplay;
  K.fieldLabel = fieldLabel;
  K.fieldKind = fieldKind;
  K.toast = toast;
})();
