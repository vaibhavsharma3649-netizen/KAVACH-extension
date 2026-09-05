(() => {
  "use strict";
  let running = false;
  let auditLog = [];
  let killSwitch = false;
  let overlay = null;
  let overlayEnabled = false;
  let highlighted = [];
  const ALWAYS_CONFIRM = new Set(["pay", "payment", "delete", "submit", "purchase", "remove"]);
  const CONFIG = { blurFaces: true, redactPasswords: true, redactPII: true, confidenceThreshold: 0.55 };

  function log(entry) {
    try {
      const e = { t: Date.now(), ...entry };
      auditLog.push(e);
      if (chrome.storage?.local) chrome.storage.local.set({ auditLog: [e] });
    } catch {}
    if (overlayEnabled) renderOverlay();
  }

  // Stable selector + visibility helpers for button grounding ("click the
  // button where it is present"). Snapshot carries enough to click by text
  // AND by position even on unfamiliar sites.
  function cssPath(el) {
    try {
      if (el.id) return `#${el.id}`;
      const parts = [];
      let cur = el;
      for (let d = 0; d < 4 && cur && cur !== document.body; d++) {
        let s = cur.tagName.toLowerCase();
        if (cur.name) s += `[name='${cur.name}']`;
        else if (cur.className && typeof cur.className === "string") {
          const c = cur.className.trim().split(/\s+/).slice(0, 2).join(".");
          if (c) s += `.${c}`;
        }
        const sibs = cur.parentElement ? [...cur.parentElement.children].filter(c => c.tagName === cur.tagName) : [];
        if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
        parts.unshift(s);
        cur = cur.parentElement;
      }
      return parts.join(" > ");
    } catch { return el.tagName.toLowerCase(); }
  }
  function isVisible(el, rect) {
    try {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
      if (el.offsetParent === null && st.position !== "fixed" && el.tagName !== "BODY") return false;
      return true;
    } catch { return rect.width > 0 && rect.height > 0; }
  }

  function detectAndRedact() {
    // Dormant until user presses Run — no auto redaction on page load.
    if (!overlayEnabled || !running) {
      return { snapshot: [], redactions: [], htmlLen: document.documentElement.outerHTML.length };
    }
    const redactions = [];
    const snapshot = [];

    document.querySelectorAll("input, textarea, [contenteditable='true']").forEach((el, i) => {
      const type = (el.type || "text").toLowerCase();
      // Never touch file inputs: page owns upload, extension must never open a file dialog.
      if (type === "file") return;
      const name = (el.name || el.id || "").toLowerCase();
      const label = (el.labels?.[0]?.innerText || el.placeholder || el.getAttribute?.("aria-label") || "").toLowerCase();
      const auto = (el.autocomplete || "").toLowerCase();
      const val = el.value || el.innerText || "";

      // Generic PII/password heuristics — work on any site, not just the demo.
      const isPassword = type === "password"
        || /password|passwd|pwd|passcode|otp|pin|cvv|cvc|cardnumber|cc-/.test(`${name} ${label} ${auto}`)
        || auto.includes("current-password") || auto.includes("new-password")
        || auto.includes("cc-") || auto.includes("cc-");
      const attrPII = /(aadhaar|aadhar|pan\b|ssn|email|e-mail|phone|mobile|tel|address|dob|birth|salary|account|credit|card|bank|ifsc|passport|license|voter|user|login|pin|otp|secret|token)/i.test(`${name} ${label} ${auto} ${type}`);
      // Value-shape fallback: catches unlabeled fields holding an email or digit run
      // (phone / Aadhaar-like / card-like) on arbitrary sites.
      const v = String(val).trim();
      const looksEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
      const digits = v.replace(/\D/g, "");
      const looksDigits = digits.length >= 8 && digits.length <= 19 && /[\d][\d\s\-]{7,}/.test(v);
      const valuePII = looksEmail || looksDigits;
      const isPII = attrPII || valuePII;
      const sensitive = (CONFIG.redactPasswords && isPassword) || (CONFIG.redactPII && isPII);

      if (sensitive && val && !el.dataset.vaultRedacted) {
        redactions.push({ field: i, type: isPassword ? "password" : "pii", label: name || label || `field-${i}`, originalLen: val.length });
        el.dataset.vaultRedacted = "1";
        el.dataset.vaultOrigType = type;
        // Visual-only redaction: NEVER overwrite el.value.
        // Sanitization happens in the payload (domSummary/redactions
        // carry no raw values) — the DOM keeps the real value so the
        // form still submits correctly.
        el.style.filter = "blur(8px)";
        el.style.background = "#fee2e2";
      }

      snapshot.push({
        tag: el.tagName, type, name, label: label.slice(0, 40),
        hasValue: !!val, redacted: !!sensitive,
        rect: el.getBoundingClientRect().toJSON()
      });
    });

    // Generic action surface for the planner: buttons/links on ANY site
    // (demo page only had inputs in the snapshot, so the server could not
    // plan clicks elsewhere). Inputs first, then clickables; capped later.
    document.querySelectorAll("button, a, input[type='submit'], input[type='button'], select, [role='button']").forEach((el) => {
      if ((el.type || "").toLowerCase() === "file") return;
      if (el.closest?.("#faceZone") || el.id === "faceFile") return;
      const txt = (el.innerText || el.value || el.placeholder || el.getAttribute?.("aria-label") || el.title || "").trim().slice(0, 60);
      if (!txt && !el.id && !el.name) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return; // hidden
      snapshot.push({
        tag: el.tagName, type: "clickable", name: (el.id || el.name || "").toLowerCase(),
        label: txt.toLowerCase().slice(0, 60), text: txt.slice(0, 60),
        hasValue: false, redacted: false,
        rect: rect.toJSON()
      });
    });

    if (CONFIG.blurFaces) {
      document.querySelectorAll("img, video, canvas, svg").forEach((el) => {
        if (el.id === "faceCanvas" || el.closest?.("#faceZone")) return; // demo-only canvas handled separately below (passive pixelation)
        if (el.dataset.vaultFaceBlur) return;
        const rect = el.getBoundingClientRect();
        // Generic threshold: skip icons/logos/hidden elements so real sites
        // (Gmail, Amazon, …) don't get fully blurred. Faces need real size.
        if (rect.width < 32 || rect.height < 32) return;
        el.style.filter = (el.style.filter ? el.style.filter + " " : "") + "blur(10px)";
        el.style.transition = "filter 0.3s";
        el.dataset.vaultFaceBlur = "1";
        redactions.push({ field: "visual", type: "face/visual", label: el.tagName, w: rect.width, h: rect.height });
      });
    }

    if (redactions.length) log({ kind: "redaction", count: redactions.length, summary: redactions.map(r => `${r.type}:${r.label}`).join(", ") });
    return { snapshot, redactions, htmlLen: document.documentElement.outerHTML.length };
  }

  // ===== PASSIVE face blur for the page-owned #faceCanvas =====
  // Page owns upload/display (no file prompts from extension). Extension only
  // pixelates faces on the canvas when running (Run pressed). No listeners
  // on #faceZone / #faceFile here.
  const FACE_BLOCK = 14;
  function dummyFaceBoxes(w, h) {
    return w / h > 1.2
      ? [{ x: Math.round(w * 0.50), y: Math.round(h * 0.16), w: Math.round(w * 0.30), h: Math.round(h * 0.62) },
         { x: Math.round(w * 0.30), y: Math.round(h * 0.38), w: Math.round(w * 0.22), h: Math.round(h * 0.38) }]
      : [{ x: Math.round(w * 0.28), y: Math.round(h * 0.18), w: Math.round(w * 0.44), h: Math.round(h * 0.50) }];
  }
  async function detectFaceBoxesOnCanvas(cvs, W, H) {
    try {
      if ("FaceDetector" in window) {
        const fd = new FaceDetector({ fastMode: true, maxDetectedFaces: 5 });
        const faces = await fd.detect(cvs);
        if (faces && faces.length) {
          return faces.map(f => ({
            x: Math.round(f.boundingBox.x), y: Math.round(f.boundingBox.y),
            w: Math.round(f.boundingBox.width), h: Math.round(f.boundingBox.height)
          }));
        }
      }
    } catch (e) { try { console.warn("[vault] FaceDetector fail", e); } catch {} }
    return dummyFaceBoxes(W, H);
  }
  function pixelateRegion(cvs, ctx, x, y, w, h) {
    x = Math.max(0, x); y = Math.max(0, y);
    w = Math.min(cvs.width - x, w); h = Math.min(cvs.height - y, h);
    if (w < 2 || h < 2) return;
    const iw = Math.max(1, Math.floor(w / FACE_BLOCK)), ih = Math.max(1, Math.floor(h / FACE_BLOCK));
    const tmp = document.createElement("canvas"); tmp.width = iw; tmp.height = ih;
    tmp.getContext("2d").drawImage(cvs, x, y, w, h, 0, 0, iw, ih);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, iw, ih, x, y, w, h);
    ctx.imageSmoothingEnabled = true;
  }
  async function redactFaceCanvas(redactions) {
    try {
      const cvs = document.getElementById("faceCanvas");
      if (!cvs || cvs.style.display === "none") return;
      const W = cvs.width, H = cvs.height;
      if (!W || !H || W < 20 || H < 20) return;
      const stamp = W + "x" + H + "#" + (cvs.dataset.pageGen || "0");
      if (cvs.dataset.vaultFaceDone === stamp) return;
      // save original once so Stop can restore the photo
      try { if (!cvs.dataset.vaultFaceOrig || cvs.dataset.vaultFaceOrigFor !== stamp) { cvs.dataset.vaultFaceOrig = cvs.toDataURL("image/png"); cvs.dataset.vaultFaceOrigFor = stamp; } } catch {}
      const ctx = cvs.getContext("2d");
      let boxes = await detectFaceBoxesOnCanvas(cvs, W, H);
      const pad = 0.13;
      boxes = boxes.map(b => {
        const nx = Math.max(0, b.x - b.w * pad), ny = Math.max(0, b.y - b.h * pad);
        const nw = Math.min(W - nx, b.w * (1 + pad * 2)), nh = Math.min(H - ny, b.h * (1 + pad * 2));
        return { x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh) };
      });
      boxes.forEach(b => pixelateRegion(cvs, ctx, b.x, b.y, b.w, b.h));
      cvs.dataset.vaultFaceDone = stamp;
      const method = ("FaceDetector" in window) ? "FaceDetector" : "dummy-regression";
      if (redactions) redactions.push({ field: "faceCanvas", type: "face", label: "faceCanvas", count: boxes.length, method });
      log({ kind: "face_redaction", count: boxes.length, method, block: FACE_BLOCK });
    } catch (e) { try { console.warn("[vault] redactFaceCanvas error", e); } catch {} }
  }

  function clearRedactionStyles(silent) {
    document.querySelectorAll("[data-vault-redacted]").forEach(el => {
      // restore original typed value (we replaced it with block chars)
      if (el.dataset.vaultOrigValue !== undefined) {
        try {
          if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") el.value = el.dataset.vaultOrigValue;
          else el.innerText = el.dataset.vaultOrigValue;
        } catch {}
        delete el.dataset.vaultOrigValue;
      }
      el.style.filter = "";
      el.style.background = "";
      el.style.color = "";
      el.style.textShadow = "";
      delete el.dataset.vaultRedacted;
      delete el.dataset.vaultOrigType;
    });
    document.querySelectorAll("[data-vault-face-blur]").forEach(el => {
      el.style.filter = "";
      el.style.transition = "";
      delete el.dataset.vaultFaceBlur;
    });
    // restore page-owned photo canvas (face pixelation is destructive)
    try {
      const cvs = document.getElementById("faceCanvas");
      if (cvs && cvs.dataset.vaultFaceOrig) {
        const url = cvs.dataset.vaultFaceOrig;
        const img = new Image();
        img.onload = function () {
          try {
            cvs.getContext("2d").drawImage(img, 0, 0, cvs.width, cvs.height);
          } catch {}
        };
        img.src = url;
        delete cvs.dataset.vaultFaceDone;
        delete cvs.dataset.vaultFaceOrig;
        delete cvs.dataset.vaultFaceOrigFor;
      } else if (cvs) {
        delete cvs.dataset.vaultFaceDone;
      }
    } catch {}
    highlighted.forEach(el => { try { el.style.outline = ""; } catch {} });
    highlighted = [];
    if (!silent) log({ kind: "cleared" });
  }

  function removeOverlay() {
    try { if (overlay) overlay.remove(); } catch {}
    overlay = null;
  }

  function stopAndCleanup(reason) {
    killSwitch = true;
    running = false;
    overlayEnabled = false;
    clearRedactionStyles(true);
    removeOverlay();
    try {
      auditLog.push({ t: Date.now(), kind: "kill", reason: reason || "stop" });
      if (chrome.storage?.local) chrome.storage.local.set({ auditLog: auditLog.slice(-1) });
    } catch {}
  }

  function findTarget(hint) {
    if (!hint) return null;
    // If the hint looks like human text ("Approve", "Submit Report") rather
    // than CSS, skip querySelector and go straight to fuzzy text match so a
    // generic selector like "button" on an arbitrary site doesn't hijack it.
    const looksCss = /[.#\[\]:#>+~]/.test(hint) && !/^[a-z ]{1,40}$/i.test(hint);
    if (looksCss) {
      try {
        const el = document.querySelector(hint);
        if (el) return el;
      } catch {}
    }
    const h = hint.toLowerCase();
    const candidates = document.querySelectorAll("button, a, input:not([type=file]), select, [role='button'], [tabindex]");
    for (const el of candidates) {
      // Belt-and-braces: extension must never click anything that opens a file dialog.
      if ((el.type || "").toLowerCase() === "file") continue;
      if (el.closest && (el.closest("#faceZone") || el.id === "faceFile")) continue;
      const txt = (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || "").toLowerCase();
      if (txt && txt.includes(h.slice(0, 25))) return el;
      if (el.id && h.includes(el.id.toLowerCase())) return el;
      if (el.name && h.includes(el.name.toLowerCase())) return el;
    }
    return null;
  }

  async function executeAction(action) {
    if (killSwitch) return { ok: false, reason: "killed" };
    const act = (action.action || action.type || "").toLowerCase();
    // Confirm on risky verbs OR risky targets — works on any site, not just
    // when the action name itself is "submit"/"delete".
    const targetText = `${action.target || ""} ${action.selector || ""}`.toLowerCase();
    const riskyTarget = [...ALWAYS_CONFIRM].some(w => targetText.includes(w));
    if (ALWAYS_CONFIRM.has(act) || riskyTarget || action.requiresConfirm) {
      const ok = confirm(`Vault Agent wants to: ${act.toUpperCase()} ${action.target || action.selector || ""}\n\nAllow?`);
      if (!ok) { log({ kind: "action_blocked", action }); return { ok: false, reason: "user_denied" }; }
    }
    if (action.scope && !document.URL.includes(action.scope) && action.scope !== "*") {
      const ok = confirm(`Action scope mismatch (${action.scope}). Allow?`);
      if (!ok) return { ok: false, reason: "scope_denied" };
    }

    let target = null;
    // Prefer human-readable target text over a generic CSS selector so the
    // agent clicks the right control on unfamiliar sites.
    if (action.target) target = findTarget(action.target);
    if (!target && (action.selector || action.target)) target = findTarget(action.selector || action.target);

    // Hard block: never click anything that opens a file picker.
    if (target && ((target.type || "").toLowerCase() === "file" || (target.closest && target.closest("#faceZone")) || target.id === "faceFile")) {
      log({ kind: "action_blocked", reason: "file_input_refused", action });
      return { ok: false, reason: "file_input_refused" };
    }

    if (act === "click" && target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.style.outline = "3px solid #22c55e";
      highlighted.push(target);
      await new Promise(r => setTimeout(r, 500));
      target.click();
      log({ kind: "action", action, status: "executed" });
      return { ok: true };
    }
    if (act === "type" && target) {
      target.focus();
      const text = action.text || action.value || "";
      target.value = text;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      log({ kind: "action", action, status: "executed" });
      return { ok: true };
    }
    if (act === "scroll") {
      window.scrollBy({ top: action.dy || 400, behavior: "smooth" });
      log({ kind: "action", action, status: "executed" });
      return { ok: true };
    }
    if (act === "done" || act === "complete") {
      log({ kind: "done", action });
      return { ok: true, done: true };
    }
    log({ kind: "action_failed", action, reason: "no_target_found" });
    return { ok: false, reason: "no_target" };
  }

  function renderOverlay() {
    if (!overlayEnabled) return;
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "vault-overlay";
      overlay.attachShadow({ mode: "open" });
      overlay.shadowRoot.innerHTML = `
        <style>
          #vault-root{position:fixed;top:8px;right:8px;width:380px;max-height:55vh;overflow:auto;z-index:2147483647;background:#0f172a;color:#e2e8f0;font:12px/1.5 system-ui,-apple-system,sans-serif;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.5);border:1px solid #1e293b}
          #vault-bar{display:flex;gap:6px;align-items:center;padding:10px 12px;background:linear-gradient(135deg,#1e293b,#0f172a);position:sticky;top:0;z-index:1;border-bottom:1px solid #334155}
          #vault-bar b{font-size:13px;flex:1}
          #vault-bar button{font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid #475569;cursor:pointer;background:#1e293b;color:#e2e8f0;transition:all .15s}
          #vault-bar button:hover{background:#334155}
          #vault-kill{background:#991b1b!important;border-color:#ef4444!important;color:#fff!important}
          #vault-kill:hover{background:#dc2626!important}
          #vault-log{padding:8px 12px;white-space:pre-wrap;word-break:break-word;max-height:calc(55vh - 44px);overflow:auto;font-size:11px;color:#94a3b8}
          .log-redact{color:#f59e0b}.log-action{color:#22c55e}.log-error{color:#ef4444}.log-done{color:#38bdf8}
          .badge{display:inline-block;font-size:10px;padding:1px 6px;border-radius:10px;background:#334155;margin-left:6px}
        </style>
        <div id="vault-root">
          <div id="vault-bar">
            <b>\u{1f6e1}\ufe0f Vault Agent</b>
            <span class="badge" id="vault-status">idle</span>
            <button id="vault-scan" title="Scan now">Scan</button>
            <button id="vault-clear" title="Remove blur">Unblur</button>
            <button id="vault-kill" title="Stop agent">\u23f9 Stop</button>
          </div>
          <div id="vault-log"></div>
        </div>`;
      document.documentElement.appendChild(overlay);

      const s = overlay.shadowRoot;
      s.getElementById("vault-kill").onclick = () => stopAndCleanup("overlay_stop");
      s.getElementById("vault-clear").onclick = () => clearRedactionStyles(false);
      s.getElementById("vault-scan").onclick = async () => { detectAndRedact(); await redactFaceCanvas(null); log({ kind: "manual_scan" }); };
    }

    const statusEl = overlay.shadowRoot.getElementById("vault-status");
    const logEl = overlay.shadowRoot.getElementById("vault-log");
    if (statusEl) {
      statusEl.textContent = running ? "\u25b6 running" : killSwitch ? "\u26d4 stopped" : "idle";
      statusEl.style.color = running ? "#22c55e" : killSwitch ? "#ef4444" : "#94a3b8";
    }
    if (logEl) {
      logEl.innerHTML = auditLog.slice(-25).map(e => {
        const t = new Date(e.t).toLocaleTimeString();
        let cls = "";
        if (e.kind === "redaction") cls = "log-redact";
        else if (e.kind === "action") cls = "log-action";
        else if (e.kind?.includes("error") || e.kind === "action_failed") cls = "log-error";
        else if (e.kind === "done" || e.kind === "auto_done") cls = "log-done";
        return `<span class="${cls}">[${t}] ${e.kind}</span> ${JSON.stringify(e).slice(0, 160)}`;
      }).join("\n");
    }
  }

  async function perceiveSanitizeReasonAct(task, step) {
    step = step || 0;
    const { snapshot, redactions } = detectAndRedact();
    await redactFaceCanvas(redactions);
    const domSummary = snapshot.slice(0, 60);
    const sanitizedContext = {
      task, step, url: location.href, title: document.title,
      domSummary, redactions, ts: Date.now(),
      note: "PII/passwords/face visuals redacted on-device; only sanitized context transmitted"
    };

    // Escalate task verbs to the server on any site. Generic verbs added
    // (click/press/open/login/search/…) so unfamiliar tasks don't get
    // hijacked by the local fast-path.
    const needsServer = /approve|accept|scroll|down|summary|submit|save|fill|type|enter|click|press|open|login|sign|search|buy|add|send|go|next/i.test(task || "");
    const localConf = domSummary.length < 8 ? 0.85 : 0.4;
    if (step === 0 && !needsServer && localConf >= CONFIG.confidenceThreshold && !redactions.length) {
      const hint = domSummary[0]?.name ? `input[name='${domSummary[0].name}']` : "button";
      log({ kind: "confidence_gate", localConf, decision: "local", target: hint });
      return { action: "click", selector: hint, _source: "local" };
    }

    log({ kind: "escalate", domCount: domSummary.length, redactCount: redactions.length });
    const resp = await new Promise(res => {
      try {
        chrome.runtime.sendMessage({ type: "VAULT_REASON", payload: sanitizedContext }, r => {
          if (chrome.runtime.lastError) { res({ error: chrome.runtime.lastError.message }); return; }
          res(r || { error: "empty_response" });
        });
      } catch (e) { res({ error: String(e) }); }
    });
    if (resp?.error) { log({ kind: "server_error", error: resp.error }); return { action: "done", reason: "server_error" }; }
    return resp?.action || resp || { action: "done", reason: "no_action_from_server" };
  }

  async function runLoop(task, maxSteps = 8) {
    running = true;
    killSwitch = false;
    overlayEnabled = true;
    auditLog = [];
    highlighted = [];
    // Baseline: a previous run leaves "Task completed" in the page. Only
    // treat success/completed text as done-signal if it was NOT there at start.
    const startedText = (document.body?.innerText || "").toLowerCase();
    const hadDoneSignal = startedText.includes("success") || startedText.includes("completed");
    log({ kind: "start", task: task.slice(0, 100) });
    renderOverlay();

    let completedSteps = 0;
    for (let step = 0; step < maxSteps; step++) {
      if (killSwitch) break;
      const action = await perceiveSanitizeReasonAct(task, step);
      const result = await executeAction(action);
      completedSteps = step + 1;
      if (result.done || result.reason === "server_error") break;
      await new Promise(r => setTimeout(r, 1000));
      const nowText = (document.body?.innerText || "").toLowerCase();
      if (!hadDoneSignal && (nowText.includes("success") || nowText.includes("completed"))) {
        log({ kind: "auto_done" });
        break;
      }
    }
    running = false;
    log({ kind: "loop_end", steps: Math.min(completedSteps, maxSteps) });
    renderOverlay();
  }

  // Dormant on page load: no overlay, no redaction, no prompts.
  // Everything activates only on VAULT_START (Run button).
  function boot() {
    removeOverlay();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  let scanTimeout = null;
  const observer = new MutationObserver(() => {
    if (!running || !overlayEnabled) return;
    if (scanTimeout) return;
    scanTimeout = setTimeout(() => { scanTimeout = null; detectAndRedact(); redactFaceCanvas(null); }, 1500);
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
    if (msg.type === "VAULT_START") {
      runLoop(msg.task || "Click Approve and scroll to submit reports");
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "VAULT_STOP") {
      stopAndCleanup("popup_stop");
      sendResponse({ ok: true });
    }
    if (msg.type === "VAULT_GET_LOG") {
      sendResponse({ auditLog });
    }
    if (msg.type === "GET_DOM_SNAPSHOT") {
      if (!overlayEnabled || !running) { sendResponse({ snapshot: [], redactions: [] }); return; }
      const { snapshot, redactions } = detectAndRedact();
      sendResponse({ snapshot, redactions });
    }
    if (msg.type === "VAULT_SCAN") {
      if (!overlayEnabled || !running) { sendResponse({ ok: false, reason: "idle" }); return; }
      detectAndRedact();
      redactFaceCanvas(null).then(() => sendResponse({ ok: true }));
      return true;
    }
  });
})();
