// KAVACH Teammate-3 background section. Loaded via importScripts from the
// repo's extension/background.js (one line) — that file is otherwise untouched.
// 1. OBSERVE ONLY: counts navigations via non-blocking webRequest (MV3 cannot
//    inspect/block bodies here — honest scope, main_frame only to avoid log spam).
// 2. STORAGE TRUTH: kavach_stats, kavach_log (cap 50), kavach_enabled.
// Page-side PII BLOCKING lives in t3/network-block.js (fetch/XHR override);
// it reports blocks here through t3/kavach-bridge.js as {scope:'kavach'} events.
// Storage keys are kavach_*-prefixed: zero collision with the repo's `auditLog`.
(() => {
  const DEFAULTS = {
    kavach_enabled: true,
    kavach_stats: { agentFlags: 0, observed: 0, blocked: 0 },
    kavach_log: [],
  };

  chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(DEFAULTS, (cur) => {
      chrome.storage.local.set({
        kavach_enabled: cur.kavach_enabled !== undefined ? cur.kavach_enabled : true,
        kavach_stats: cur.kavach_stats || DEFAULTS.kavach_stats,
        kavach_log: Array.isArray(cur.kavach_log) ? cur.kavach_log : [],
      });
    });
  });

  function pushLog(entry) {
    chrome.storage.local.get(DEFAULTS, (cur) => {
      const log = Array.isArray(cur.kavach_log) ? cur.kavach_log : [];
      log.unshift(Object.assign({ at: Date.now() }, entry));
      const stats = Object.assign({}, DEFAULTS.kavach_stats, cur.kavach_stats);
      if (entry.kind === 'agent-flag') stats.agentFlags += 1;
      if (entry.kind === 'net-observed') stats.observed += 1;
      if (entry.kind === 'net-blocked') stats.blocked += 1;
      if (entry.kind === 'upload-masked' || entry.kind === 'upload-blocked') stats.blocked += 1;
      chrome.storage.local.set({ kavach_log: log.slice(0, 50), kavach_stats: stats });
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.scope !== 'kavach' || !msg.event) return;
    const ev = msg.event;
    if (typeof ev.type !== 'string') return;
    const kinds = {
      'agent-flag': 'agent-flag',
      'gate-approved': 'agent-flag',
      'gate-blocked': 'agent-flag',
      'net-blocked': 'net-blocked',
      'upload-masked': 'upload-masked',
      'upload-blocked': 'upload-blocked',
    };
    const kind = kinds[ev.type];
    if (kind) pushLog({ kind, label: String(ev.label || ev.type).slice(0, 120) });
  });

  // Observation only — no 'blocking' permission, no body inspection.
  try {
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (details.tabId >= 0 && /^https?:/.test(details.url || '')) {
          let host = '';
          try {
            host = new URL(details.url).hostname;
          } catch (e) {
            host = details.url;
          }
          pushLog({ kind: 'net-observed', label: String(host).slice(0, 120) });
        }
      },
      { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] }
    );
  } catch (err) {
    /* webRequest unavailable — observed counter stays 0, block path unaffected */
  }
})();
