# ECTO-WALL 9000 — Ambient Camera Video Wall — Design Spec

**Date:** 2026-07-02
**Status:** Approved design, pending implementation plan
**Authors:** Sir Spooks-A-Lot (Claude) & Harp Dogg Millionaire (Harper)

## Overview

A static HTML website that turns a webcam into an ambient generative-art wall. The camera is never shown literally (except stylized in Echo Chamber); instead, motion, bodies, and hands drive seven visual modes that auto-cycle with long, motion-reactive crossfades. Designed to run fullscreen on a dedicated big screen / projector for hours.

## Goals

- Seven distinct ambient modes driven by camera-derived signals.
- Runs for hours unattended on a big screen: stable memory, stable framerate, recovers from camera loss and WebGL context loss.
- Static site: no build step, plain ES modules, served by a trivial local HTTP server.
- Everything stays on the machine: no frames recorded, stored, or transmitted.
- Awesome. Deep blacks, restrained palettes, slow easing, film grain — an instrument, not a screensaver.

## Non-Goals

- No audio input or output (v1 is camera-only).
- No mobile/touch support (keyboard + big screen only).
- No recording, screenshots, or sharing features.
- No server-side anything.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Display target | Big screen / TV / projector, fullscreen kiosk |
| Serving | Local HTTP server (`serve.sh`, port **44678** = "GHOST" on a phone pad) + MediaPipe from pinned CDN |
| Mode flow | Auto-cycle (default 180s dwell) with 12s motion-reactive crossfades; keyboard override |
| Rendering | Raw WebGL2, ping-pong FBOs, GPU-resident particle state; no framework |
| Vision | In-shader motion field (always on, zero deps) + MediaPipe Tasks Vision (pose / hands / segmentation) loaded per-mode from CDN |
| Language | Plain JS ES modules with JSDoc types, `// @ts-check`, `tsc --noEmit` as the type gate |

## The Modes

Global art direction: near-black base, one accent palette per mode, shared post pass (animated film grain, gentle vignette, slow ~20s luminance breathing). Nothing snaps; all parameter changes are eased.

1. **Ghost Field** — Motion accumulates into a decay buffer (30–90s half-life, slowly randomized per session). Trails age chromatically: fresh motion is cool white-cyan, aging through violet before dissolving. Motion smears directionally along its own motion vector so a walk reads as a brushstroke. *Needs: motion only.*

2. **Particle Wake** — ~130k GPU particles (position/velocity in float textures, updated in shaders) drifting in curl-noise like dust in a sunbeam. The motion field injects impulse: a passerby drags a comet-tail vortex that persists ~1 min. Color follows energy: amber drift when calm, white-hot wake cores when stirred. *Needs: motion only.*

3. **Skeleton Constellation** — Pose (≤4 people) + hand landmarks become glowing, twinkling stars joined by abstracted constellation arcs (spine line, shoulder-to-wrist sweeps — never a literal skeleton). Hands are dense sparkling clusters. When a person leaves frame, their constellation detaches, drifts upward, and dissolves into the background starfield. *Needs: pose + hands.*

4. **Room Weather** — Procedural sky (layered fbm clouds + aurora). Motion energy → wind speed; person count → color temperature (empty = cold blue dusk, crowd = warm storm-light); hand activity → lightning + brief glitch strikes; long-run activity history → slow pressure systems (a calm hour clears the skies). *Needs: motion + pose (for person count) + hands.*

5. **Silhouette Garden** — Segmentation mask seeds Gray-Scott reaction-diffusion. Bioluminescent coral/lichen blooms along silhouette edges, keeps growing after the person leaves, decays over minutes. *Needs: segmentation.*

6. **Echo Chamber** — The camera image layered as time-delayed ghosts (taps at ~1s, 3s, 7s, 15s), each tap tinted a different spectral hue, with subtle slit-scan smear. Implementation: ring buffer of 16 half-resolution frames captured at 1Hz; taps sample the ring. *Needs: camera only.*

7. **Ripple Tank** — GPU 2D wave equation. Motion drops impulses; wakes interfere; the height field refracts a dim underwater glow into caustics. Still room = black mirror. The palate cleanser. *Needs: motion only.*

**Motion-reactive crossfade:** transitions between modes use the live motion field as the dissolve threshold map — the incoming mode bleeds through first wherever people are moving. Fallback to a flat dissolve when the room is still (threshold map degenerates gracefully).

## Architecture

### File layout

```
index.html              entry point; loads js/main.js as module
css/main.css            black bg, canvas fill, HUD, start-gate styles
serve.sh                exec python3 -m http.server 44678
js/main.js              boot sequence, render loop, keyboard, resize
js/gl.js                WebGL2 helpers: shader compile/link, ping-pong FBO pairs,
                        fullscreen quad, texture upload (~200 lines)
js/signals.js           pure logic, no DOM/GL: EMA smoothing, activity history ring,
                        person/hand statistics, quality governor  ← unit-testable
js/vision.js            getUserMedia capture, camera texture, in-shader motion field,
                        MediaPipe task lifecycle/scheduler
js/modes.js             mode registry, auto-cycle scheduler, crossfade compositor
js/post.js              global grain/vignette/breathing pass
js/modes/ghost.js       one file per mode; GLSL inline as template literals
js/modes/particles.js
js/modes/constellation.js
js/modes/weather.js
js/modes/garden.js
js/modes/echo.js
js/modes/ripple.js
test/unit/*.test.js     vitest (node)
test/e2e/*.spec.js      playwright (real Chromium, fake camera device)
test/fixtures/          y4m generator script (fixture generated at test time, not committed)
package.json            dev-only deps: vitest, @playwright/test, typescript, @biomejs/biome
jsconfig.json           checkJs strict
hooks/pre-commit        lint + typecheck + unit tests; enabled via `git config core.hooksPath hooks`
CLAUDE.md               project conventions + names
README.md               setup, controls, privacy statement, tailscale/https note
```

### Mode interface

```js
/** Every mode implements: */
{
  name: 'ghost',
  needs: { pose: false, hands: false, seg: false },  // motion field is always available
  init(ctx),            // ctx: { gl, glh, width, height, camTex, motionTex, quality }
  update(dt, signals),  // signals: see below
  render(outputFbo),
  resize(width, height),
  dispose(),
}
```

### Signals (the shared nervous system)

Produced by `vision.js` + `signals.js`, consumed by modes and the crossfade compositor:

- `motionEnergy` — 0–1 scalar, EMA-smoothed. Derived from a downsampled motion-texture readback at ≤10Hz using non-blocking fenced reads (never stall the pipeline).
- `motionTex` — RG float texture (~256×144): per-pixel motion magnitude + cheap gradient-based flow direction, temporally smoothed.
- `personCount`, `poses[]` (33 landmarks each, ≤4), `hands[]` (21 landmarks each, ≤4), `handActivity` 0–1.
- `segTex` — segmentation mask texture (when running).
- `history` — ring buffer of minute-resolution activity for Room Weather's pressure systems.

### Vision scheduler

Modes declare `needs`; the scheduler runs the union of the active and incoming (during crossfade) modes' needs. MediaPipe tasks are created lazily on first need and paused when unneeded. Target inference cadences: pose ~15Hz, hands ~15Hz, segmentation ~24Hz, staggered so they never run in the same frame. MediaPipe Tasks Vision loaded from a **pinned-version CDN URL** with the GPU (WASM+WebGL) delegate.

### Render pipeline (per frame)

1. Upload camera frame to texture (mirrored horizontally — the wall behaves like a mirror).
2. Motion pass: diff vs previous frame → blur/downsample → `motionTex`.
3. Active mode `update` + `render` → FBO A. During crossfade, incoming mode → FBO B.
4. Crossfade composite (motion-threshold dissolve) → scene FBO.
5. Post pass (grain, vignette, breathing) → canvas.

### Auto-cycle

Sequential order 1→7→1. Defaults: dwell 180s, fade 12s. Query params: `?dwell=180&fade=12&mode=garden&cycle=0` (`mode` pins a starting/pinned mode; `cycle=0` disables auto-advance; short values make e2e tests fast). Keys: `1–7` pin mode, `←/→` skip (stays pinned), `a` resume auto-cycle, `f` fullscreen, `h` debug HUD.

## Kiosk Hardening

- **Start gate:** one full-screen "click to begin" panel (a user gesture is required for camera permission, fullscreen, and wake lock). Camera permission is remembered per-origin after first grant.
- **Wake lock:** `navigator.wakeLock.request('screen')`, re-acquired on `visibilitychange`.
- **Cursor** auto-hides after 3s idle.
- **WebGL context loss:** `webglcontextlost` → prevent default; `webglcontextrestored` → re-init all GPU resources (CPU-side signal state survives).
- **Camera loss:** track ended → retry `getUserMedia` every 3s; subtle HUD indicator after 10s of failure.
- **MediaPipe load failure:** modes whose `needs` can't be met are skipped by the cycle, with a console warning and HUD note — motion-only modes keep the wall alive. (Degradation is visible and logged, never silent.)
- **Quality governor** (pure function in `signals.js`): EMA fps < 45 for 3s → internal render scale ×0.5 and particle budget ×0.5; fps > 55 for 10s → restore. Hysteresis, floor ×0.25.
- **Memory discipline:** all FBOs/textures allocated at init/resize only; zero per-frame allocations in the loop.
- **Debug HUD** (`h`): fps, mode + dwell countdown, signal bars (motion / people / hands), MediaPipe status, quality scale.

## Privacy

Camera frames live only in GPU textures on the local machine. Nothing is recorded, persisted, or transmitted. The only network access is fetching static JS/WASM/model files at page load. Stated in README and on the start gate.

## Error Handling Summary

| Failure | Behavior |
|---|---|
| Camera permission denied | Full-screen gentle message + retry button |
| Camera disconnects mid-run | Auto-retry every 3s; HUD indicator after 10s |
| MediaPipe CDN unreachable | Dependent modes skipped from cycle; warning in console + HUD; motion-only modes continue |
| WebGL context lost | Full GPU re-init on restore; resume same mode |
| Sustained low fps | Quality governor downshifts resolution/particles |

## Testing

Per house rules: unit, integration, and e2e all required; no app-level mock modes; pristine output.

- **Unit (vitest, node):** `signals.js` (EMA, history ring, hand-activity stats), cycle scheduler (dwell/advance/pin/resume), crossfade envelope math, quality governor hysteresis. Pure functions, no DOM/GL.
- **Integration + e2e (playwright, real Chromium):** launched with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-video-capture=<motion.y4m>`. The y4m fixture (a moving bright blob on dark background) is generated deterministically by a checked-in node script at test setup — real getUserMedia, real WebGL, real pipeline, no mocks in app code.
  - Boots to first rendered frame; canvas pixels non-black and changing.
  - Every mode reachable via keys and renders (readPixels sanity per mode).
  - Auto-cycle advances (short `?dwell=2&fade=1`); pin/resume keys work.
  - 60s soak: zero console errors, fps counter present and sane.
  - MediaPipe-dependent specs detect CDN availability; if offline they **fail-visible as skipped with a logged reason**, never silently pass.
- **Gates:** `npm run typecheck` (tsc strict checkJs), `npm run lint` (biome), `npm test`. `hooks/pre-commit` runs lint + typecheck + unit tests.

## Performance Budgets

- Target 60fps at 1080p output on Apple Silicon; governor keeps ≥30fps worst case.
- Motion pass ≤1ms GPU; each mode ≤8ms GPU; post ≤1ms.
- MediaPipe inference async, never blocks the render loop.
- Echo ring: 16 frames at half camera resolution (~15MB) — the largest single allocation.

## Build Order (input to the implementation plan; ≤5 files per phase)

1. **Scaffold + first light:** repo files, `index.html`, `css`, `serve.sh`, `package.json`/`jsconfig`, `gl.js`, minimal `main.js` showing the mirrored camera through a shader. Proves camera + GL + serving.
2. **Nervous system + first mode:** `signals.js` (+ unit tests), motion field in `vision.js`, `post.js`, **Ghost Field**.
3. **The chassis:** `modes.js` (registry, auto-cycle, motion-reactive crossfade), **Echo Chamber** (proves chassis generality), e2e boot/cycle tests.
4. **Motion consumers:** **Particle Wake**, **Ripple Tank**.
5. **MediaPipe:** scheduler in `vision.js`, **Skeleton Constellation**.
6. **Heavy vision modes:** **Room Weather**, **Silhouette Garden**.
7. **Kiosk hardening + soak:** governor wiring, context-loss/camera-loss recovery, wake lock, HUD polish, 60s soak e2e.

## Open Notes

- Remote viewing over plain `http://<tailscale-ip>:44678` will render but **cannot access the camera** (secure-context rule: localhost or https only). For remote camera use, front it with `tailscale serve` (provides https). Documented in README.
- Mode palettes/constants live at the top of each mode file for easy tuning sessions.
