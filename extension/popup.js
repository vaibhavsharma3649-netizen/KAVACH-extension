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
