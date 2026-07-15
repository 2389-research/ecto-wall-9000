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

## 2026-07-14 — Mic permission could never be granted on existing installs

**What happened:** Audio reactivity shipped with the mic prompt tied to the Begin click.
But the kiosk auto-skip hides the gate whenever the *camera* permission is already
durable — which is every existing install — and the auto-skip path only starts audio if
the mic is *already* granted ('prompt' was documented as "waits for the next Begin
click"). That click can never happen: the only UI that could request the mic is the UI
the auto-skip removes. Repro (throwaway spec, `test.use({ permissions: ['camera'] })`):
gate auto-skips, audio getUserMedia count stays 0 forever, clicks on the wall change
nothing. All 14 e2e stayed green because `playwright.config.js` grants BOTH permissions
globally and passes `--use-fake-ui-for-media-stream`, so the camera-granted/mic-prompt
divergence never existed in any test.

**Rules:**

1. **When a code path auto-hides UI, audit every behavior that waits on that UI.**
   "X waits for the next click of button B" is a bug the moment any path hides B.
   Grep for the element the fallback path removes; anything gated on it must have a
   reachable alternative on that path.
2. **Globally granted e2e permissions are a blind spot** (gotcha #3's inverse: the suite
   always took the *happy* path). Permission-state divergence — one granted, one
   prompt/denied — needs its own spec with a per-file `test.use({ permissions: [...] })`
   override. Playwright quirk: unlisted permissions report 'denied', not 'prompt'; same
   non-granted code path, but don't assert on the state string.
3. **Two permissions acquired in sequence are a state machine, not a boolean.** Enumerate
   all four granted×prompt combinations at design time; the spec only considered
   both-prompt and both-granted.

## 2026-07-15 — Declared the Netlify link broken; it wasn't

**What happened:** Diagnosed "site not connected to git" from three signals that each have
an innocent explanation: no repo webhooks (GitHub-App integrations deliver events through
the app, invisible to `repos/*/hooks`), no commit statuses or check runs on main (Netlify
posts those mostly on PRs/deploy previews, not production branch pushes), and an empty
retrigger commit producing no rebuild. That last one was the trap: Netlify's ignore-builds
step diffs the cached commit against the new one and **skips the build when the diff is
empty** — an empty commit is the one push guaranteed never to rebuild. Doctor Biz: main
auto-deploys; stand down.

**Rules:**

1. **Never retrigger Netlify with an empty commit** — it is skipped as no-diff by design.
   Retrigger with a real change, the UI button, or the API.
2. **Absence of webhooks/statuses is not absence of linkage.** Verify deploy wiring from
   the deploy side (deploy log, site config), not by inference from the GitHub side.
3. **Live header rules that mismatch live files suggest stale deploy/edge config, not a
   broken link.** A real rebuild refreshes the rules; escalate to Netlify only after one.
