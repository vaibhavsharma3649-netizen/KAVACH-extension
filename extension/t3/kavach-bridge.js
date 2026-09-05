// KAVACH bridge — ISOLATED world. The only file allowed chrome.* APIs on
// the page side. Relays MAIN-world CustomEvents up to the background and
// relays the storage toggle back down via window.postMessage.
(function () {
  if (window.__KAVACH_BRIDGE) return;
  window.__KAVACH_BRIDGE = true;

  window.addEventListener('kavach-event', (e) => {
    try {
      chrome.runtime.sendMessage({ scope: 'kavach', event: e.detail || {} });
    } catch (err) {
      /* background may be unreachable — drop, never throw into page */
    }
  });

  function pushToggle(enabled) {
    try {
      window.postMessage({ __kavach_toggle: !!enabled }, '*');
    } catch (err) {
      /* ignore */
    }
  }

  try {
    chrome.storage.local.get({ kavach_enabled: true }, (res) => pushToggle(res.kavach_enabled));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.kavach_enabled) pushToggle(changes.kavach_enabled.newValue);
    });
  } catch (err) {
    /* storage unavailable (odd context) — MAIN defaults to enabled */
  }
})();
