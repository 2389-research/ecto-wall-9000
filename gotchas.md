# Gotchas

Lessons converted into rules after real breakage. Read at session start.

## 2026-07-02 — Deleting a module broke every stale-cached client

**What happened:** The coral/aurora roster swap was this repo's first module *deletion*
(`constellation.js`, `weather.js`). `serve.sh` was plain `python3 -m http.server`, which
sends `Last-Modified` but no `Cache-Control`, so browsers heuristically cache `main.js`
without revalidating. Any client holding a pre-swap `main.js` 404'd on the deleted
imports, the whole ES-module graph died, and the begin button (whose listener lives in
that graph) went silently inert. All 24 gates were green because the e2e web server was a
*different* server than serve.sh, and the gate always auto-skipped (permission
pre-granted), so the button's click path was never exercised.

**Rules:**

1. **Renaming or deleting a module is a deploy-compatibility event, not just a refactor.**
   Any importer cached by a client must either revalidate (no-cache headers) or fail
   loudly (module-script `onerror`). Check both exist before shipping a deletion.
2. **The e2e web server must be the real server.** If tests run against a stand-in,
   server behavior (headers, MIME, 404s) is unverified. `playwright.config.js` runs
   `./serve.sh` — keep it that way.
3. **A test that always takes the fallback path is a blind spot.** `passGate` auto-skips
   the gate in every spec; the button click needed its own first-visit test (stub
   `navigator.permissions.query` → `'prompt'`).
4. **`hidden` is a suggestion, not a law.** Any element whose CSS sets `display` beats
   the UA's `[hidden] { display: none }`. If you style a hideable element's `display`,
   also write `#thing[hidden] { display: none; }` — and assert hiding with playwright's
   `toBeHidden()` (real visibility), not `hasAttribute('hidden')`. Corollary:
   `waitForSelector('#thing[hidden]')` defaults to state `'visible'` and only ever
   resolved *because* of this bug — wait for `('#thing', { state: 'hidden' })` instead.
