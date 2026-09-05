// KAVACH PII-aware request blocking (MAIN world, document_start).
// Overrides window.fetch + XMLHttpRequest.prototype.send BEFORE page JS
// caches them. fetch + XHR only (declared scope, Q23).
(function () {
  if (window.__KAVACH_NET) return;
  window.__KAVACH_NET = true;
  const K = window.__KAVACH || {};
  const enabled = () => K.enabled !== false;
  const emit = (t, p) => (K.emit || function () {})(t, p);
  const toast = (m) => (K.toast || function () {})(m);
  const blockedErr = () => new Error('KAVACH blocked outgoing PII');

  function bodyToString(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      const parts = [];
      try {
        body.forEach((v) => parts.push(typeof v === 'string' ? v : (v && v.name) || ''));
      } catch (e) {
        /* ignore */
      }
      return parts.join('\n');
    }
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body).slice(0, 65536));
    if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body.buffer.slice(0, 65536));
    if (body instanceof Blob) return null; // async path
    return '';
  }

  async function bodyTextAsync(body) {
    if (body instanceof Blob) return (await body.text()).slice(0, 65536);
    return bodyToString(body);
  }

  function check(label, text) {
    if (!text) return null;
    return (K.containsPII || (() => null))(String(text).slice(0, 65536)) ? label : null;
  }

  function block(label) {
    emit('net-blocked', { label });
    toast('KAVACH blocked an outgoing request carrying PII (' + label + ').');
  }

  // ---- fetch ----
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    if (enabled()) {
      try {
        let text = '';
        if (input instanceof Request) {
          try {
            text = (await input.clone().text()).slice(0, 65536);
          } catch (e) {
            text = '';
          }
        }
        if (init && init.body !== undefined) text += '\n' + (await bodyTextAsync(init.body));
        const hit = check('fetch', text);
        if (hit) {
          block('fetch:' + hit);
          return Promise.reject(blockedErr());
        }
      } catch (e) {
        if (e && e.message === 'KAVACH blocked outgoing PII') throw e;
      }
    }
    return originalFetch(input, init);
  };

  // ---- XHR ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__kavachUrl = String(url || '').slice(0, 120);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (enabled() && body != null) {
      const finish = (text) => {
        const hit = check('xhr', text);
        if (hit) {
          block('xhr:' + hit + ' → ' + (this.__kavachUrl || ''));
          try {
            if (typeof this.onerror === 'function') {
              const ev = new ProgressEvent('error');
              this.dispatchEvent(ev);
            }
          } catch (e) {
            /* ignore */
          }
          return true;
        }
        return false;
      };
      if (body instanceof Blob) {
        const xhr = this;
        body.text().then(
          (t) => {
            if (finish(t)) return;
            origSend.call(xhr, body);
          },
          () => origSend.call(xhr, body)
        );
        return undefined;
      }
      if (finish(bodyToString(body))) return undefined;
    }
    return origSend.apply(this, arguments);
  };
})();
