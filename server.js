const express = require("express");
const path = require("path");

// Load keys from a local .env file (gitignored). Real environment variables take priority.
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Free-tier providers (no card needed). Set ONE of these keys:
//   GEMINI_API_KEY  -> https://aistudio.google.com/apikey
//   GROQ_API_KEY    -> https://console.groq.com/keys
// Model names can change; override with GEMINI_MODEL / GROQ_MODEL if needed.
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;
const PROVIDER = process.env.PROVIDER || (GEMINI_KEY ? "gemini" : GROQ_KEY ? "groq" : null);
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

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

// Reads an SSE response body and calls onData(jsonString) for each "data:" line.
async function readSSE(resp, onData) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const d = line.slice(5).trim();
        if (d && d !== "[DONE]") onData(d);
      }
    }
  }
}

async function streamGemini(messages, emit, model = GEMINI_MODEL) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens: 1500 },
    }),
  });
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  await readSSE(resp, (d) => {
    const j = JSON.parse(d);
    const parts = j.candidates?.[0]?.content?.parts || [];
    const t = parts.map((p) => p.text || "").join("");
    if (t) emit(t);
  });
}

async function streamGroq(messages, emit) {
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      stream: true,
      max_tokens: 1500,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
    }),
  });
  if (!resp.ok) throw new Error(`Groq ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  await readSSE(resp, (d) => {
    const t = JSON.parse(d).choices?.[0]?.delta?.content;
    if (t) emit(t);
  });
}

let fallbackCache = null;
// Other Gemini flash models this key can use, for when the main one is overloaded.
async function geminiFallbacks() {
  if (fallbackCache) return fallbackCache;
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
      headers: { "x-goog-api-key": GEMINI_KEY },
    });
    const j = await r.json();
    fallbackCache = (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace("models/", ""))
      .filter((n) => /flash/i.test(n) && !/image|tts|live|audio|embed|robotics/i.test(n) && n !== GEMINI_MODEL)
      .slice(0, 3);
  } catch {
    fallbackCache = [];
  }
  return fallbackCache;
}

const isTransient = (err) => /\b(503|429|500|404)\b/.test(err.message);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.get("/api/health", (req, res) => res.json({ ok: true, provider: PROVIDER }));

app.post("/api/chat", async (req, res) => {
  if (!PROVIDER) {
    return res.status(503).json({
      error: "Lipsește cheia API. Setează GEMINI_API_KEY sau GROQ_API_KEY (gratuit) și repornește serverul.",
    });
  }
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "messages lipsește" });
  }
  const clean = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  let started = false;
  const emit = (t) => {
    started = true;
    res.write(`data: ${JSON.stringify({ t })}\n\n`);
  };
  try {
    // Free tiers often return 503/429 in demand spikes. Retry, then fall back before any text is sent.
    const plan = [];
    if (PROVIDER === "gemini") {
      plan.push({ name: GEMINI_MODEL, run: () => streamGemini(clean, emit, GEMINI_MODEL), retries: [1500, 3500] });
      for (const m of await geminiFallbacks()) {
        plan.push({ name: m, run: () => streamGemini(clean, emit, m), retries: [] });
      }
      if (GROQ_KEY) plan.push({ name: "groq", run: () => streamGroq(clean, emit), retries: [] });
    } else {
      plan.push({ name: GROQ_MODEL, run: () => streamGroq(clean, emit), retries: [1500, 3500] });
    }
    let lastErr;
    let ok = false;
    for (const step of plan) {
      for (let attempt = 0; attempt <= step.retries.length; attempt++) {
        try {
          await step.run();
          ok = true;
          break;
        } catch (err) {
          lastErr = err;
          if (!isTransient(err) || started) throw err;
          console.log(`[${step.name}] ${err.message.slice(0, 70).replace(/\s+/g, " ")}`);
          if (attempt < step.retries.length) await sleep(step.retries[attempt]);
        }
      }
      if (ok) break;
    }
    if (!ok) throw lastErr;
    res.write("data: [DONE]\n\n");
  } catch (e) {
    console.error(e.message);
    const rate = /429/.test(e.message);
    res.write(
      `data: ${JSON.stringify({
        error: rate
          ? "Limita gratuită a fost atinsă. Încearcă din nou peste un minut."
          : "Eroare: " + e.message.replace(/\s+/g, " ").slice(0, 350),
      })}\n\n`
    );
  }
  res.end();
});

const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log(`Avocatu' pornit pe http://localhost:${port} (provider: ${PROVIDER || "niciunul"})`)
);
