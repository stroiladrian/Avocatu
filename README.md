# Avocatu'

AI legal research assistant for Romanian law. Free to run: uses a free-tier API key (no card).

## Run

```bash
npm install
export GEMINI_API_KEY=...     # free: https://aistudio.google.com/apikey
# or: export GROQ_API_KEY=... # free: https://console.groq.com/keys
npm start                     # http://localhost:3000
```

Optional env: `PROVIDER` (gemini|groq), `GEMINI_MODEL`, `GROQ_MODEL`, `PORT`.
Free-tier limits and model names change; if a model errors, set the model env var to a current one.

## Structure

- `server.js`: Express server, streams answers from `/api/chat` (SSE)
- `public/index.html`: landing page
- `public/chat.html`: chat UI (history kept in browser localStorage)

## Next steps

- Retrieval over legislatie.just.ro texts so cited articles are real, not recalled by the model
- Document upload and contract review
