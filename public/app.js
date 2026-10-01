(() => {
"use strict";
const $ = (id) => document.getElementById(id);
const app = $("app"), msgs = $("msgs"), log = $("log");
const chatInput = $("chatInput"), sendBtn = $("send");
const HISTORY_KEY = "avocatu_history_v1";
const KEY_NAME = "avocatu_gemini_key";
const PRIMARY_MODEL = "gemini-3.8-flash";
const G = "https://generativelanguage.googleapis.com/v1beta/models";

const SYSTEM = `Ești Avocatu', un asistent juridic virtual specializat în legislația din România.
Reguli:
- Răspunde în limba utilizatorului (implicit română), clar, pe înțelesul unui nespecialist, dar riguros.
- Structura răspunsului: (1) răspuns scurt, (2) explicație, (3) temei legal cu articole concrete
  (ex: Codul civil, art. X; Codul muncii, art. Y; Legea nr. 31/1990, art. Z), (4) pași practici.
- Citează doar texte legale despre care ești sigur. Dacă nu ești sigur de numărul unui articol sau de
  versiunea în vigoare, spune explicit asta și recomandă verificarea pe legislatie.just.ro.
- Nu inventa articole, hotărâri sau jurisprudență.
- Semnalează când legislația ar fi putut fi modificată recent.
- La final, pentru situații complexe sau litigii, recomandă consultarea unui avocat. Nu ești un avocat
  și nu oferi reprezentare sau consultanță juridică personalizată.`;

let history = [];
try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch { history = []; }
if (!Array.isArray(history)) history = [];
let mode = "unknown"; // "server" (Express backend) | "direct" (browser -> Gemini, e.g. GitHub Pages)
let busy = false;

const saveHistory = () => { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- tiny UI helpers ---------- */
let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 2200);
}

// Escape first, then format a safe subset of markdown.
function md(text) {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (l) => l
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  const out = []; let list = false;
  for (const raw of esc.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (!list) { out.push("<ul>"); list = true; }
      out.push("<li>" + inline(m[1]) + "</li>");
      continue;
    }
    if (list) { out.push("</ul>"); list = false; }
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) out.push("<h4>" + inline(m[1]) + "</h4>");
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) out.push("<hr>");
    else if (line.trim() === "") out.push("");
    else out.push("<p>" + inline(line) + "</p>");
  }
  if (list) out.push("</ul>");
  return out.join("");
}

function scrollDown() { log.scrollTop = log.scrollHeight; }

function bubble(role, text, cls) {
  const d = document.createElement("div");
  d.className = "msg " + (role === "user" ? "user" : "bot") + (cls ? " " + cls : "");
  if (role === "user" || cls) d.textContent = text; else d.innerHTML = md(text);
  msgs.appendChild(d);
  scrollDown();
  return d;
}

function showHome() {
  app.dataset.view = "home";
  msgs.innerHTML = "";
  $("homeInput").focus({ preventScroll: true });
}

function showChat() {
  app.dataset.view = "chat";
}

function render() {
  msgs.innerHTML = "";
  if (!history.length) return showHome();
  history.forEach((m) => bubble(m.role, m.content));
  showChat();
}

/* ---------- mode detection ---------- */
async function detectMode() {
  try {
    const r = await fetch("api/health", { cache: "no-store" });
    const ct = r.headers.get("content-type") || "";
    mode = r.ok && ct.includes("json") ? "server" : "direct";
  } catch { mode = "direct"; }
}

/* ---------- key dialog (direct mode) ---------- */
const dlg = $("dlg");
const readKey = () => { try { return localStorage.getItem(KEY_NAME) || ""; } catch { return ""; } };
const writeKey = (k) => { try { k ? localStorage.setItem(KEY_NAME, k) : localStorage.removeItem(KEY_NAME); } catch {} };

function openDialog({ needKey }) {
  return new Promise((resolve) => {
    const isServer = mode === "server";
    $("dlgTitle").textContent = needKey ? "Cheie Gemini necesară" : "Setări";
    $("keyRow").style.display = isServer ? "none" : "";
    $("dlgSave").style.display = isServer ? "none" : "";
    $("dlgForget").style.display = !isServer && readKey() ? "" : "none";
    $("dlgText").textContent = isServer
      ? "Chatul folosește serverul tău local. Cheia API se află în fișierul .env din folderul proiectului."
      : needKey
        ? "Pagina rulează fără server, deci are nevoie de cheia ta gratuită Gemini ca să poată răspunde."
        : readKey() ? "O cheie este salvată în acest browser. Poți să o înlocuiești sau să o ștergi."
                    : "Nicio cheie salvată încă.";
    $("keyInput").value = "";
    dlg.returnValue = "";
    dlg.addEventListener("close", () => {
      const v = dlg.returnValue;
      if (v === "save") writeKey($("keyInput").value.trim());
      if (v === "forget") writeKey("");
      resolve(v === "save" ? readKey() : "");
    }, { once: true });
    dlg.showModal();
    if (!isServer) $("keyInput").focus();
  });
}

async function ensureKey() {
  const k = readKey();
  if (k) return k;
  const got = await openDialog({ needKey: true });
  if (!got) throw new Error("Este nevoie de o cheie Gemini gratuită pentru a folosi chatul pe această pagină.");
  return got;
}

/* ---------- direct Gemini (browser -> Google) ---------- */
async function callGemini(model, key, messages, onText) {
  const r = await fetch(`${G}/${model}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: 1500 },
    }),
  });
  if (!r.ok) {
    const e = new Error(`Gemini ${r.status}: ` + (await r.text()).replace(/\s+/g, " ").slice(0, 250));
    e.status = r.status;
    throw e;
  }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop();
    for (const l of lines) {
      if (!l.startsWith("data:")) continue;
      const d = l.slice(5).trim(); if (!d) continue;
      const parts = JSON.parse(d).candidates?.[0]?.content?.parts || [];
      const t = parts.map((p) => p.text || "").join("");
      if (t) onText(t);
    }
  }
}

async function directGemini(messages, onText) {
  const key = await ensureKey();
  let started = false;
  const emit = (t) => { started = true; onText(t); };
  const transient = (e) => [503, 429, 500, 404].includes(e.status);
  const tryModel = async (model, retries) => {
    for (let a = 0; ; a++) {
      try { await callGemini(model, key, messages, emit); return true; }
      catch (e) {
        if (e.status === 400 || e.status === 403) {
          writeKey("");
          throw new Error("Cheia Gemini nu este validă. Deschide Setări și adaugă o cheie nouă.");
        }
        if (!transient(e) || started) throw e;
        if (a >= retries) return false;
        await sleep(1500 * (a + 1));
      }
    }
  };
  if (await tryModel(PRIMARY_MODEL, 2)) return;
  let others = [];
  try {
    const j = await (await fetch(`${G}?pageSize=200`, { headers: { "x-goog-api-key": key } })).json();
    others = (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace("models/", ""))
      .filter((n) => /flash/i.test(n) && !/image|tts|live|audio|embed|robotics/i.test(n) && n !== PRIMARY_MODEL)
      .slice(0, 3);
  } catch {}
  for (const m of others) if (await tryModel(m, 0)) return;
  throw new Error("Modelele gratuite sunt aglomerate acum. Încearcă din nou peste un minut.");
}

/* ---------- server mode (Express, SSE) ---------- */
async function serverChat(messages, onText) {
  const r = await fetch("api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || "Eroare de server");
  }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n"); buf = parts.pop();
    for (const p of parts) {
      if (!p.startsWith("data: ")) continue;
      const data = p.slice(6);
      if (data === "[DONE]") continue;
      const j = JSON.parse(data);
      if (j.error) throw new Error(j.error);
      if (j.t) onText(j.t);
    }
  }
}

/* ---------- ask ---------- */
async function ask(text) {
  text = (text || "").trim();
  if (!text || busy) return;
  busy = true; sendBtn.disabled = true;
  if (mode === "unknown") await detectMode();

  history.push({ role: "user", content: text });
  if (app.dataset.view !== "chat") { msgs.innerHTML = ""; showChat(); }
  bubble("user", text);
  const out = bubble("assistant", "…");
  let acc = "";
  const onText = (t) => { acc += t; out.innerHTML = md(acc); scrollDown(); };
  try {
    if (mode === "server") await serverChat(history, onText);
    else await directGemini(history, onText);
    history.push({ role: "assistant", content: acc });
    saveHistory();
  } catch (e) {
    history.pop();
    out.className = "msg bot err";
    out.textContent = e.message;
  } finally {
    busy = false; sendBtn.disabled = false;
    chatInput.focus({ preventScroll: true });
  }
}

/* ---------- wiring ---------- */
$("homeForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const i = $("homeInput"); const v = i.value; i.value = "";
  ask(v);
});
$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = chatInput.value; chatInput.value = ""; chatInput.style.height = "auto";
  ask(v);
});
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chatForm").requestSubmit(); }
});
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
});
document.querySelectorAll("[data-q]").forEach((b) => b.addEventListener("click", () => ask(b.dataset.q)));
document.querySelectorAll("[data-soon]").forEach((b) => b.addEventListener("click", (e) => {
  e.preventDefault();
  toast(b.dataset.soon + " vor fi disponibile în curând.");
}));

function newConversation() {
  if (busy) return;
  history = []; saveHistory(); showHome();
}
$("newChat").addEventListener("click", newConversation);
$("clearHist").addEventListener("click", () => { newConversation(); toast("Istoricul a fost șters."); });
$("navChat").addEventListener("click", (e) => { e.preventDefault(); history.length ? showChat() : showHome(); });
$("collapse").addEventListener("click", () => app.classList.toggle("collapsed"));
async function openSettings(e) {
  if (e) e.preventDefault();
  if (mode === "unknown") await detectMode();
  openDialog({ needKey: false });
}
$("settings").addEventListener("click", openSettings);
document.querySelectorAll(".settingsLink").forEach((a) => a.addEventListener("click", openSettings));
$("composerNew").addEventListener("click", newConversation);
/* ---------- start ---------- */
render();
detectMode();
const q = new URLSearchParams(location.search).get("q");
if (q) {
  history = []; saveHistory(); showHome();
  try { window.history.replaceState(null, "", location.pathname); } catch {}
  ask(q);
}
})();
