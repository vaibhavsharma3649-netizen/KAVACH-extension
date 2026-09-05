// KAVACH agent-fill detection + human confirmation gate (MAIN world).
// Delegated document-level listeners — SPA-safe, no per-field binding.
// Layer 1: !e.isTrusted (naive automation).
// Layer 2: behavioural — fast/soulless fill + bulk insert (CDP-hardened).
// Focus counts ONLY when the focus event itself was trusted (Q15).
(function () {
  if (window.__KAVACH_AGENT) return;
  window.__KAVACH_AGENT = true;
  const K = window.__KAVACH || {};

  const SENSITIVE_RE = /aadhaar|pan|phone|mobile|account|passport|address|dob|email|ssn|bank/i;
  const GRACE_MS = 30000;
  const FAST_SINCE_SEEN_MS = 1000;
  const DWELL_MS = 300;

  const firstSeen = new WeakMap();
  const approvals = new WeakMap(); // el -> { value, exp }
  let gateOpen = false;
  let suppressRestore = false;

  function enabled() {
    return K.enabled !== false;
  }
  function emit(type, payload) {
    (K.emit || function () {})(type, payload);
  }
  function toast(m) {
    (K.toast || function () {})(m);
  }

  function isSensitive(el) {
    if (!el || el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
    if (el.tagName === 'INPUT') {
      const t = (el.type || '').toLowerCase();
      if (t === 'password') return true;
      if (t !== 'text' && t !== 'tel' && t !== 'number' && t !== 'email' && t !== 'search' && t !== '') return false;
    }
    if (el.hasAttribute && (el.hasAttribute('data-kavach-sensitive') || el.hasAttribute('data-kavach-label'))) return true;
    const hay = [el.name, el.id, el.placeholder, el.autocomplete, el.getAttribute && el.getAttribute('aria-label')]
      .filter(Boolean)
      .join(' ');
    return SENSITIVE_RE.test(hay);
  }

  function markSeen(el) {
    if (!firstSeen.has(el)) firstSeen.set(el, Date.now());
    return firstSeen.get(el);
  }

  // Trusted focus only: programmatic el.focus() by an agent never counts.
  document.addEventListener(
    'focus',
    (e) => {
      const el = e.target;
      if (!el || !el.tagName) return;
      markSeen(el);
      if (e.isTrusted) el.__kavachTrustedFocus = Date.now();
    },
    true
  );

  document.addEventListener(
    'input',
    (e) => {
      if (!enabled() || gateOpen) return;
      const el = e.target;
      if (!el || !isSensitive(el)) return;
      if (suppressRestore) return;

      const now = Date.now();
      const seenAt = markSeen(el);
      const val = el.value == null ? '' : String(el.value);

      // Approval grace token (Q19): approved value re-entering must not re-fire.
      const ap = approvals.get(el);
      if (ap && ap.exp > now && ap.value === val) return;
      if (!val) return;

      const trustedFocusAt = el.__kavachTrustedFocus || 0;
      const dwell = trustedFocusAt ? now - trustedFocusAt : Infinity;
      const noHumanFocus = !trustedFocusAt;
      const fastSinceSeen = now - seenAt < FAST_SINCE_SEEN_MS;
      const prevLen = el.__kavachPrevLen == null ? 0 : el.__kavachPrevLen;
      const bulkInsert = val.length - prevLen > 8;
      el.__kavachPrevLen = val.length;

      const layer1 = !e.isTrusted;
      const layer2 = (noHumanFocus || dwell < DWELL_MS) && (bulkInsert || fastSinceSeen);
      if (layer1 || layer2) {
        showGate(el, val, layer1 ? 'untrusted-event' : 'behavioural');
      }
    },
    true
  );

  // Keep prevLen fresh for human typing so bulk math stays honest.
  document.addEventListener(
    'input',
    (e) => {
      const el = e.target;
      if (el && el.tagName && e.isTrusted && el.value != null) el.__kavachPrevLen = String(el.value).length;
    },
    true
  );

  // Freeze submits while the gate is open: nothing submits unapproved (Q18).
  document.addEventListener(
    'submit',
    (e) => {
      if (gateOpen && enabled()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        toast('KAVACH: resolve the confirmation gate before submitting.');
      }
    },
    true
  );

  function showGate(el, stashedValue, reason) {
    gateOpen = true;
    const label = (K.fieldLabel || (() => 'sensitive field'))(el);
    const kind = (K.fieldKind || (() => 'text'))(el);
    const masked = (K.maskForDisplay || String)(stashedValue, kind);
    el.value = '';
    el.__kavachPrevLen = 0;
    emit('agent-flag', { label: label + ' (' + reason + ')' });

    const host = document.createElement('div');
    host.setAttribute('data-kavach-gate', '1');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);';
    const shadow = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.style.cssText =
      'background:#fff;color:#111;font:14px system-ui;border-radius:12px;padding:20px;width:min(380px,90vw);box-shadow:0 12px 40px rgba(0,0,0,.4);';
    box.innerHTML =
      '<div style="font-weight:700;font-size:15px;margin-bottom:6px;">KAVACH: agent fill detected</div>' +
      '<div style="color:#374151;margin-bottom:4px;">Field: <b></b></div>' +
      '<div style="color:#374151;margin-bottom:12px;">Value: <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;"></code></div>' +
      '<div style="color:#6b7280;font-size:12px;margin-bottom:14px;">Signal: ' +
      String(reason).replace(/</g, '&lt;') +
      ' — approve to restore, block to keep cleared.</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
      '<button data-act="block" style="padding:8px 14px;border-radius:8px;border:1px solid #d1d5db;background:#fff;cursor:pointer;">Block</button>' +
      '<button data-act="approve" style="padding:8px 14px;border-radius:8px;border:0;background:#111827;color:#fff;cursor:pointer;">Approve</button>' +
      '</div>';
    box.querySelector('b').textContent = label;
    box.querySelector('code').textContent = masked;
    shadow.appendChild(box);
    (document.documentElement || document.body).appendChild(host);

    function close(action) {
      host.remove();
      gateOpen = false;
      if (action === 'approve') {
        approvals.set(el, { value: stashedValue, exp: Date.now() + GRACE_MS });
        suppressRestore = true;
        try {
          el.value = stashedValue;
          el.__kavachPrevLen = stashedValue.length;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } finally {
          suppressRestore = false;
        }
        emit('gate-approved', { label });
      } else {
        el.focus();
        emit('gate-blocked', { label });
      }
    }
    box.querySelector('[data-act="approve"]').addEventListener('click', () => close('approve'));
    box.querySelector('[data-act="block"]').addEventListener('click', () => close('block'));
  }
})();
