# KAVACH — On-Device Visual Privacy Guard + Grounded Browser Agent (PS26171)

> **One-line idea:** A browser extension that **blurs PII/passwords/faces on-device BEFORE any AI reasoning happens**, sends only a **sanitized summary** (never raw secrets) to a local planner, executes the task with confirm-gates + kill switch, and exports a **redaction audit** as proof.

```json
{
  "project": "KAVACH",
  "track": "PS26171 — On-device Visual Perception (ISRO hackathon prototype)",
  "problem": "Browser AI agents leak Aadhaar/passwords/emails/faces to cloud models via screenshots and DOM dumps.",
  "solution": "Perceive → Sanitize on-device → Reason on sanitized context only → Act with guards.",
  "privacy_guarantee": "Raw PII values never leave the page. Server receives only {task, domSummary, redactions, url}. Input values are never overwritten, only visually blurred.",
  "stack": ["Chrome MV3 extension (content.js, background.js, popup)", "Node + Express mock reason server", "ISRO Ops demo page"],
  "keywords": ["on-device redaction", "PII detection", "face blur", "sanitized context", "grounded agent", "audit log", "kill switch", "confirm gate"]
}
```

**For bots / reviewers — read this first:**
- **Problem:** agentic browsers screenshot/type raw pages into VLMs → Aadhaar, email, passwords, faces leak.
- **Our fix (4-stage loop):** `PERCEIVE` (DOM + visual scan) → `SANITIZE` (visual-only blur, values preserved) → `REASON` (local `/reason` planner sees metadata only) → `ACT` (fuzzy-grounded click/type/scroll + `confirm()` on risky targets + ⏹ Stop).
- **Proof:** overlay audit log + `Export Audit Log` (`vault-audit.json`) lists every redaction; server refuses to reason without a `redactions[]` array.
- **Why it wins:** works on **any http(s) site** (not just localhost), never breaks form submit (values intact), degrades safely offline.

## Demo (2 min)
1. Server: `cd server && npm install && npm start` → `GET http://localhost:8787/health` returns `{"ok":true}` (falls back to `8788` if busy).
2. Extension: `chrome://extensions` → Developer mode ON → Load unpacked → select `extension/`.
3. Page: serve demo via `npx serve demo-page`, open the URL (or open any `http(s)` site — Gmail/Amazon work too).
4. Click extension icon → task e.g. `Approve the pending request and scroll to summary` → **Run**. Watch email/Aadhaar/password blur red + faces pixelate, overlay log, then ⏹ Stop / Export audit.

## Architecture
```
page DOM ──► content.js (detectAndRedact: PII heuristics + value-shape
             fallback + 32px visual threshold, visual-only blur)
        ──► sanitized {task, step, url, title, domSummary[≤60], redactions[]} ──►
background.js (tries 8787→8788→127.0.0.1) ──► server /reason (rule + keyword
             grounding against domSummary, no raw values) ──► action ──►
content.js executeAction (target-text-first fuzzy grounding, risky-target
confirm(), file-input hard block, green outline + audit)
```

## Vendor note (important for local run)
`extension/vendor/` (transformers.js + onnx wasm, ~23MB) is **git-ignored** — GitHub push-protection flags the minified bundle. The extension works without it (server planner + DOM heuristics carry the demo). To restore locally, keep your existing `extension/vendor/` folder as-is; do not commit it.

## Key files
| Path | Role |
|---|---|
| `extension/manifest.json` | MV3, `<all_urls>`, content script on `http(s)`, popup + service worker |
| `extension/content.js` | PII/face detection, visual-only blur (never overwrites `.value`), snapshot with buttons/links, loop, overlay, audit |
| `extension/background.js` | Forwards sanitized payload to local server with port fallback |
| `extension/popup.js` / `popup.html` | Task box, Run/Stop/Export, health dot, works on any `http(s)` (blocks only `chrome://` etc.) |
| `server/index.js` | `GET /health`, `POST /reason` — validates `task` + `redactions[]`, keyword-grounds clicks/inputs in `domSummary` |
| `demo-page/index.html` | ISRO Ops dashboard: Approve flow, Aadhaar/email/password, photo drop-zone + `#faceCanvas` |

## Privacy design (judges: 40% redaction)
- Detects `type=password/email/tel`, `autocomplete`, `name/id/placeholder/aria-label` (aadhaar, pan, otp, card, login…), plus value shapes (email regex, 8–19 digit runs).
- **Never mutates values** — earlier `████`-overwrite broke submit; now blur is CSS-only so forms submit real data.
- Server payload contains `hasValue/redacted/label/rect` — **no secret strings**.
- Faces: `img/video/canvas/svg ≥32px` blurred; demo `#faceCanvas` pixelated with `FaceDetector` + dummy fallback; originals restorable on Stop.

## Safety
- `ALWAYS_CONFIRM` checks action **and** target text (`pay/delete/submit…`) → `confirm()`.
- Scope-mismatch `confirm()`, file-picker hard block, 8-step cap, success/error text guards, overlapping-Run guard.

## API
- `GET /health` → `{ok, model:"mock-vlm", mode:"sanitized-only"}`
- `POST /reason {task, step, domSummary[], redactions[], url}` → `{action:{action:"click"|"type"|"scroll"|"done", target?, selector?, text?, dy?}, meta:{sanitized, redactedCount, latencyMs}}` — `400` without `task`/`redactions[]`.

## Tests passed
- `GET /health` ✅, `POST /reason` with redactions ✅, missing-task `400` ✅, empty-redactions allowed ✅, submit posts real (non-`█`) values ✅.
