(() => {
  // Local reason server. Tried in order so it works no matter which site the
  // content script runs on (request originates from the service worker, not
  // the page, so any http/https tab is fine) and survives the EADDRINUSE
  // fallback in server/index.js (8787 -> 8788).
  const SERVER_CANDIDATES = ["http://localhost:8787", "http://localhost:8788", "http://127.0.0.1:8787", "http://127.0.0.1:8788"];

  async function fetchFirst(path, opts, timeoutMs = 3500) {
    let lastErr = null;
    for (const base of SERVER_CANDIDATES) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        const r = await fetch(`${base}${path}`, { ...opts, signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) throw new Error(`server ${r.status}`);
        return await r.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("server unreachable");
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "VAULT_REASON") {
      fetchFirst("/reason", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg.payload)
      })
        .then(data => sendResponse(data))
        .catch(e => sendResponse({ action: { action: "done", reason: `server_error: ${e.message}` } }));
      return true;
    }

    if (msg.type === "PING_SERVER") {
      fetchFirst("/health", undefined, 3000)
        .then(d => sendResponse(d))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
  });
})();
