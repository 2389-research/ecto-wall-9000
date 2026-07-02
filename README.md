# ECTO-WALL 9000 👻

An ambient, camera-driven generative video wall for a big screen, TV, or projector.
Point it at a room and the room paints it: motion becomes ghosts, wakes, ripples,
auroras, coral reefs, and gardens. Nobody "uses" it — it just hangs there being alive.

Static site. No build step. Raw WebGL2 + MediaPipe Tasks Vision, plain ES modules.

## Quick start

```sh
./serve.sh          # serves on port 44678 ("GHOST" on a phone pad)
```

Open <http://localhost:44678>, click **begin**, grant the camera.
Press `f` for fullscreen and walk away.

The camera needs a secure context: `localhost` works out of the box; for a remote
machine, front it with `tailscale serve` (or any https proxy) rather than plain http.

## The seven modes

The wall auto-cycles with slow crossfades (default: 3 minutes per mode, 12 s fades).

| # | Mode | What the room does to it |
|---|------|--------------------------|
| 1 | `ghost-field` | Motion deposits soft presence that advects along the optical flow, diffuses, and ages through a chromatic palette over ~a minute. |
| 2 | `particle-wake` | A fixed population of GPU particles drifts on curl noise; walkers inject velocity and tow glowing wakes through the field. |
| 3 | `ripple-tank` | A wave-equation water surface; your movement is a moving wave source, and the camera's world refracts through dark water. |
| 4 | `echo-chamber` | A ring of once-per-second snapshots replayed at 1/3/7/15 s taps — only *differences* from the present glow, in spectral tints. |
| 5 | `aurora-ribbons` | Light calligraphy: your head, hands, and feet paint hue-coded ribbons that rise and waver like an aurora before fading. Empty rooms keep dim procedural curtains. |
| 6 | `coral-bloom` | A Gray-Scott reaction-diffusion reef where motion seeds living coral growth; feed/kill rates drift so the colony keeps renegotiating its own shape. |
| 7 | `silhouette-garden` | Gray-Scott reaction-diffusion coral-moss sown along the edges of people's silhouettes; growth matures, then composts back to soil. |

Modes 5 and 7 use MediaPipe (pose, segmentation) loaded lazily from a CDN. If the
CDN is unreachable the wall degrades gracefully: those modes leave the roster and the
motion-only modes keep running.

## Controls

| Key | Action |
|-----|--------|
| `1`–`7` | Pin a specific mode |
| `→` / `←` | Next / previous mode (pins) |
| `a` | Resume auto-cycling |
| `h` | Toggle the diagnostics HUD |
| `f` | Toggle fullscreen |

Move the mouse and a floating panel appears along the bottom edge with the same
controls as buttons — mode pins, prev/next, auto, HUD, and fullscreen. It fades
out (along with the cursor) after a few seconds of stillness.

A locale-aware clock floats near the top of the wall, screensaver style — time and
date formatted however the browser's locale says (12/24h included).

Query parameters: `?mode=ripple-tank` (pin from boot), `?dwell=180` (seconds per mode),
`?fade=12` (crossfade seconds), `?cycle=0` (disable auto-cycling), `?clock=0` (hide
the overlay clock).

## Kiosk deployment

Built to run for weeks unattended:

- **Camera gate auto-skip** — once the camera permission is durable, reboots go straight
  to the wall with no click.
- **WebGL context-loss recovery** — a dead GL context triggers a clean reload
  (all state is ambient by design), with exponential backoff so a sick GPU isn't thrashed.
- **Camera loss recovery** — an unplugged/revoked camera is retried quietly every 3 s
  while the wall keeps rendering on ambient drift.
- **Screen wake lock** — held and re-acquired on visibility changes; state shows in the HUD.
- **Quality governor** — sustained low fps halves the render scale (floor 320×180) and
  recovers upward when headroom returns.
- **Precision hygiene** — shader time wraps hourly; accumulators wrap; no unbounded floats.

Suggested kiosk launch (macOS/Linux, Chromium-family):

```sh
chromium --kiosk --autoplay-policy=no-user-gesture-required \
  --use-fake-ui-for-media-stream http://localhost:44678
```

(`--use-fake-ui-for-media-stream` auto-grants the camera prompt; alternatively grant it
once by hand — the permission persists.)

## Privacy

Camera frames never leave the machine. There is no recording, no transmission, no
storage — frames live in GPU textures for exactly as long as an effect needs them.
MediaPipe inference runs locally (models are fetched from a CDN once and cached).

## Development

```sh
npm install
npm test                # unit (vitest) + e2e (playwright, fake y4m camera)
npm run test:unit
npm run test:e2e
npm run typecheck       # tsc strict checkJs, no emit
npm run lint            # biome
```

Plain JavaScript ES modules with JSDoc types and `// @ts-check` everywhere; the
pre-commit hook runs biome → tsc → vitest. The e2e suite drives real Chromium with a
generated y4m fixture (a bright blob orbiting on a lissajous path) so the motion
pipeline sees genuine optical flow — including a 60 s soak that churns every mode
through init/dispose with a zero-console-error gate.

### Map

```
index.html            start gate, canvas, HUD
js/main.js            boot + conductor: render loop, keyboard, HUD, quality governor
js/gl.js              WebGL2 helpers: programs, targets, ping-pong, uploads, noise GLSL
js/vision.js          camera capture, motion field, async readback, lazy MediaPipe tasks
js/signals.js         pure logic core (unit-tested): smoothing, geometry, scheduler, governor
js/modes.js           ModeManager: lazy init/dispose, crossfades, availability
js/modes/*.js         one self-contained file per mode (GLSL inline)
js/post.js            shared grain / vignette / slow luminance breathing
js/kiosk.js           context-loss reload policy + screen wake lock
test/unit/            vitest specs for the pure logic
test/e2e/             playwright specs + y4m fixture generator
```

Design spec: `docs/superpowers/specs/2026-07-02-ecto-wall-design.md`.

## Requirements

WebGL2 with `EXT_color_buffer_float` (any GPU from the last decade), a webcam, and a
Chromium-family browser for the smoothest ride. Firefox and Safari work for the
motion-only modes; MediaPipe GPU delegate support varies.

---

Built by Sir Spooks-A-Lot for Harp Dogg Millionaire. 👻📺
