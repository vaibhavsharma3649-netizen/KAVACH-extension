const $ = id => document.getElementById(id);
const dot = $("dot");
const srvStatus = $("srv-status");
const logBox = $("log");
function setServer(ok) {
  dot.className = "dot " + (ok ? "on" : "off");
  srvStatus.textContent = ok ? "Server online (mock-vlm)" : "Server offline (:8787 not reachable)";
  srvStatus.style.color = ok ? "#22c55e" : "#ef4444";
}
async function checkHealth() {
  try { chrome.runtime.sendMessage({ type: "PING_SERVER" }, r => setServer(r?.ok === true)); } catch { setServer(false); }
}
async function getActiveTab() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return tab; }
function updateLog(log) {
  if (!log?.length) { logBox.textContent = "No actions yet"; return; }
  logBox.textContent = log.slice(-10).map(e => `[${new Date(e.t).toLocaleTimeString()}] ${e.kind} ${(JSON.stringify(e).slice(0, 100))}`).join("\n");
  logBox.scrollTop = logBox.scrollHeight;
}
checkHealth(); setInterval(checkHealth, 10000);
$("task").value = "Click Approve and scroll to submit reports";
chrome.storage.local.get("auditLog", d => updateLog(d.auditLog));

  // helper: ensure content script injected, then send message (fixes "Receiving end does not exist")
  function sendToTab(tabId, msg){
    return new Promise(async (resolve) => {
      try {
        const r = await new Promise((res) => { chrome.tabs.sendMessage(tabId, msg, (r) => res(r)); });
        if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
        resolve(r);
      } catch(e) {
        if (e.message?.includes("Receiving end does not exist")) {
          try {
            await chrome.scripting.executeScript({ target:{tabId}, files:["content.js"] });
            await new Promise(r=>setTimeout(r,400));
            const r2 = await new Promise((res) => { chrome.tabs.sendMessage(tabId, msg, (r) => res(r)); });
            if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
            resolve(r2);
          } catch(e2) { resolve({__injectError:String(e2)}); }
        } else {
          resolve({__injectError:e.message});
        }
      }
    });
  }

$("go").onclick = async () => {
  const task = $("task").value.trim() || "Click Approve and scroll to submit reports";
  const tab = await getActiveTab(); if (!tab) { srvStatus.textContent = "No active tab"; return; }
  // Works on ANY http/https site (Gmail, Amazon, any demo). Only browser-
  // restricted schemes are blocked: chrome://, edge://, about:, file:// (unless
  // "Allow access to file URLs" is enabled for the extension).
  const url = tab.url || "";
  const blocked = /^(chrome|edge|about|brave|opera|chrome-extension|moz-extension):/i.test(url);
  if (blocked) { logBox.textContent = "This page is browser-protected (chrome://, about:, etc.).\nOpen any http(s) site instead — e.g. your demo page or gmail.com."; return; }
  if (!/^https?:/i.test(url)) { logBox.textContent = "Open any http(s) page first.\nFor local files, enable \"Allow access to file URLs\" at chrome://extensions."; return; }
  const r = await sendToTab(tab.id, { type:"VAULT_START", task });
  if (r?.__injectError) { logBox.textContent = "Inject failed: "+r.__injectError+"\nReload extension at chrome://extensions -> reload"; return; }
  logBox.textContent = "Running: " + task;
  let polls = 0;
  const pollTimer = setInterval(async () => {
    polls++;
    const r2 = await sendToTab(tab.id, {type:"VAULT_GET_LOG"});
    if (r2?.auditLog) updateLog(r2.auditLog);
    if (polls >= 6) clearInterval(pollTimer);
  }, 2000);
};
$("stop").onclick = async () => { const tab = await getActiveTab(); if (tab) await sendToTab(tab.id, {type:"VAULT_STOP"}); logBox.textContent = "Stopped — overlay and redactions cleared."; };
$("export").onclick = async () => {
  const tab = await getActiveTab();
  if (tab){ const r = await sendToTab(tab.id,{type:"VAULT_GET_LOG"}); const blob=new Blob([JSON.stringify(r?.auditLog||[],null,2)],{type:"application/json"}); const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="vault-audit.json"; a.click(); }
};

// ---- Teammate-3 status block (own kavach_* keys; no-ops if section absent) ----
(function () {
  if (!document.getElementById("t3-enabled")) return;
  const T3_DEFAULTS = { kavach_enabled: true, kavach_stats: { agentFlags: 0, observed: 0, blocked: 0 }, kavach_log: [] };
  function render(res) {
    const stats = res.kavach_stats || {};
    $("t3-enabled").checked = res.kavach_enabled !== false;
    $("t3-agent").textContent = stats.agentFlags || 0;
    $("t3-obs").textContent = stats.observed || 0;
    $("t3-block").textContent = stats.blocked || 0;
    const ul = $("t3-log"); ul.innerHTML = "";
    for (const e of (res.kavach_log || []).slice(0, 5)) {
      const li = document.createElement("li");
      li.textContent = "[" + (e.kind || "?") + "] " + (e.label || "") + " " + (e.at ? new Date(e.at).toLocaleTimeString() : "");
      ul.appendChild(li);
    }
  }
  function load() { chrome.storage.local.get(T3_DEFAULTS, render); }
  $("t3-enabled").addEventListener("change", (e) => chrome.storage.local.set({ kavach_enabled: e.target.checked }));
  $("t3-reset").addEventListener("click", () => chrome.storage.local.set({ kavach_stats: { agentFlags: 0, observed: 0, blocked: 0 }, kavach_log: [] }));
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && (changes.kavach_stats || changes.kavach_log || changes.kavach_enabled)) load(); });
  load();
})();
