# ECTO-WALL 9000 — Audio Reactivity — Design Spec

**Date:** 2026-07-14
**Status:** Approved design, pending implementation plan
**Authors:** Sir Spooks-A-Lot (Claude) & Harp Dogg Millionaire (Harper)
**Supersedes:** the "No audio input" non-goal in `2026-07-02-ecto-wall-design.md`

## Overview

The wall gains a second sense: a room microphone. Audio becomes new shared signals
(level, bass/mid/treble, beat) that every existing mode and the global post pass consume —
no new mode. Calm room = subtle audio breathing; music on = the wall dances. The camera
stays the protagonist; audio modulates gains. Seasoning, not sauce.

## Goals

- Ambient + beat-aware: slow loudness/band signals plus a fast onset ("beat") envelope.
- All seven modes and the post pass react to sound; each mapping small and palette-safe.
- Works with any mic in any room without calibration (adaptive gain).
- Mic is never required: denial, absence, or failure degrades to audio-at-zero, silently.
- Same privacy law as the camera: analyzed in-memory, never recorded or transmitted.

## Non-Goals

- No audio output. The wall listens; it never speaks.
- No BPM/tempo tracking — onset detection only. No key/pitch analysis.
- No spectrum GPU texture (nothing consumes it; trivial to add later).
- No new mode, no panel controls, no `needs.mic` availability filtering.
- No system-audio (loopback) capture — the mic hears the room, including its music.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Source | Room microphone via `getUserMedia({audio})` |
| Vibe | Both ambient + beat-aware (onset envelope, no BPM) |
| Where it shows | Enrich all existing modes + global post pass; no new mode |
| Architecture | New `js/audio.js` AudioEngine mirroring `vision.js`; all math pure in `signals.js` |
| Permission | On by default at the Begin gesture; degrade quietly; `?audio=0` disables |

## Architecture

### Signal flow

```
cam → Vision      (vision.js) → energyRaw, poses, hands + camTex/motionTex ─┐
mic → AudioEngine (audio.js)  → levelRaw, bandsRaw[3], fluxRaw ─────────────┤
                                                                            ▼
                                            Signals.update(inputs, dt)  [pure]
                                                                            ▼
                              motionEnergy, personCount, handActivity,
                              audioLevel, bass, mid, treble, beat
                                                                            ▼
                                         modes (ctx.signals) + post pass
```

The render loop adds `audio.update(dt)` beside `vision.update(dt)`; the reused `sigInputs`
object grows `audioLevelRaw`, `audioBandsRaw`, `audioFluxRaw`. Zero per-frame allocations:
every array is preallocated in the AudioEngine constructor.

### `js/audio.js` — AudioEngine (~150 lines)

To the microphone what `Vision` is to the camera. I/O and array plumbing only — no math.

- `start()`: `getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false,
  autoGainControl: false } })` — browser speech processing eats ambient texture and its
  AGC fights ours. Creates the `AudioContext` (inside the Begin-click gesture, so it is
  never born suspended) → `MediaStreamAudioSourceNode` → `AnalyserNode` with
  `fftSize 2048` (1024 bins, ~23 Hz/bin at 48 kHz) and `smoothingTimeConstant 0`
  (smoothing happens in `signals.js`, time-correct and testable).
- `update(dt)`: one `getByteFrequencyData` read per frame into a preallocated
  `Uint8Array`. Level, bands, and flux all derive from that single byte spectrum
  (0–255 ≈ −100..−30 dB): `levelRaw` = mean magnitude / 255; `bandsRaw` = per-band means
  over bin ranges precomputed from the real `sampleRate`; `fluxRaw` = spectral flux vs.
  the previous frame's spectrum (preallocated copy).
- Band ranges: bass 20–250 Hz, mid 250–2000 Hz, treble 2000–8000 Hz.
- Mic track ends (unplugged, OS-revoked) → internal 3 s retry loop; `micAlive` flag for
  the HUD. Unlike camera loss there is no UI consequence, so the retry stays inside the
  engine rather than in `main.js`.
- `stop()` releases the track and closes the context (test teardown; with `?audio=0` the
  engine is never constructed at all).

### Pure math — `signals.js` additions

Same law that keeps `signals.js` unit-testable today: `audio.js` owns I/O, `signals.js`
owns every number. New exports:

- `bandRanges(sampleRate, fftSize, edges)` → bin index ranges, computed once at init.
- `aggregateBands(spectrum, ranges, out)` → mean magnitude per band, written into `out`.
- `spectralFlux(cur, prev)` → sum of positive per-bin deltas, normalized by bin count.
- `class AutoGain` — per-signal floor/ceiling tracker. Floor follows the raw value down
  fast (tau 0.5 s) and up very slowly (tau 60 s) — it learns room tone, so silence reads
  as true zero. Ceiling follows up fast (tau 0.5 s) and decays down very slowly
  (tau 60 s) — it learns how loud this room gets. Output
  `clamp01((raw − floor) / max(ceil − floor, ε))`; ε guards flat input. One instance
  each for level, bass, mid, treble.
- `class OnsetDetector` — adaptive threshold: onset fires when flux exceeds
  `1.5 ×` its own running mean (EMA, tau 2 s) plus a small absolute floor, with a 120 ms
  refractory so one kick never double-fires. Output is the beat envelope: snaps to 1 on
  onset, exponential decay tau 250 ms.

`Signals` gains five smoothed fields, all 0–1, beside `motionEnergy`:

- `audioLevel` (EMA tau 0.25 s), `bass`, `mid`, `treble` (EMA tau 0.15 s — punchy but
  not jittery), `beat` (the envelope above; attack is instant by construction).
- Audio does **not** feed `pressure` (its only customer, Room Weather, is retired) and
  there is no `needs.mic`: audio is enrichment, never a requirement, so availability
  filtering is untouched.

All constants above are starting values, tunable at the top of their files per house
convention.

## Per-Mode Mappings

Each is a handful of lines in its mode file, constants at top, palette untouched.

| Mode | Mapping |
|---|---|
| Ghost Field | `beat` briefly brightens fresh trail injection; `audioLevel` nudges trail heat |
| Particle Wake | `bass` swells curl turbulence; `beat` fires a brief global impulse kick; `treble` adds sparkle jitter to hot cores |
| Ripple Tank | `beat` drops a raindrop impulse at a slowly noise-wandering point; `audioLevel` raises gentle ambient chop |
| Echo Chamber | `audioLevel` widens slit-scan smear; `beat` pops the newest tap's gain |
| Aurora Ribbons | `bass` drives curtain undulation amplitude; `beat` shimmers ribbon hue |
| Coral Bloom | `audioLevel` nudges Gray-Scott feed rate (loud room = lusher reef); `beat` sprinkles seed points like motion does |
| Silhouette Garden | `beat` sprinkles growth seeds along silhouette edges; `audioLevel` nudges growth rate |

**Global post pass:** the ~20 s luminance breathing gains a small `audioLevel`-following
component (~2%) plus a ~1.5% `beat` micro-pulse. The whole wall is audio-alive from the moment
this lands — every mode, even mid-crossfade — which lets per-mode mappings stay subtle.

The crossfade dissolve and the cycle scheduler stay audio-blind (considered
louder-room-cycles-faster; rejected — dwell already has a knob).

## Gate, Permissions, Degradation

- Begin click runs `startCamera()` then `startAudio()` — two separate `getUserMedia`
  calls in the same gesture (two prompts on first visit). Mic failure of any kind is
  swallowed: audio signals rest at zero, the wall never notices.
- Kiosk-reboot auto-skip extends symmetrically: mic auto-starts only when
  `permissions.query({ name: 'microphone' })` reports `granted`. If it reports `prompt`,
  the mic stays off until the next Begin click — never a no-gesture permission ambush.
- `?audio=0` disables audio entirely: no `getUserMedia`, no `AudioContext`.
- HUD line gains ` | audio 0.42 beat 0.9 | mic live/off`.

| Failure | Behavior |
|---|---|
| Mic permission denied | Wall runs normally, audio signals at 0, HUD `mic off` |
| Mic unplugged / OS-revoked mid-run | AudioEngine retries every 3 s, quietly |
| AudioContext unavailable | Same degrade — audio at 0, wall lives |

## Privacy

The household rule extends verbatim to sound: microphone audio is analyzed in-memory
into a handful of scalars and never recorded, stored, or transmitted. Stated on the
start gate and in the README; CLAUDE.md's camera rule becomes "camera frames and
microphone audio never leave the machine."

## Testing

Unit + e2e, no mocks in app code, per house law.

- **Unit (vitest, node):** `aggregateBands` over synthetic spectra; `AutoGain` (adapts to
  quiet and loud rooms, silence → true zero, flat input never divides by zero);
  `spectralFlux`; `OnsetDetector` (periodic spikes in noise fire beats, refractory
  prevents double-fires, envelope attack/decay); `Signals.update` with audio inputs.
- **E2E (playwright, real Chromium):** Chromium's existing fake-device flag also fakes
  audio — add `--use-file-for-fake-audio-capture=<beats.wav>`. The WAV fixture
  (2 s silence, then loud periodic thumps at ≥2 Hz) is generated at test time by a
  checked-in node script, exactly like the y4m. Permission grants via playwright context
  options (`camera` + `microphone`).
  - Audio signals move from 0 when the thumps start (via HUD text); beat fires.
  - `?audio=0` keeps audio at 0 through the same fixture.
  - Camera-granted-but-mic-denied context still boots and cycles — the degradation
    path gets a real first-class test (gotcha #3: no always-fallback blind spots).
- **Gates:** `npm run typecheck`, `npm run lint`, `npm test`, pre-commit hook — unchanged.

## Performance

One 1024-bin `getByteFrequencyData` read plus a few array walks per frame — microseconds
of CPU; GPU cost is a few new uniforms. No budget changes. Zero per-frame allocations.

## Files Touched

New `js/audio.js`; `js/signals.js` (pure math + Signals fields); `js/main.js` (gate,
wiring, HUD); `js/post.js`; all 7 `js/modes/*.js` (small); `index.html` + `README.md` +
`CLAUDE.md` (copy); new unit tests, WAV fixture script, e2e spec.

## Build Order (input to the implementation plan; ≤5 files per phase)

1. **Pure math:** `signals.js` additions + unit tests. No I/O, all green before any audio
   hardware exists.
2. **The ear:** `audio.js`, `main.js` wiring (gate, sigInputs, HUD, `?audio=0`),
   `index.html` gate copy. The HUD proves the wall hears.
3. **Global glow + proof:** `post.js` breathing, WAV fixture script, e2e specs
   (signals-move, `audio=0`, mic-denied).
4. **Motion-mode wiring:** `ripple.js`, `particle.js`, `ghost.js`, `echo.js`.
5. **Remaining modes + copy:** `aurora.js`, `coral.js`, `garden.js`, `README.md`,
   `CLAUDE.md`.
