# Avocatu'

AI legal research assistant for Romanian law. Free to run: uses a free-tier API key (no card).

## Run

```bash
npm install
cp .env.example .env   # then paste your free key into .env
npm start              # http://localhost:3000
```

Free keys: Gemini at https://aistudio.google.com/apikey or Groq at https://console.groq.com/keys.
The `.env` file is gitignored, so the key never goes to GitHub.

Optional env: `PROVIDER` (gemini|groq), `GEMINI_MODEL`, `GROQ_MODEL`, `PORT`.
Free-tier limits and model names change; if a model errors, set the model env var to a current one.

## GitHub Pages

`public/` is deployed by `.github/workflows/pages.yml` on every push to `main`
(Settings -> Pages -> Source: GitHub Actions). Pages has no backend, so the chat runs in
direct mode: each visitor pastes their own free Gemini key, which stays in their browser.
With `npm start` the same UI uses the local server and `.env` key instead.

## Structure

- `server.js`: Express server, streams answers from `/api/chat` (SSE)
- `public/index.html`: landing page
- `public/chat.html`: chat UI (history kept in browser localStorage)

## Next steps

- Retrieval over legislatie.just.ro texts so cited articles are real, not recalled by the model
- Document upload and contract review
