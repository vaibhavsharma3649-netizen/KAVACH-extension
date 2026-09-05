import express from "express";
import cors from "cors";
const app = express();
app.use(cors()); app.use(express.json({limit:"2mb"}));

app.get("/health", (_req,res)=> res.json({ok:true, model:"mock-vlm", mode:"sanitized-only"}));

const RULES = [
  { match: /approve|accept/i, action: {action:"click", target:"Approve", selector:"button.approve, #approve-btn, button"} },
  { match: /scroll|down|summary/i, action: {action:"scroll", dy: 500} },
  { match: /fill|type|enter/i, action: {action:"type", selector:"input[type=text], textarea", text:"Demo entry by Vault Agent"} },
  { match: /submit|save/i, action: {action:"click", target:"Submit", selector:"button[type=submit], #submit-btn", requiresConfirm:true} }
];

// ---- Generic resolvers: adapt demo RULES to any site using domSummary ----
const STOPWORDS = new Set("the,a,an,to,on,in,at,and,or,please,now,then,report,reports,page,site,web,button,link,field,form,input".split(","));
function taskKeywords(task) {
  return (task || "").toLowerCase().replace(/[^a-z0-9@ ]/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));
}
function clickables(dom) {
  return (dom || []).filter(d => d.tag === "BUTTON" || d.tag === "A" || d.type === "clickable" || d.tag === "SELECT" || (d.tag === "INPUT" && /submit|button/.test(d.type || "")));
}
function textInputs(dom) {
  return (dom || []).filter(d => (d.tag === "INPUT" || d.tag === "TEXTAREA") && !/submit|button|checkbox|radio|file|hidden/.test(d.type || ""));
}
function scoreClickable(el, keywords) {
  const hay = `${el.text || ""} ${el.label || ""} ${el.name || ""}`.toLowerCase();
  let s = 0;
  for (const k of keywords) if (hay.includes(k)) s += k.length;
  return s;
}
function bestClickable(dom, task) {
  const c = clickables(dom);
  if (!c.length) return null;
  const kw = taskKeywords(task);
  let best = null, bestScore = 0;
  for (const el of c) { const s = scoreClickable(el, kw); if (s > bestScore) { bestScore = s; best = el; } }
  return bestScore > 0 ? best : null;
}
function bestInput(dom, task) {
  const ins = textInputs(dom);
  if (!ins.length) return null;
  const kw = taskKeywords(task);
  let best = null, bestScore = 0;
  for (const el of ins) {
    const hay = `${el.label || ""} ${el.name || ""}`.toLowerCase();
    let s = 0;
    for (const k of kw) if (hay.includes(k)) s += k.length;
    if (s > bestScore) { bestScore = s; best = el; }
  }
  return best || ins[0];
}
function clickableTarget(el) {
  const text = (el.text || el.label || el.name || "button").slice(0, 60);
  const sel = el.name ? `[name='${el.name}']` : null;
  return { text, sel };
}
// Resolve a demo-specific action against the real page: keep demo selectors
// as fallback (demo page still works) but prefer the actual control text
// found on this site so findTarget clicks the right thing.
function resolveAction(action, task, domSummary) {
  const a = { ...action };
  if (a.action === "click") {
    const hit = bestClickable(domSummary, a.target ? `${task} ${a.target}` : task);
    if (hit) {
      const { text } = clickableTarget(hit);
      a.target = text; // human text first — content.js prefers it over generic CSS
      // keep original selector as fallback for the demo page
    } else if (!a.target && domSummary.length) {
      const first = clickables(domSummary)[0];
      if (first) a.target = clickableTarget(first).text;
    }
  }
  if (a.action === "type") {
    const hit = bestInput(domSummary, task);
    if (hit) {
      a.target = hit.label || hit.name || a.target || "input";
      if (hit.name) a.selector = `input[name='${hit.name}'], #${hit.name}, ${a.selector || "input, textarea"}`;
      // preserve agent-typed text unless task quotes its own text
      const quoted = (task.match(/["“”']([^"“”']{1,120})["“”']/) || [])[1];
      if (quoted) a.text = quoted;
    }
  }
  return a;
}

const taskCounter = new Map();
function planNext(sanitizedContext){
  const {task, domSummary=[]} = sanitizedContext;
  const t=(task||"").toLowerCase();
  const matches = RULES.filter(r => r.match.test(t));
  if(matches.length > 0){
    // Prefer the explicit step sent by the extension (resets every Run).
    // Fall back to the legacy per-task counter for older clients.
    let base;
    if (Number.isInteger(sanitizedContext.step)) {
      base = matches[sanitizedContext.step % matches.length].action;
    } else {
      const count = taskCounter.get(t) || 0;
      base = matches[count % matches.length].action;
      taskCounter.set(t, count + 1);
    }
    return resolveAction(base, task, domSummary);
  }
  // Generic fallback for tasks that match no demo verb ("click sign in",
  // "search shoes", …): ground the verb in the actual domSummary.
  if (/click|press|tap|open|login|sign|buy|add|send|submit|save|go|next|continue/i.test(t)) {
    const hit = bestClickable(domSummary, task);
    if (hit) { const { text } = clickableTarget(hit); return { action: "click", target: text, selector: "button, a, input[type=submit]" }; }
  }
  if (/type|fill|enter|search|write/i.test(t)) {
    const hit = bestInput(domSummary, task);
    if (hit) {
      const quoted = (task.match(/["“”']([^"“”']{1,120})["“”']/) || [])[1];
      return { action: "type", target: hit.label || hit.name || "input", selector: hit.name ? `input[name='${hit.name}'], #${hit.name}, input, textarea` : "input, textarea", text: quoted || "Demo entry by Vault Agent" };
    }
  }
  const hasButton = domSummary.find(d=> d.tag==="BUTTON");
  if(hasButton) return {action:"click", selector:"button", target: hasButton.label || hasButton.text || "first button"};
  const anyClick = clickables(domSummary)[0];
  if(anyClick) return {action:"click", selector:"button, a", target: clickableTarget(anyClick).text};
  return {action:"scroll", dy: 350};
}

app.post("/reason", (req,res)=>{
  try{
    const ctx = req.body || {};
    if(!ctx.task || typeof ctx.task!=="string") return res.status(400).json({error:"task required"});
    if(!Array.isArray(ctx.redactions)) return res.status(400).json({action:{action:"done", reason:"missing redaction audit — refusing to reason without proof of sanitization"}});
    if(!Array.isArray(ctx.domSummary)) ctx.domSummary=[];
    console.log("[reason] task:", ctx.task.slice(0,80), "redactions:", ctx.redactions.length, "dom:", ctx.domSummary.length);
    const action = planNext(ctx);
    console.log("[reason] step:", ctx.step, "->", JSON.stringify(action));
    const latencyMs = 180 + Math.floor(Math.random()*120);
    setTimeout(()=> res.json({action, meta:{sanitized:true, redactedCount: ctx.redactions.length, latencyMs, ts: Date.now()}}), latencyMs);
  } catch(e){ res.status(500).json({error:String(e)}); }
});
app.use((err,_req,res,_next)=>{ if(err?.type==="entity.too.large") return res.status(413).json({error:"payload too large"}); res.status(400).json({error:String(err)}); });

const PORT = Number(process.env.PORT || 8787);
const server = app.listen(PORT, ()=> console.log(`Vault server on http://localhost:${PORT}  (POST /reason, GET /health)`));
server.on("error", err=>{
  if(err.code==="EADDRINUSE"){
    console.error(`Port ${PORT} in use — trying ${PORT+1}...`);
    app.listen(PORT+1, ()=> console.log(`Vault server on http://localhost:${PORT+1}`));
  } else throw err;
});
process.on("SIGTERM", ()=> server.close()); process.on("SIGINT", ()=> server.close());
