# Audio Reactivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ECTO-WALL 9000 a second sense — a room microphone whose loudness, band energy, and beat onsets enrich all seven modes and the global post pass, degrading silently to zero whenever the mic is denied, absent, or disabled.

**Architecture:** A new `js/audio.js` AudioEngine mirrors `js/vision.js` (I/O + preallocated arrays only); every number is derived by pure, unit-tested math added to `js/signals.js` (`bandRanges`, `aggregateBands`, `spectrumLevel`, `spectralFlux`, `AutoGain`, `OnsetDetector`). `Signals` gains five smoothed 0–1 fields (`audioLevel`, `bass`, `mid`, `treble`, `beat`) that modes read from `ctx.signals` exactly like `motionEnergy` — no Mode interface change. E2E proof drives Chromium's fake audio device with a generated silence-then-thumps WAV.

**Tech Stack:** Plain JS ES modules + JSDoc (`// @ts-check`), Web Audio `AnalyserNode`, raw WebGL2 (GLSL inline in mode files), vitest, Playwright. No build step, no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-07-14-audio-reactivity-design.md` (approved). Tasks 1–3 are the spec's build-order phase 1, tasks 4–5 phase 2, tasks 6–7 phase 3, tasks 8–9 phase 4, tasks 10–12 phase 5.

## Global Constraints

- All work happens on branch `feat/audio-reactivity` (created in Task 1). Never commit to `main`.
- Read `gotchas.md` at session start.
- Every JS file starts with two `// ABOUTME: ` lines and has `// @ts-check`.
- Zero per-frame allocations in the render loop — preallocate every array/object; swap references, never copy or create.
- `js/signals.js` stays pure: no DOM, no WebGL, no Web Audio imports — it must run under vitest in node.
- GLSL lives inline in each mode file as template literals; tunable constants at the top of their file.
- Microphone audio (like camera frames) never leaves the machine: analyzed in-memory into scalars, never recorded, stored, or transmitted. Don't add any pathway that could.
- Audio is enrichment, never a requirement: no `needs.mic`, no availability filtering, no panel controls, no BPM tracking, no audio output. Audio does **not** feed `Signals.pressure`.
- Mic constraints must disable browser speech processing: `echoCancellation: false, noiseSuppression: false, autoGainControl: false`.
- Exact starting constants (all tunable at top-of-file): fftSize 2048, smoothingTimeConstant 0, band edges 20/250/2000/8000 Hz, AutoGain fast tau 0.5 s / slow tau 60 s / minSpan 0.02, onset sensitivity 1.5× / mean tau 2 s / refractory 120 ms / decay tau 250 ms / flux floor 0.005, signal EMA taus 0.25 s (level) and 0.15 s (bands), post pass ~2% level + ~1.5% beat.
- Gates before every commit: `npm run typecheck`, `npm run lint`, `npm run test:unit` (the pre-commit hook runs biome → tsc → vitest; NEVER bypass it). Run the e2e suites named in each task before calling the task done.
- If biome complains about import ordering, run `npm run lint:fix` and re-check the result.
- Conventional commits, imperative present tense.

**Testing posture (read this once):** All audio *math* is TDD'd in vitest (Tasks 1–3, 10). The I/O and GPU shells (`audio.js`, `main.js` wiring, `post.js`, mode uniforms) follow the repo's existing posture: like `vision.js`, they carry no unit tests because unit-testing them would mean mocking `getUserMedia`/WebGL — and house law forbids testing mocked behavior. They are covered end-to-end by Playwright in a real Chromium with a real fake-device audio pipeline (Task 6), plus the existing console-clean + brightness gates that catch shader compile failures in every mode.

## File Map

| File | Role in this feature |
|---|---|
| `js/signals.js` | + pure audio math (band ranges, aggregation, level, flux, AutoGain, OnsetDetector) and 5 new Signals fields |
| `js/audio.js` | NEW — AudioEngine: mic capture, AnalyserNode, per-frame spectrum read → raw scalars |
| `js/main.js` | construct + start engine (gate click / kiosk auto-skip), feed sigInputs, HUD, `?audio=0` |
| `index.html` | gate privacy copy covers the mic |
| `js/post.js` | breathe multiplier gains audioLevel + beat components |
| `js/modes/{ripple,ghost,particle,echo,coral,aurora,garden}.js` | small per-mode mappings (see spec table) |
| `test/unit/signals.test.js` | + audio math + Signals audio tests |
| `test/unit/coral.test.js` | updated signatures + beat-seeding tests |
| `test/e2e/global-setup.mjs` | + WAV fixture generator (silence → thumps) |
| `playwright.config.js` | + microphone permission + fake-audio-capture flag |
| `test/e2e/audio.spec.mjs` | NEW — hears / mic-denied / `?audio=0` |
| `README.md`, `CLAUDE.md` | copy: privacy, query params, map |

---

### Task 1: Pure audio math — bands, level, flux

**Files:**
- Modify: `js/signals.js` (insert a new audio section between the `QualityGovernor` class and the `Signals` class, i.e. immediately after the line `}` that closes `QualityGovernor` at ~line 280 and before the `/** The room's smoothed nervous system...` comment)
- Test: `test/unit/signals.test.js` (append new describes at the end of the file)

**Interfaces:**
- Consumes: existing `ema(prev, next, dt, tau)` and module-private `clamp01(x)` in `js/signals.js` (nothing else).
- Produces (later tasks call these exactly as written):
  - `bandRanges(sampleRate: number, fftSize: number, edges: number[]) → [number, number][]` — per band `[startBin, endBin)`, DC bin skipped.
  - `aggregateBands(spectrum: Uint8Array, ranges: [number, number][], out: Float32Array) → Float32Array` — mean magnitude per band, 0–1, written into `out`.
  - `spectrumLevel(spectrum: Uint8Array) → number` — mean magnitude 0–1.
  - `spectralFlux(cur: Uint8Array, prev: Uint8Array) → number` — mean positive per-bin rise, 0–1.

- [ ] **Step 1: Create the feature branch**

```bash
git checkout -b feat/audio-reactivity
```

- [ ] **Step 2: Write the failing tests**

Extend the import at the top of `test/unit/signals.test.js` — keep the existing names in place and append the four new ones (biome does not enforce specifier order here; the existing order is already unsorted):

```js
import {
  CycleScheduler,
  camToDisp,
  coverMap,
  ema,
  fadeEnvelope,
  HistoryRing,
  QualityGovernor,
  Signals,
  aggregateBands,
  bandRanges,
  spectralFlux,
  spectrumLevel,
} from '../../js/signals.js';
```

Then append the new describes at the end of the file:

```js
describe('bandRanges', () => {
  it('maps Hz edges to FFT bin ranges, skipping the DC bin', () => {
    // 48kHz / 2048 fftSize → 23.4375 Hz per bin, 1024 bins total.
    const r = bandRanges(48000, 2048, [20, 250, 2000, 8000]);
    expect(r.length).toBe(3);
    expect(r[0]).toEqual([1, 11]); // 20Hz sits inside bin 0 (DC) — clamped up to bin 1
    expect(r[1]).toEqual([11, 86]);
    expect(r[2]).toEqual([86, 342]);
  });

  it('never exceeds the bin count and never produces an empty band', () => {
    const r = bandRanges(8000, 2048, [20, 250, 2000, 8000]); // 8kHz edge = Nyquist exactly
    for (const [lo, hi] of r) {
      expect(lo).toBeGreaterThanOrEqual(1);
      expect(hi).toBeGreaterThan(lo);
      expect(hi).toBeLessThanOrEqual(1024);
    }
  });
});

describe('aggregateBands', () => {
  it('averages magnitudes per band into 0-1 without allocating', () => {
    const spec = new Uint8Array(1024);
    spec.fill(255, 1, 11); // bass bins fully hot
    const out = new Float32Array(3);
    const ret = aggregateBands(spec, [[1, 11], [11, 86], [86, 342]], out);
    expect(ret).toBe(out);
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });
});

describe('spectrumLevel', () => {
  it('is the mean magnitude 0-1', () => {
    expect(spectrumLevel(new Uint8Array([0, 255, 255, 0]))).toBeCloseTo(0.5, 6);
    expect(spectrumLevel(new Uint8Array(16))).toBe(0);
  });
});

describe('spectralFlux', () => {
  it('sums only positive bin rises, normalized by bin count', () => {
    const prev = new Uint8Array([10, 20, 30, 40]);
    const cur = new Uint8Array([20, 10, 30, 60]);
    // rises: +10 (bin 0) and +20 (bin 3) → 30 / (255 * 4)
    expect(spectralFlux(cur, prev)).toBeCloseTo(30 / (255 * 4), 6);
  });

  it('is zero for identical spectra and for pure decay', () => {
    const a = new Uint8Array([50, 50]);
    expect(spectralFlux(a, a)).toBe(0);
    expect(spectralFlux(new Uint8Array([10, 10]), new Uint8Array([200, 200]))).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL — `bandRanges is not a function` (or missing export) for the new describes; every pre-existing test still green.

- [ ] **Step 4: Implement the four functions**

Insert into `js/signals.js` after the closing `}` of `QualityGovernor` and before the `Signals` class comment:

```js
// --- audio ---------------------------------------------------------------------------------

/**
 * FFT bin index ranges for a set of band edges, computed once at init.
 * Bin k covers frequencies around k * sampleRate / fftSize; bin 0 (DC) is skipped.
 * @param {number} sampleRate
 * @param {number} fftSize
 * @param {number[]} edges band boundaries in Hz, e.g. [20, 250, 2000, 8000]
 * @returns {[number, number][]} per band: [start bin, end bin) — start inclusive, end exclusive
 */
export function bandRanges(sampleRate, fftSize, edges) {
  const bins = fftSize / 2;
  /** @type {[number, number][]} */
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = Math.max(1, Math.min(bins - 1, Math.ceil((edges[i] * fftSize) / sampleRate)));
    const hi = Math.max(lo + 1, Math.min(bins, Math.ceil((edges[i + 1] * fftSize) / sampleRate)));
    out.push([lo, hi]);
  }
  return out;
}

/**
 * Mean magnitude per band, 0–1, written into out — no allocation, safe per-frame.
 * @param {Uint8Array} spectrum byte magnitudes from an AnalyserNode
 * @param {[number, number][]} ranges from bandRanges()
 * @param {Float32Array} out one slot per band
 */
export function aggregateBands(spectrum, ranges, out) {
  for (let i = 0; i < ranges.length; i++) {
    const lo = ranges[i][0];
    const hi = ranges[i][1];
    let sum = 0;
    for (let k = lo; k < hi; k++) sum += spectrum[k];
    out[i] = sum / ((hi - lo) * 255);
  }
  return out;
}

/**
 * Mean magnitude of the whole spectrum, 0–1 — the room's raw loudness.
 * @param {Uint8Array} spectrum
 */
export function spectrumLevel(spectrum) {
  let sum = 0;
  for (let i = 0; i < spectrum.length; i++) sum += spectrum[i];
  return sum / (spectrum.length * 255);
}

/**
 * Spectral flux: mean positive per-bin rise between consecutive spectra, 0–1.
 * Rises only — energy arriving reads as an onset; energy leaving reads as nothing.
 * @param {Uint8Array} cur
 * @param {Uint8Array} prev
 */
export function spectralFlux(cur, prev) {
  let sum = 0;
  for (let i = 0; i < cur.length; i++) {
    const d = cur[i] - prev[i];
    if (d > 0) sum += d;
  }
  return sum / (cur.length * 255);
}
```

Also update the file's second ABOUTME line to cover the new territory:

```js
// ABOUTME: Smoothing, camera→display geometry, activity history, cycle scheduling, quality governor, audio math.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:unit`
Expected: PASS, all describes green.

- [ ] **Step 6: Gates and commit**

```bash
npm run typecheck && npm run lint
git add js/signals.js test/unit/signals.test.js
git commit -m "feat: add pure audio band/level/flux math to the signal core"
```

---

### Task 2: AutoGain and OnsetDetector

**Files:**
- Modify: `js/signals.js` (append to the audio section created in Task 1, still before the `Signals` class)
- Test: `test/unit/signals.test.js`

**Interfaces:**
- Consumes: `ema`, `clamp01` from `js/signals.js` (module scope).
- Produces:
  - `class AutoGain { constructor(opts?: {floorFall?: number, floorRise?: number, ceilRise?: number, ceilFall?: number, minSpan?: number}); update(raw: number, dt: number): number }` — returns normalized 0–1; first call primes to the first sample and returns 0.
  - `class OnsetDetector { constructor(opts?: {sensitivity?: number, avgTau?: number, decayTau?: number, refractory?: number, fluxFloor?: number}); update(flux: number, dt: number): number }` — returns the beat envelope 0–1 (snaps to 1 on onset, exponential decay); first call primes the running mean and never fires.

- [ ] **Step 1: Write the failing tests**

Extend the same import in `test/unit/signals.test.js` with the two new classes (final statement):

```js
import {
  CycleScheduler,
  camToDisp,
  coverMap,
  ema,
  fadeEnvelope,
  HistoryRing,
  QualityGovernor,
  Signals,
  aggregateBands,
  AutoGain,
  bandRanges,
  OnsetDetector,
  spectralFlux,
  spectrumLevel,
} from '../../js/signals.js';
```

Append:

```js
describe('AutoGain', () => {
  /** Train on alternating base/peak, then read back the normalized base and peak. */
  const train = (g, base, peak) => {
    for (let i = 0; i < 1200; i++) g.update(i % 20 < 2 ? peak : base, 1 / 60);
    return [g.update(base, 1 / 60), g.update(peak, 1 / 60)];
  };

  it('reads silence as true zero from the very first frame', () => {
    const g = new AutoGain();
    expect(g.update(0, 1 / 60)).toBe(0);
    for (let i = 0; i < 300; i++) expect(g.update(0, 1 / 60)).toBe(0);
  });

  it('adapts its range so loud and quiet rooms normalize alike', () => {
    const [loudBase, loudPeak] = train(new AutoGain(), 0.3, 0.9);
    const [quietBase, quietPeak] = train(new AutoGain(), 0.03, 0.09);
    expect(loudBase).toBeLessThan(0.35);
    expect(loudPeak).toBeGreaterThan(0.6);
    expect(quietBase).toBeLessThan(0.35);
    expect(quietPeak).toBeGreaterThan(0.6);
  });

  it('flat input never divides by zero and reads as quiet', () => {
    const g = new AutoGain();
    let v = 1;
    for (let i = 0; i < 600; i++) v = g.update(0.5, 1 / 60);
    expect(Number.isNaN(v)).toBe(false);
    expect(v).toBe(0);
  });
});

describe('OnsetDetector', () => {
  /** Settle the running mean on a steady noise floor. */
  const settle = (d, flux = 0.01, frames = 120) => {
    for (let i = 0; i < frames; i++) d.update(flux, 1 / 60);
  };

  it('stays silent on a steady noise floor', () => {
    const d = new OnsetDetector();
    settle(d);
    expect(d.update(0.01, 1 / 60)).toBe(0);
  });

  it('fires on a flux spike and decays over ~a quarter second', () => {
    const d = new OnsetDetector();
    settle(d);
    expect(d.update(0.2, 1 / 60)).toBe(1);
    let v = 1;
    for (let i = 0; i < 30; i++) v = d.update(0.01, 1 / 60); // 0.5s = 2 decay taus
    expect(v).toBeLessThan(0.2);
    expect(v).toBeGreaterThan(0.05);
  });

  it('the refractory blocks an immediate double-fire but not a later one', () => {
    const d = new OnsetDetector();
    settle(d);
    expect(d.update(0.3, 1 / 60)).toBe(1);
    expect(d.update(0.3, 1 / 60)).toBeLessThan(1); // 17ms later: inside the 120ms refractory
    for (let i = 0; i < 10; i++) d.update(0.01, 1 / 60); // 167ms — refractory expired
    expect(d.update(0.3, 1 / 60)).toBe(1);
  });

  it('sustained loud flux stops firing — it is not an onset if it never ends', () => {
    const d = new OnsetDetector();
    settle(d, 0.01, 60);
    for (let i = 0; i < 600; i++) d.update(0.2, 1 / 60); // 10s of constant loud flux
    const a = d.update(0.2, 1 / 60);
    const b = d.update(0.2, 1 / 60);
    expect(a).toBeLessThan(0.01); // adapted: threshold rose above the plateau
    expect(b).toBeLessThan(a); // and the envelope keeps decaying
  });

  it('ignores tiny flux below the absolute floor even from silence', () => {
    const d = new OnsetDetector();
    settle(d, 0, 120);
    expect(d.update(0.004, 1 / 60)).toBe(0); // below fluxFloor 0.005
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL — `AutoGain is not a constructor` / missing export.

- [ ] **Step 3: Implement the two classes**

Append to the audio section of `js/signals.js` (after `spectralFlux`, before the `Signals` class comment):

```js
/**
 * Per-signal adaptive normalizer: learns a floor (room tone) and a ceiling (how loud this
 * room gets) so any mic in any room maps onto the same 0–1 range with no calibration.
 * The floor chases the raw value down fast and up very slowly; the ceiling is the mirror.
 * Silence therefore reads as true zero within moments of the room going quiet.
 */
export class AutoGain {
  /** @param {{floorFall?: number, floorRise?: number, ceilRise?: number, ceilFall?: number, minSpan?: number}} [opts] taus in seconds */
  constructor(opts = {}) {
    const { floorFall = 0.5, floorRise = 60, ceilRise = 0.5, ceilFall = 60, minSpan = 0.02 } = opts;
    this.floorFall = floorFall;
    this.floorRise = floorRise;
    this.ceilRise = ceilRise;
    this.ceilFall = ceilFall;
    this.minSpan = minSpan;
    this.floor = 0;
    this.ceil = minSpan;
    this._primed = false;
  }

  /**
   * Feed one raw sample, get the normalized 0–1 value.
   * @param {number} raw @param {number} dt
   */
  update(raw, dt) {
    if (!this._primed) {
      // Snap to the first sample so a quiet room reads zero immediately instead of
      // after a minute of slow floor-learning.
      this.floor = raw;
      this.ceil = raw + this.minSpan;
      this._primed = true;
      return 0;
    }
    this.floor = ema(this.floor, raw, dt, raw < this.floor ? this.floorFall : this.floorRise);
    this.ceil = ema(this.ceil, raw, dt, raw > this.ceil ? this.ceilRise : this.ceilFall);
    if (this.ceil < this.floor + this.minSpan) this.ceil = this.floor + this.minSpan;
    return clamp01((raw - this.floor) / (this.ceil - this.floor));
  }
}

/**
 * Onset detector + beat envelope. An onset fires when spectral flux beats an adaptive
 * threshold (a multiple of its own running mean, above an absolute floor), with a short
 * refractory so one kick drum never double-fires. The envelope snaps to 1 on onset and
 * decays exponentially — attack is instant by construction.
 */
export class OnsetDetector {
  /** @param {{sensitivity?: number, avgTau?: number, decayTau?: number, refractory?: number, fluxFloor?: number}} [opts] */
  constructor(opts = {}) {
    const {
      sensitivity = 1.5,
      avgTau = 2,
      decayTau = 0.25,
      refractory = 0.12,
      fluxFloor = 0.005,
    } = opts;
    this.sensitivity = sensitivity;
    this.avgTau = avgTau;
    this.decayTau = decayTau;
    this.refractory = refractory;
    this.fluxFloor = fluxFloor;
    this.avg = 0;
    this.beat = 0;
    this._primed = false;
    this._sinceOnset = Infinity;
  }

  /**
   * Feed one flux sample, get the beat envelope 0–1.
   * @param {number} flux @param {number} dt
   */
  update(flux, dt) {
    this._sinceOnset += dt;
    this.beat *= Math.exp(-dt / this.decayTau);
    if (!this._primed) {
      // Prime the running mean on the first sample so mic turn-on isn't a beat.
      this.avg = flux;
      this._primed = true;
      return this.beat;
    }
    const fires =
      flux > this.fluxFloor &&
      flux > this.avg * this.sensitivity &&
      this._sinceOnset >= this.refractory;
    this.avg = ema(this.avg, flux, dt, this.avgTau);
    if (fires) {
      this.beat = 1;
      this._sinceOnset = 0;
    }
    return this.beat;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck && npm run lint
git add js/signals.js test/unit/signals.test.js
git commit -m "feat: add AutoGain and OnsetDetector to the signal core"
```

---

### Task 3: Signals grows its audio senses

**Files:**
- Modify: `js/signals.js` (the `Signals` class: constructor, `update()` head + body, class JSDoc)
- Test: `test/unit/signals.test.js`

**Interfaces:**
- Consumes: `AutoGain`, `OnsetDetector`, `ema` (same module).
- Produces (every mode and `main.js` read these):
  - `Signals.audioLevel`, `Signals.bass`, `Signals.mid`, `Signals.treble`, `Signals.beat` — all numbers 0–1, resting at exact 0 with no audio input.
  - `Signals.update(inputs, dt)` accepts three new optional fields: `audioLevelRaw?: number`, `audioBandsRaw?: Float32Array` (length 3: bass/mid/treble), `audioFluxRaw?: number`.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('Signals', ...)` block in `test/unit/signals.test.js`:

```js
  it('audio at rest reads exact zero with no special-casing', () => {
    const s = new Signals();
    for (let i = 0; i < 300; i++) s.update({ energyRaw: 0, poses: [], hands: [] }, 1 / 60);
    expect(s.audioLevel).toBe(0);
    expect(s.bass).toBe(0);
    expect(s.mid).toBe(0);
    expect(s.treble).toBe(0);
    expect(s.beat).toBe(0);
  });

  it('normalizes level through adaptive gain: peaks read high, room tone reads low', () => {
    const s = new Signals();
    const bands = new Float32Array(3);
    const inp = { energyRaw: 0, poses: [], hands: [], audioLevelRaw: 0.3, audioBandsRaw: bands, audioFluxRaw: 0 };
    for (let i = 0; i < 1200; i++) {
      inp.audioLevelRaw = i % 20 < 2 ? 0.9 : 0.3;
      s.update(inp, 1 / 60);
    }
    inp.audioLevelRaw = 0.9; // hold a peak so the short smoothing EMA catches up
    for (let i = 0; i < 30; i++) s.update(inp, 1 / 60);
    expect(s.audioLevel).toBeGreaterThan(0.5);
    inp.audioLevelRaw = 0.3; // back to room tone
    for (let i = 0; i < 60; i++) s.update(inp, 1 / 60);
    expect(s.audioLevel).toBeLessThan(0.2);
  });

  it('fires beat from a flux spike and decays it', () => {
    const s = new Signals();
    const bands = new Float32Array(3);
    const inp = { energyRaw: 0, poses: [], hands: [], audioLevelRaw: 0, audioBandsRaw: bands, audioFluxRaw: 0.01 };
    for (let i = 0; i < 120; i++) s.update(inp, 1 / 60);
    inp.audioFluxRaw = 0.3;
    s.update(inp, 1 / 60);
    expect(s.beat).toBe(1);
    inp.audioFluxRaw = 0.01;
    for (let i = 0; i < 30; i++) s.update(inp, 1 / 60);
    expect(s.beat).toBeLessThan(0.2);
  });

  it('routes each band through its own gain', () => {
    const s = new Signals();
    const bands = new Float32Array(3);
    const inp = { energyRaw: 0, poses: [], hands: [], audioLevelRaw: 0, audioBandsRaw: bands, audioFluxRaw: 0 };
    for (let i = 0; i < 1200; i++) {
      bands[0] = i % 20 < 2 ? 0.8 : 0.1; // bass pulses
      bands[1] = 0.1; // mid flat
      bands[2] = 0; // treble silent
      s.update(inp, 1 / 60);
    }
    bands[0] = 0.8;
    for (let i = 0; i < 30; i++) s.update(inp, 1 / 60);
    expect(s.bass).toBeGreaterThan(0.5);
    expect(s.mid).toBeLessThan(0.1); // flat input normalizes to quiet
    expect(s.treble).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL — `expect(s.audioLevel).toBe(0)` gets `undefined`.

- [ ] **Step 3: Implement the Signals additions**

In `js/signals.js`, add near `clamp01` (module scope, top of file, after the `clamp01` function):

```js
// Default audio bands when no mic input arrives; shared and never written.
const ZERO_BANDS = new Float32Array(3);
```

Replace the `Signals` class JSDoc:

```js
/**
 * The room's smoothed nervous system. Fed raw per-frame inputs, exposes eased values
 * every mode reads: motionEnergy, personCount, handActivity, long-run pressure, and the
 * audio senses — audioLevel, bass, mid, treble, and the beat envelope.
 */
```

In the constructor, after `this._lastMatched = 0;` add:

```js
    this.audioLevel = 0;
    this.bass = 0;
    this.mid = 0;
    this.treble = 0;
    this.beat = 0;
    this._levelGain = new AutoGain();
    this._bandGains = [new AutoGain(), new AutoGain(), new AutoGain()];
    this._onset = new OnsetDetector();
```

Replace the `update` JSDoc and destructure:

```js
  /**
   * @param {{energyRaw?: number, poses?: {x: number, y: number}[][], hands?: {x: number, y: number}[][], audioLevelRaw?: number, audioBandsRaw?: Float32Array, audioFluxRaw?: number}} inputs
   * @param {number} dt
   */
  update(inputs, dt) {
    const {
      energyRaw = 0,
      poses = [],
      hands = [],
      audioLevelRaw = 0,
      audioBandsRaw = ZERO_BANDS,
      audioFluxRaw = 0,
    } = inputs;
```

At the end of `update`, immediately before `this.history.push(this.motionEnergy, dt);`, add:

```js
    // Audio: each raw signal through its own adaptive gain, then a short smoothing EMA.
    // With no mic these inputs sit at zero and every field rests at exact zero.
    this.audioLevel = ema(this.audioLevel, this._levelGain.update(audioLevelRaw, dt), dt, 0.25);
    this.bass = ema(this.bass, this._bandGains[0].update(audioBandsRaw[0], dt), dt, 0.15);
    this.mid = ema(this.mid, this._bandGains[1].update(audioBandsRaw[1], dt), dt, 0.15);
    this.treble = ema(this.treble, this._bandGains[2].update(audioBandsRaw[2], dt), dt, 0.15);
    this.beat = this._onset.update(audioFluxRaw, dt);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:unit`
Expected: PASS (including all pre-existing Signals tests — the new inputs are optional).

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck && npm run lint
git add js/signals.js test/unit/signals.test.js
git commit -m "feat: give Signals audio senses - level, bands, beat envelope"
```

---

### Task 4: AudioEngine — the wall's ear

**Files:**
- Create: `js/audio.js`

**Interfaces:**
- Consumes: `aggregateBands`, `bandRanges`, `spectralFlux`, `spectrumLevel` from `js/signals.js` (Task 1 signatures).
- Produces (main.js relies on these exactly):
  - `class AudioEngine { constructor(); start(): Promise<void>; update(dt: number): void; stop(): void; levelRaw: number; bandsRaw: Float32Array; fluxRaw: number; micAlive: boolean }`
  - Constructor performs no I/O (bare arrays only) — safe to construct even under `?audio=0`.
  - `start()` may reject (permission denied, no mic, no AudioContext); caller owns the catch.
  - After mic loss (`ended` track event) the engine retries itself every 3 s inside `update()`; a rejected `start()` never arms the retry (no re-prompt loops).

**Testing note:** No unit tests — this file is pure I/O plumbing around `getUserMedia`/`AnalyserNode` (the same posture as `vision.js`), and mocking those would violate the no-mocked-behavior law. The real pipeline is exercised end-to-end in Task 6 with Chromium's fake audio device. Gate for this task: typecheck + lint + existing suites stay green.

- [ ] **Step 1: Write the file**

Create `js/audio.js`:

```js
// ABOUTME: The wall's ear: microphone capture and per-frame FFT analysis. I/O and array
// ABOUTME: plumbing only — every number it derives comes from pure math in signals.js.
// @ts-check
import { aggregateBands, bandRanges, spectralFlux, spectrumLevel } from './signals.js';

const FFT_SIZE = 2048; // 1024 bins, ~23 Hz/bin at 48 kHz
const BAND_EDGES = [20, 250, 2000, 8000]; // bass | mid | treble boundaries in Hz
const RETRY_S = 3; // seconds between reacquire attempts after mic loss

/**
 * To the microphone what Vision is to the camera. start() asks for the mic and builds the
 * analysis chain; update(dt) reads one byte spectrum per frame and derives the raw
 * level/band/flux scalars Signals consumes. Everything is preallocated — the render loop
 * allocates nothing. Audio never leaves this object: no recording, no transmission.
 */
export class AudioEngine {
  constructor() {
    this.levelRaw = 0;
    this.bandsRaw = new Float32Array(3);
    this.fluxRaw = 0;
    this.micAlive = false;
    /** @type {AudioContext | null} */
    this._ctx = null;
    /** @type {AnalyserNode | null} */
    this._analyser = null;
    /** @type {MediaStreamAudioSourceNode | null} */
    this._source = null;
    /** @type {MediaStream | null} */
    this._stream = null;
    this._spectrum = new Uint8Array(FFT_SIZE / 2);
    this._prev = new Uint8Array(FFT_SIZE / 2);
    /** @type {[number, number][]} */
    this._ranges = [];
    this._warm = false; // the first frame after (re)start has no previous spectrum for flux
    this._retry = false; // armed only by mic loss, never by a denied start
    this._retryT = 0;
    /** @type {Promise<void> | null} */
    this._starting = null;
  }

  /** Idempotent while a start is in flight — callers can race freely. */
  start() {
    this._starting ??= this._start().finally(() => {
      this._starting = null;
    });
    return this._starting;
  }

  async _start() {
    // Browser speech processing (echo cancel, noise suppression, AGC) eats the ambient
    // texture we render and fights our own adaptive gain — ask for the raw room.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (this._stream) for (const t of this._stream.getTracks()) t.stop();
    this._stream = stream;
    // Normally created inside the Begin-click gesture so it is never born suspended;
    // the kiosk auto-start has no gesture, so resume() covers that path too.
    this._ctx ??= new AudioContext();
    if (this._ctx.state === 'suspended') await this._ctx.resume();
    if (!this._analyser) {
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = FFT_SIZE;
      this._analyser.smoothingTimeConstant = 0; // smoothing lives in signals.js, time-correct
      this._ranges = bandRanges(this._ctx.sampleRate, FFT_SIZE, BAND_EDGES);
    }
    this._source?.disconnect();
    this._source = this._ctx.createMediaStreamSource(stream);
    this._source.connect(this._analyser);
    this._warm = false;
    this.micAlive = true;
    const track = stream.getAudioTracks()[0];
    track.addEventListener('ended', () => {
      // Mic unplugged or OS-revoked. No UI consequence — retry quietly from update().
      this.micAlive = false;
      this._retry = true;
      this._retryT = RETRY_S;
    });
  }

  /** @param {number} dt */
  update(dt) {
    if (!this.micAlive || !this._analyser) {
      this.levelRaw = 0;
      this.bandsRaw.fill(0);
      this.fluxRaw = 0;
      if (this._retry) {
        this._retryT -= dt;
        if (this._retryT <= 0) {
          this._retryT = RETRY_S;
          this.start().catch(() => {
            // still gone; keep trying — the wall lives fine deaf
          });
        }
      }
      return;
    }
    // Swap current/previous spectra so flux compares frames without copying.
    const prev = this._prev;
    this._prev = this._spectrum;
    this._spectrum = prev;
    this._analyser.getByteFrequencyData(this._spectrum);
    this.levelRaw = spectrumLevel(this._spectrum);
    aggregateBands(this._spectrum, this._ranges, this.bandsRaw);
    this.fluxRaw = this._warm ? spectralFlux(this._spectrum, this._prev) : 0;
    this._warm = true;
  }

  /** Release the mic and close the context (test teardown; the wall itself never stops). */
  stop() {
    this._retry = false;
    this.micAlive = false;
    if (this._stream) for (const t of this._stream.getTracks()) t.stop();
    this._stream = null;
    this._source?.disconnect();
    this._source = null;
    this._ctx?.close().catch(() => {});
    this._ctx = null;
    this._analyser = null;
  }
}
```

- [ ] **Step 2: Gates**

Run: `npm run typecheck && npm run lint && npm run test:unit`
Expected: all green (nothing imports the file yet).

- [ ] **Step 3: Commit**

```bash
git add js/audio.js
git commit -m "feat: add AudioEngine, the wall's microphone ear"
```

---

### Task 5: Boot wiring — gate, render loop, HUD, ?audio=0

**Files:**
- Modify: `js/main.js`
- Modify: `index.html` (gate privacy copy)

**Interfaces:**
- Consumes: `AudioEngine` from `js/audio.js` (Task 4); `Signals.update` audio inputs (Task 3).
- Produces:
  - HUD line format (Task 6's e2e regexes depend on it, verbatim): `... | mp <status> | audio 0.00 beat 0.00 | cam live | mic live | wake on` — i.e. new segments `` | audio ${x.toFixed(2)} beat ${y.toFixed(2)}`` and `` | mic ${live|off}``.
  - `?audio=0` (or `audio=false`): the engine is never started — no `getUserMedia({audio})`, no `AudioContext`.
  - `startCamera(): Promise<boolean>` now returns success (internal change; callers in this file only).

- [ ] **Step 1: Wire the engine into `js/main.js`**

1a. Add the import (first relative import; biome sorts `./audio.js` before `./clock.js`):

```js
import { AudioEngine } from './audio.js';
```

1b. After the existing line `const clockOn = !(clockParam === '0' || clockParam === 'false');` add:

```js
const audioParam = query.get('audio');
const audioOn = !(audioParam === '0' || audioParam === 'false');
```

1c. After the `const vision = new Vision(gl, 640, 360);` line add:

```js
// The wall's ear. Constructed unconditionally (bare arrays, no I/O) — with ?audio=0 it is
// simply never started, so no getUserMedia and no AudioContext ever exist.
const audio = new AudioEngine();
```

1d. Replace the whole `startCamera` function with:

```js
async function startCamera() {
  gateError.hidden = true;
  try {
    await vision.start();
    gate.classList.add('leaving');
    setTimeout(() => gate.setAttribute('hidden', ''), 1700);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    gateError.textContent = `Camera unavailable: ${msg}`;
    gateError.hidden = false;
    return false;
  }
}

// Mic failure of any kind is swallowed: audio signals rest at zero, the wall never notices.
async function startAudio() {
  if (!audioOn) return;
  try {
    await audio.start();
  } catch (err) {
    console.warn('[main] mic unavailable - audio signals rest at zero:', err);
  }
}
```

1e. Replace `startBtn.addEventListener('click', startCamera);` with:

```js
startBtn.addEventListener('click', async () => {
  // Camera then mic: two separate getUserMedia calls in the same gesture, so a denied
  // mic can never take the camera down with it.
  if (await startCamera()) await startAudio();
});
```

1f. Replace the gate auto-skip IIFE (the whole `(async () => { ... })();` block under the comment "Skip the gate entirely...") with:

```js
// Skip the gate entirely when the camera permission is already durable (kiosk reboot case).
(async () => {
  let camGranted = false;
  try {
    const st = await navigator.permissions.query({
      name: /** @type {PermissionName} */ ('camera'),
    });
    camGranted = st.state === 'granted';
  } catch {
    // permissions API unsupported for camera — the gate stays, which is fine
  }
  if (!camGranted || !(await startCamera())) return;
  // The mic joins only when its permission is durable too: an auto-start has no user
  // gesture, so a prompt here would ambush the room. 'prompt' waits for the next click.
  try {
    const mic = await navigator.permissions.query({
      name: /** @type {PermissionName} */ ('microphone'),
    });
    if (mic.state === 'granted') await startAudio();
  } catch {
    // permissions API unsupported for microphone — stay deaf until a Begin click
  }
})();
```

1g. In the HUD `setInterval`, replace the last two template lines:

```js
    ` | hands ${signals.handActivity.toFixed(2)} | mp ${vision.mpStatus}` +
    ` | cam ${vision.cameraAlive ? 'live' : 'off'} | wake ${wake.held ? 'on' : 'off'}`;
```

with:

```js
    ` | hands ${signals.handActivity.toFixed(2)} | mp ${vision.mpStatus}` +
    ` | audio ${signals.audioLevel.toFixed(2)} beat ${signals.beat.toFixed(2)}` +
    ` | cam ${vision.cameraAlive ? 'live' : 'off'} | mic ${audio.micAlive ? 'live' : 'off'}` +
    ` | wake ${wake.held ? 'on' : 'off'}`;
```

1h. Extend `sigInputs` (keep the "Reused every frame" comment):

```js
const sigInputs = {
  energyRaw: 0,
  poses: /** @type {{x: number, y: number, vis: number}[][]} */ ([]),
  hands: /** @type {{x: number, y: number}[][]} */ ([]),
  audioLevelRaw: 0,
  audioBandsRaw: new Float32Array(3),
  audioFluxRaw: 0,
};
```

1i. In `frame()`, replace:

```js
  vision.update(dt);
  sigInputs.energyRaw = vision.energyRaw;
  sigInputs.poses = vision.poses;
  sigInputs.hands = vision.hands;
  signals.update(sigInputs, dt);
```

with:

```js
  vision.update(dt);
  audio.update(dt);
  sigInputs.energyRaw = vision.energyRaw;
  sigInputs.poses = vision.poses;
  sigInputs.hands = vision.hands;
  sigInputs.audioLevelRaw = audio.levelRaw;
  sigInputs.audioBandsRaw = audio.bandsRaw;
  sigInputs.audioFluxRaw = audio.fluxRaw;
  signals.update(sigInputs, dt);
```

(Assigning `audio.bandsRaw` is a reference swap of a preallocated array — no copy, no allocation.)

- [ ] **Step 2: Update the gate copy in `index.html`**

Replace:

```html
      <p class="privacy">
        The camera feeds this screen and nothing else.<br />
        No frames are recorded, stored, or transmitted.
      </p>
```

with:

```html
      <p class="privacy">
        The camera and microphone feed this screen and nothing else.<br />
        Nothing is recorded, stored, or transmitted.
      </p>
```

- [ ] **Step 3: Gates — including the existing e2e boot + first-visit specs**

```bash
npm run typecheck && npm run lint && npm run test:unit
npx playwright test -g "boots|first visit"
```

Expected: all green — "first visit" drives the new Begin-click path (camera then mic in one gesture). (This e2e run has no mic permission or fake-audio fixture yet — `--use-fake-ui-for-media-stream` may grant the mic anyway; either way `startAudio` swallows failure as a console *warning*, which `watchConsole` does not treat as an error.)

- [ ] **Step 4: Commit**

```bash
git add js/main.js index.html
git commit -m "feat: wire audio into boot - gate flow, render loop, HUD, ?audio=0"
```

---

### Task 6: E2E proof — WAV fixture, config, audio spec

**Files:**
- Modify: `test/e2e/global-setup.mjs` (add the WAV generator)
- Modify: `playwright.config.js` (mic permission + fake-audio flag)
- Create: `test/e2e/audio.spec.mjs`

**Interfaces:**
- Consumes: HUD format from Task 5 (`audio 0.00`, `beat 0.00`, `mic live`/`mic off`); helpers `watchConsole` (returns `{errors, warnings}`), `passGate`, `brightness`, `hudText` from `test/e2e/helpers.mjs`.
- Produces: `test/e2e/fixtures/beats.wav` — 90 s mono 16-bit 44.1 kHz PCM: 2 s of silence, then a 110 Hz decaying thump every 500 ms (generated at test time, git-ignored alongside the y4m).

- [ ] **Step 1: Add the WAV generator to `test/e2e/global-setup.mjs`**

Replace the two ABOUTME lines:

```js
// ABOUTME: Generates the fake-capture fixtures: a y4m moving-blob orbit for the camera and
// ABOUTME: a silence-then-thumps WAV for the microphone, so e2e gets real signal to chew on.
```

After the `const FRAMES = 120; ...` line, add:

```js
const WAV_OUT = fileURLToPath(new URL('./fixtures/beats.wav', import.meta.url));

// Audio fixture: 2s of silence, then a 110Hz decaying thump every 500ms — enough silence
// up front to watch the signals rise from zero, enough onsets for the beat detector.
// Chromium loops the file, but 90s outlives every assertion even if it never loops.
const SR = 44100;
const WAV_SECONDS = 90;
const LEAD_IN_S = 2;
const THUMP_EVERY_S = 0.5;

function generateWav() {
  const n = SR * WAV_SECONDS;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (t < LEAD_IN_S) continue;
    const tt = (t - LEAD_IN_S) % THUMP_EVERY_S;
    if (tt < 0.1) {
      const env = Math.exp(-tt / 0.03);
      pcm[i] = Math.round(Math.sin(2 * Math.PI * 110 * tt) * env * 0.8 * 32767);
    }
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // linear PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  Buffer.from(pcm.buffer).copy(buf, 44);
  mkdirSync(dirname(WAV_OUT), { recursive: true });
  writeFileSync(WAV_OUT, buf);
}
```

Replace the default export:

```js
export default function globalSetup() {
  if (!existsSync(OUT)) generate();
  if (!existsSync(WAV_OUT)) generateWav();
}
```

- [ ] **Step 2: Point Chromium's fake mic at it in `playwright.config.js`**

Replace the fixture const:

```js
const CAM_FIXTURE = fileURLToPath(new URL('./test/e2e/fixtures/blob.y4m', import.meta.url));
const MIC_FIXTURE = fileURLToPath(new URL('./test/e2e/fixtures/beats.wav', import.meta.url));
```

(`FIXTURE` is config-local — the only other reference is the `--use-file-for-fake-video-capture` line below; update it.)

Replace `permissions: ['camera'],` with:

```js
    permissions: ['camera', 'microphone'],
```

Replace the launch args:

```js
      args: [
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${CAM_FIXTURE}`,
        `--use-file-for-fake-audio-capture=${MIC_FIXTURE}`,
        '--use-fake-ui-for-media-stream',
      ],
```

Also update the config's second ABOUTME line:

```js
// ABOUTME: points Chromium's fake camera and mic at generated blob.y4m / beats.wav fixtures.
```

- [ ] **Step 3: Write the audio e2e spec**

Create `test/e2e/audio.spec.mjs`:

```js
// ABOUTME: E2E for audio reactivity — the HUD proves the wall hears the fake-mic thumps,
// ABOUTME: and the mic-denied / ?audio=0 paths degrade to audio-at-zero without breaking boot.
import { expect, test } from '@playwright/test';
import { brightness, hudText, passGate, watchConsole } from './helpers.mjs';

/**
 * Pull a labeled number out of the HUD line, e.g. hudNum(page, 'audio') → 0.42.
 * Returns -1 when the label is absent so failed polls read obviously wrong.
 * @param {import('@playwright/test').Page} page @param {string} label
 */
async function hudNum(page, label) {
  const m = (await hudText(page)).match(new RegExp(`${label} (\\d+(?:\\.\\d+)?)`));
  return m ? Number(m[1]) : -1;
}

test('the wall hears: level rises and beats fire on the thump track', async ({ page }) => {
  const con = watchConsole(page);
  await page.goto('/?mode=ripple-tank');
  await passGate(page);
  await page.keyboard.press('h');

  await expect.poll(() => hudText(page), { timeout: 15_000 }).toContain('mic live');
  // The fixture opens with 2s of silence, then thumps every 500ms.
  await expect.poll(() => hudNum(page, 'audio'), { timeout: 20_000 }).toBeGreaterThan(0.05);
  // The beat envelope snaps to 1 per thump and decays with tau 250ms; the HUD samples
  // every 500ms, so polling catches a fresh spike within a few thumps.
  await expect.poll(() => hudNum(page, 'beat'), { timeout: 20_000 }).toBeGreaterThan(0.2);
  expect(con.errors).toEqual([]);
});

test('mic denied: the wall boots, cycles, and audio rests at zero', async ({ page }) => {
  const con = watchConsole(page);
  // Reject only audio getUserMedia, exactly like a user clicking "Block" on the mic
  // prompt — the camera call passes through untouched (gotcha #3: the degradation
  // path gets a first-class test, not an accidental-fallback one).
  await page.addInitScript(() => {
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) =>
      c && c.audio
        ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
        : orig(c);
  });
  await page.goto('/?dwell=2&fade=1');
  await passGate(page);
  await page.keyboard.press('h');

  await expect.poll(() => hudText(page), { timeout: 10_000 }).toContain('mic off');
  await expect.poll(() => brightness(page), { timeout: 15_000 }).toBeGreaterThan(1);
  expect(await hudNum(page, 'audio')).toBe(0);
  expect(await hudNum(page, 'beat')).toBe(0);

  // Deaf, not dead: the cycle keeps turning (same probe as the auto-cycle spec).
  const seen = new Set();
  for (let i = 0; i < 15 && seen.size < 2; i++) {
    const m = (await hudText(page)).match(/:: ([a-z-]+)/);
    if (m) seen.add(m[1]);
    await page.waitForTimeout(1000);
  }
  expect(seen.size).toBeGreaterThanOrEqual(2);
  expect(con.errors).toEqual([]); // the mic failure surfaces as a warning, never an error
});

test('?audio=0 disables audio entirely: no mic request, no AudioContext', async ({ page }) => {
  // Count (not mock) the audio entry points; real calls pass straight through.
  await page.addInitScript(() => {
    window.__micRequests = 0;
    window.__audioCtxCount = 0;
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => {
      if (c && c.audio) window.__micRequests += 1;
      return orig(c);
    };
    const AC = window.AudioContext;
    window.AudioContext = class extends AC {
      constructor() {
        super();
        window.__audioCtxCount += 1;
      }
    };
  });
  await page.goto('/?audio=0&mode=ripple-tank');
  await passGate(page);
  await page.keyboard.press('h');

  await expect.poll(() => hudText(page), { timeout: 10_000 }).toContain('mic off');
  await page.waitForTimeout(4000); // the thump track is now well past its lead-in silence
  expect(await hudNum(page, 'audio')).toBe(0);
  expect(await hudNum(page, 'beat')).toBe(0);
  expect(await page.evaluate(() => window.__micRequests)).toBe(0);
  expect(await page.evaluate(() => window.__audioCtxCount)).toBe(0);
});
```

- [ ] **Step 4: Run the new spec**

```bash
npx playwright test test/e2e/audio.spec.mjs
```

Expected: PASS — global setup generates `beats.wav` on first run, and Tasks 4–5 already built the pipeline this spec proves. If `mic live` never appears or the signals stay at zero, debug the engine/wiring — do not weaken the assertions.

- [ ] **Step 5: Run the full e2e suite**

Run: `npm run test:e2e`
Expected: PASS — existing specs (boot, modes, cycle, soak, first-visit) unaffected by the new permission + flag.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/global-setup.mjs playwright.config.js test/e2e/audio.spec.mjs
git commit -m "test: e2e audio proof - fake-mic thumps, denial, ?audio=0"
```

---

### Task 7: Post pass — the whole wall breathes with the room's sound

**Files:**
- Modify: `js/post.js` (render signature + breathe math)
- Modify: `js/main.js` (one call site)

**Interfaces:**
- Consumes: `signals.audioLevel`, `signals.beat` (Task 3).
- Produces: `Post.render(sceneTex: WebGLTexture, t: number, audioLevel?: number, beat?: number)` — extra args default to 0, so audio-less callers are unchanged.

**Testing note:** GL-only change, covered by the e2e brightness + console gates (existing posture for `post.js`, which has no unit tests).

- [ ] **Step 1: Extend `Post.render`**

In `js/post.js`, replace the render JSDoc + signature + breathe line:

```js
  /**
   * Render the scene texture to the canvas with the film pass applied.
   * @param {WebGLTexture} sceneTex
   * @param {number} t seconds (wrapped)
   * @param {number} [audioLevel] room loudness 0–1
   * @param {number} [beat] onset envelope 0–1
   */
  render(sceneTex, t, audioLevel = 0, beat = 0) {
    const gl = this.gl;
    bindTarget(gl, null);
    // The slow ~20s breath, plus the room's sound: ~2% loudness swell, ~1.5% beat pulse.
    const breathe =
      (1 + 0.02 * Math.sin((2 * Math.PI * t) / 20)) * (1 + 0.02 * audioLevel + 0.015 * beat);
```

And update the shader comment above `c *= uBreathe;` from `// slow luminance breathing (computed on CPU, ~±2% over 20s)` to:

```glsl
  // slow luminance breathing + audio swell (computed on CPU)
```

- [ ] **Step 2: Pass the signals at the call site**

In `js/main.js` `frame()`, replace:

```js
  if (sceneTex) post.render(sceneTex, t);
```

with:

```js
  if (sceneTex) post.render(sceneTex, t, signals.audioLevel, signals.beat);
```

- [ ] **Step 3: Gates**

```bash
npm run typecheck && npm run lint && npm run test:unit
npx playwright test test/e2e/audio.spec.mjs -g "the wall hears"
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add js/post.js js/main.js
git commit -m "feat: audio-following breathe in the global post pass"
```

---

### Task 8: Ripple Tank + Ghost Field hear the room

**Files:**
- Modify: `js/modes/ripple.js`
- Modify: `js/modes/ghost.js`

**Interfaces:**
- Consumes: `ctx.signals.beat`, `ctx.signals.audioLevel` (Task 3); `NOISE_GLSL` (exports `vnoise`) from `js/gl.js`.
- Produces: visual behavior only — no exported API changes.

**Testing note:** Shader + uniform wiring; a GLSL compile error blacks the mode out and the e2e per-mode brightness + console gates catch it. Run them.

- [ ] **Step 1: Ripple — beat raindrops at a wandering point, loudness chop**

In `js/modes/ripple.js`:

1a. Extend the gl.js import:

```js
import { bindTarget, createPingPong, NOISE_GLSL, Program } from '../gl.js';
```

1b. Add constants right after the import:

```js
const AUDIO_DROP = 0.09; // beat raindrop impulse height
const AUDIO_CHOP = 0.012; // fine ambient chop amplitude at full loudness
```

1c. Replace `SIM_FS` entirely with:

```js
// Wave state texel: R = height now, G = height previous step.
const SIM_FS = `#version 300 es
precision highp float;
uniform sampler2D uWave;
uniform sampler2D uMotion;
uniform vec2 uPx;
uniform float uT;
uniform vec3 uDrop; // xy: raindrop uv, z: impulse height (beat-driven)
uniform float uChop; // fine ambient chop amplitude (loudness-driven)
in vec2 vUV;
out vec4 o;
${NOISE_GLSL}
void main() {
  vec2 w = texture(uWave, vUV).rg;
  float l = texture(uWave, vUV + vec2(uPx.x, 0.0)).r
          + texture(uWave, vUV - vec2(uPx.x, 0.0)).r
          + texture(uWave, vUV + vec2(0.0, uPx.y)).r
          + texture(uWave, vUV - vec2(0.0, uPx.y)).r
          - 4.0 * w.r;
  // Verlet wave step: c^2 of 0.28 stays comfortably under the stability bound.
  float nh = 2.0 * w.r - w.g + l * 0.28;
  nh *= 0.996;

  // Motion is a wave source: a walker drags a wake, a wave hello makes rings.
  float m = texture(uMotion, vUV).z;
  nh += smoothstep(0.15, 0.85, m) * 0.055;

  // Sound: beats fall as raindrops at a wandering point; loudness stirs a fine chop.
  nh += uDrop.z * smoothstep(0.03, 0.0, distance(vUV, uDrop.xy));
  nh += (vnoise(vUV * 42.0 + vec2(uT * 3.1, -uT * 2.3)) - 0.5) * uChop;

  nh = clamp(nh, -2.0, 2.0);
  o = vec4(nh, w.r, 0.0, 1.0);
}`;
```

1d. In the constructor, after `this._px = [0, 0];` add:

```js
    this._drop = [0.5, 0.5, 0];
```

1e. Replace the whole `update` method with:

```js
  /** @param {number} _dt @param {number} t */
  update(_dt, t) {
    const ctx = this.ctx;
    if (!ctx || !this.wave || !this.simProg) return;
    const gl = ctx.gl;
    // The raindrop point wanders a slow lissajous; the beat envelope sets splash height.
    this._drop[0] = 0.5 + 0.34 * Math.sin(t * 0.29 + 1.7);
    this._drop[1] = 0.5 + 0.3 * Math.sin(t * 0.41);
    this._drop[2] = ctx.signals.beat * AUDIO_DROP;
    bindTarget(gl, this.wave.write);
    this.simProg
      .use()
      .setTex('uWave', this.wave.read.tex, 0)
      .setTex('uMotion', ctx.vision.motionTex, 1)
      .set('uPx', this._px)
      .set('uT', t)
      .set('uDrop', this._drop)
      .set('uChop', ctx.signals.audioLevel * AUDIO_CHOP)
      .draw();
    this.wave.swap();
  }
```

- [ ] **Step 2: Verify and commit ripple**

```bash
npm run typecheck && npm run lint && npm run test:unit
git add js/modes/ripple.js
git commit -m "feat: ripple tank hears - beat raindrops and loudness chop"
```

- [ ] **Step 3: Ghost — beat brightens fresh trail injection, loudness warms it**

In `js/modes/ghost.js`:

3a. Add constants after the imports:

```js
const AUDIO_DEPOSIT = 0.8; // beat boost to fresh trail deposits
const AUDIO_HEAT = 0.3; // steady loudness boost to fresh trail deposits
```

3b. In `UPDATE_FS`, add a uniform after `uniform float uDecay;`:

```glsl
uniform float uAudio; // beat + loudness boost to fresh deposits
```

and replace the deposit line:

```glsl
  float deposit = smoothstep(0.12, 0.65, mo.z);
```

with:

```glsl
  // Sound brightens what the room is writing right now — never the stored past.
  float deposit = smoothstep(0.12, 0.65, mo.z) * (1.0 + uAudio);
```

3c. In `update(dt, _t)`, extend the program chain — after `.set('uDecay', Math.exp(-dt / GhostField.TAU))` add:

```js
      .set('uAudio', ctx.signals.beat * AUDIO_DEPOSIT + ctx.signals.audioLevel * AUDIO_HEAT)
```

- [ ] **Step 4: Verify, run the mode e2e, commit ghost**

```bash
npm run typecheck && npm run lint && npm run test:unit
npx playwright test -g "all seven modes"
git add js/modes/ghost.js
git commit -m "feat: ghost field hears - sound brightens fresh trails"
```

---

### Task 9: Particle Wake + Echo Chamber hear the room

**Files:**
- Modify: `js/modes/particle.js`
- Modify: `js/modes/echo.js`

**Interfaces:**
- Consumes: `ctx.signals.bass`, `ctx.signals.beat`, `ctx.signals.treble`, `ctx.signals.audioLevel` (Task 3).
- Produces: visual behavior only. (`computeTaps` in echo.js is untouched.)

- [ ] **Step 1: Particle — bass swells drift, beat kicks the swarm, treble sparkles cores**

In `js/modes/particle.js`:

1a. Add a constant after `const DIM = 384; ...`:

```js
const AUDIO_KICK = 0.9; // beat → per-particle velocity jitter burst (uv/s per envelope unit)
```

1b. In `SIM_FS`, add uniforms after `uniform float uSeed;`:

```glsl
uniform float uBass; // 0-1: bass swells the curl drift
uniform float uKick; // beat impulse: brief per-particle jitter burst
```

and replace:

```glsl
  // Everything relaxes back toward a slow curl-noise drift.
  vec2 drift = curl2(pos * 3.0 + vec2(uT * 0.021, -uT * 0.017)) * 0.022;
  vel = mix(vel, drift, 1.0 - exp(-uDt / 2.5));

  float sp = length(vel);
```

with:

```glsl
  // Everything relaxes back toward a slow curl-noise drift; bass leans on the weather.
  vec2 drift = curl2(pos * 3.0 + vec2(uT * 0.021, -uT * 0.017)) * (0.022 + 0.030 * uBass);
  vel = mix(vel, drift, 1.0 - exp(-uDt / 2.5));

  // Beats kick the whole swarm: every particle gets its own random shove.
  vel += (hash22(pos * 771.3 + vUV) - 0.5) * uKick * uDt;

  float sp = length(vel);
```

(The kick lands before the existing speed clamp, so it can never blow the field up.)

1c. In `POINT_VS`, add after `uniform int uDim;`:

```glsl
uniform float uTreble; // 0-1: sparkle — hot cores swell on treble
```

and replace the point-size line:

```glsl
  gl_PointSize = 1.0 + smoothstep(0.0, 0.30, vSpeed) * 2.0;
```

with:

```glsl
  gl_PointSize = 1.0 + smoothstep(0.0, 0.30, vSpeed) * (2.0 + uTreble * 2.5);
```

1d. In `update(dt, t)`, extend the sim chain — after `.set('uSeed', this._seeded ? 0 : 1)` add:

```js
      .set('uBass', ctx.signals.bass)
      .set('uKick', ctx.signals.beat * AUDIO_KICK)
```

1e. In `render(target, t)`, replace:

```js
    this.pointProg.use().setTex('uState', this.state.read.tex, 0).setInt('uDim', DIM);
```

with:

```js
    this.pointProg
      .use()
      .setTex('uState', this.state.read.tex, 0)
      .setInt('uDim', DIM)
      .set('uTreble', ctx.signals.treble);
```

- [ ] **Step 2: Verify and commit particle**

```bash
npm run typecheck && npm run lint && npm run test:unit
git add js/modes/particle.js
git commit -m "feat: particle wake hears - bass drift, beat kicks, treble sparkle"
```

- [ ] **Step 3: Echo — loudness smears the slit-scan, beat pops the newest tap**

In `js/modes/echo.js`:

3a. Add constants after the `BASE_WEIGHT` const (near the top with the other tunables):

```js
const AUDIO_SMEAR = 0.02; // loudness → horizontal slit-scan wander of the echo taps
const AUDIO_POP = 0.8; // beat boost to the newest (1s) tap's gain
```

3b. In `RENDER_FS`, add after `uniform float uT;`:

```glsl
uniform float uSmear;
```

replace `tapDiff` with a uv-parameterized version:

```glsl
float tapDiff(sampler2D a, sampler2D b, float frac, float now, vec2 uv) {
  float e = mix(texture(a, uv).r, texture(b, uv).r, frac);
  return smoothstep(0.04, 0.35, abs(e - now));
}
```

and replace the start of `main`:

```glsl
void main() {
  float now = dot(texture(uCam, vUV).rgb, vec3(0.299, 0.587, 0.114));
  vec3 col = vec3(now * 0.05); // the present, barely there

  col += TINT0 * (tapDiff(uA0, uB0, uFrac.x, now) * uW.x);
  col += TINT1 * (tapDiff(uA1, uB1, uFrac.y, now) * uW.y);
  col += TINT2 * (tapDiff(uA2, uB2, uFrac.z, now) * uW.z);
  col += TINT3 * (tapDiff(uA3, uB3, uFrac.w, now) * uW.w);
```

with:

```glsl
void main() {
  float now = dot(texture(uCam, vUV).rgb, vec3(0.299, 0.587, 0.114));
  vec3 col = vec3(now * 0.05); // the present, barely there

  // Loudness smears the echoes sideways, scanline by scanline — the past vibrates.
  vec2 suv = vUV + vec2((vnoise(vec2(vUV.y * 24.0, uT * 0.8)) - 0.5) * uSmear, 0.0);

  col += TINT0 * (tapDiff(uA0, uB0, uFrac.x, now, suv) * uW.x);
  col += TINT1 * (tapDiff(uA1, uB1, uFrac.y, now, suv) * uW.y);
  col += TINT2 * (tapDiff(uA2, uB2, uFrac.z, now, suv) * uW.z);
  col += TINT3 * (tapDiff(uA3, uB3, uFrac.w, now, suv) * uW.w);
```

(`vnoise` comes from the `${NOISE_GLSL}` already interpolated into this shader.)

3c. In `render(target, t)`, after the weight loop closes (the `}` following the `this._w[i] = tap.valid ? ...` line), insert:

```js
    // The newest echo pops on the beat; the older ones stay stately.
    this._w[0] *= 1 + ctx.signals.beat * AUDIO_POP;
```

and replace the final chain line:

```js
    p.set('uFrac', this._frac).set('uW', this._w).set('uT', t).draw();
```

with:

```js
    p.set('uFrac', this._frac)
      .set('uW', this._w)
      .set('uT', t)
      .set('uSmear', ctx.signals.audioLevel * AUDIO_SMEAR)
      .draw();
```

- [ ] **Step 4: Verify, run the mode e2e, commit echo**

```bash
npm run typecheck && npm run lint && npm run test:unit
npx playwright test -g "all seven modes"
git add js/modes/echo.js
git commit -m "feat: echo chamber hears - loudness smear, beat tap pop"
```

---

### Task 10: Coral Bloom hears the room (pure functions, TDD)

**Files:**
- Modify: `js/modes/coral.js` (`coralParams`, `makeSeeder`, `stepSeeder`, `CoralBloom` constructor + update)
- Test: `test/unit/coral.test.js`

**Interfaces:**
- Consumes: `ctx.signals.audioLevel`, `ctx.signals.beat`, `ctx.signals.motionEnergy`.
- Produces (exported, unit-tested):
  - `coralParams(t, dt, motion, audioLevel = 0, out = {f, k, steps})` — NOTE: `audioLevel` slots in **before** `out`; the two existing test call sites passing `out` positionally must be updated.
  - `makeSeeder() → {seed: Float32Array(4), cooldown: 3, beatCooldown: 0}`
  - `stepSeeder(st, env)` where `env` gains optional `beat?: number` — a beat > 0.85 drops a seed regardless of motion, behind its own 0.4 s refractory.

- [ ] **Step 1: Write the failing tests**

In `test/unit/coral.test.js`, first update the two existing call sites that pass `out` as the 4th positional argument:

- Line 10: `coralParams(t, 1 / 60, 0, out);` → `coralParams(t, 1 / 60, 0, 0, out);`
- Line 31: `expect(coralParams(0, 1 / 60, 0, out)).toBe(out);` → `expect(coralParams(0, 1 / 60, 0, 0, out)).toBe(out);`

Then append:

```js
describe('coralParams audio', () => {
  it('loudness nudges the feed rate without leaving the coral band', () => {
    const base = coralParams(10, 1 / 60, 0);
    const loud = coralParams(10, 1 / 60, 0, 1);
    expect(loud.f - base.f).toBeCloseTo(0.0012, 6);
    expect(loud.k).toBe(base.k);
    for (let t = 0; t < 4000; t += 3.7) {
      expect(coralParams(t, 1 / 60, 0, 1).f).toBeLessThan(0.059);
    }
  });
});

describe('beat seeding', () => {
  const rand = () => 0.5;

  it('a strong beat drops a seed even in a moving room', () => {
    const st = makeSeeder();
    stepSeeder(st, { motion: 0.8, dt: 1 / 60, rand, beat: 0.95 });
    expect(st.seed[3]).toBeCloseTo(0.9, 6);
  });

  it('beat seeds respect their own refractory', () => {
    const st = makeSeeder();
    stepSeeder(st, { motion: 0.8, dt: 1 / 60, rand, beat: 0.95 });
    stepSeeder(st, { motion: 0.8, dt: 1 / 60, rand, beat: 0.95 });
    expect(st.seed[3]).toBe(0); // still cooling down
    for (let i = 0; i < 30; i++) stepSeeder(st, { motion: 0.8, dt: 1 / 60, rand, beat: 0 });
    stepSeeder(st, { motion: 0.8, dt: 1 / 60, rand, beat: 0.95 });
    expect(st.seed[3]).toBeCloseTo(0.9, 6);
  });

  it('a weak envelope does not seed', () => {
    const st = makeSeeder();
    stepSeeder(st, { motion: 0.8, dt: 1 / 60, rand, beat: 0.5 });
    expect(st.seed[3]).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL — the audio describes fail (`loud.f - base.f` is 0; `beat` ignored); the updated positional calls still pass against the old signature only by accident of `out` landing in `audioLevel`'s slot — after Step 3 everything aligns.

- [ ] **Step 3: Implement**

In `js/modes/coral.js`:

3a. Add constants after the imports:

```js
const AUDIO_FEED = 0.0012; // loudness → Gray-Scott feed nudge (a loud room = lusher reef)
const FEED_MAX = 0.0589; // hard ceiling keeping f inside the coral-forming band
const BEAT_SEED_MIN = 0.85; // beat envelope threshold that plants a seed
const BEAT_SEED_COOLDOWN = 0.4; // seconds between beat-planted seeds
```

3b. Replace `coralParams` (function + its `@param` lines for `motion`/`out`, adding `audioLevel`):

```js
export function coralParams(t, dt, motion, audioLevel = 0, out = { f: 0, k: 0, steps: 0 }) {
  const drift = 0.0545 + 0.0035 * Math.sin(t * 0.011);
  // Loudness feeds the reef, clamped inside the band the drift test guards.
  out.f = Math.min(FEED_MAX, drift + AUDIO_FEED * Math.min(1, Math.max(0, audioLevel)));
  out.k = 0.062 + 0.0022 * Math.sin(t * 0.017 + 2.1);
  const rate = 480 + 480 * Math.min(1, Math.max(0, motion));
  out.steps = Math.max(1, Math.min(24, Math.round(rate * dt)));
  return out;
}
```

with the JSDoc gaining one line before `@param {{f...}} [out]`:

```js
 * @param {number} [audioLevel] smoothed room loudness 0–1 — a loud room feeds the reef
```

3c. Replace `makeSeeder`:

```js
/** Fresh ambient-seed scheduler: dormant, first check a few seconds after init. */
export function makeSeeder() {
  return { seed: new Float32Array(4), cooldown: 3, beatCooldown: 0 };
}
```

3d. Replace `stepSeeder` (and extend its JSDoc `st`/`env` types to `{seed: Float32Array, cooldown: number, beatCooldown: number}` and `{motion: number, dt: number, rand: () => number, beat?: number}`, plus one doc sentence: "A strong beat plants a seed too — music grows the reef — behind its own short refractory."):

```js
export function stepSeeder(st, env) {
  st.cooldown -= env.dt;
  st.beatCooldown -= env.dt;
  st.seed[3] = 0;
  if ((env.beat ?? 0) > BEAT_SEED_MIN && st.beatCooldown <= 0) {
    st.seed[0] = 0.1 + env.rand() * 0.8;
    st.seed[1] = 0.1 + env.rand() * 0.8;
    st.seed[2] = 0.01 + env.rand() * 0.012;
    st.seed[3] = 0.9;
    st.beatCooldown = BEAT_SEED_COOLDOWN;
    return st;
  }
  if (st.cooldown <= 0) {
    if (env.motion < 0.12) {
      st.seed[0] = 0.1 + env.rand() * 0.8;
      st.seed[1] = 0.1 + env.rand() * 0.8;
      st.seed[2] = 0.01 + env.rand() * 0.012;
      st.seed[3] = 0.9;
    }
    st.cooldown = 5 + env.rand() * 6;
  }
  return st;
}
```

3e. In the `CoralBloom` constructor, after `this._seed = [0, 0, 0, 0];` add:

```js
    // Reused stepSeeder env — the render loop allocates nothing.
    this._env = { motion: 0, dt: 0, rand: Math.random, beat: 0 };
```

3f. In `update(dt, t)`, replace:

```js
    const p = coralParams(t, dt, ctx.signals.motionEnergy, this._params);
    stepSeeder(this._seeder, { motion: ctx.signals.motionEnergy, dt, rand: Math.random });
```

with:

```js
    const p = coralParams(t, dt, ctx.signals.motionEnergy, ctx.signals.audioLevel, this._params);
    this._env.motion = ctx.signals.motionEnergy;
    this._env.dt = dt;
    this._env.beat = ctx.signals.beat;
    stepSeeder(this._seeder, this._env);
```

(This also removes a pre-existing per-frame object literal — an in-scope fix to lines we're already touching.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:unit`
Expected: PASS — all existing coral tests plus the new describes.

- [ ] **Step 5: Gates, mode e2e, commit**

```bash
npm run typecheck && npm run lint
npx playwright test -g "all seven modes"
git add js/modes/coral.js test/unit/coral.test.js
git commit -m "feat: coral bloom hears - loudness feeds the reef, beats plant seeds"
```

---

### Task 11: Aurora Ribbons + Silhouette Garden hear the room

**Files:**
- Modify: `js/modes/aurora.js`
- Modify: `js/modes/garden.js`

**Interfaces:**
- Consumes: `ctx.signals.bass`, `ctx.signals.beat`, `ctx.signals.audioLevel`.
- Produces: visual behavior only. (`matchDetections`/`strokeStamps` exports untouched.)

- [ ] **Step 1: Aurora — bass swells the curtains, beat shimmers fresh ribbon stamps**

In `js/modes/aurora.js`:

1a. Add constants near the other top-of-file tunables (after the import block's constants, e.g. next to `FADE_TAU`):

```js
const AUDIO_BASS_CURTAIN = 0.9; // bass swells the procedural curtain amplitude
const AUDIO_SHIMMER = 0.7; // beat boost + hue kick on fresh ribbon stamps
```

1b. In `STAMP_FS`, add after `uniform float uGain;`:

```glsl
uniform float uBeat; // 0-1 beat envelope: fresh stamps flash a shifted hue
```

and replace the color line:

```glsl
  vec3 col = hsv2rgb(vec3(fract(vHue + uT * 0.003), 0.75, 1.0));
```

with:

```glsl
  vec3 col = hsv2rgb(vec3(fract(vHue + uT * 0.003 + uBeat * 0.06), 0.75, 1.0));
```

1c. In `RENDER_FS`, add after `uniform float uT;`:

```glsl
uniform float uBass; // 0-1: bass swells the curtains
```

and replace the curtain line:

```glsl
  float curtain = pow(band, 2.4) * (0.30 + 0.70 * vUV.y);
```

with:

```glsl
  float curtain = pow(band, 2.4) * (0.30 + 0.70 * vUV.y) * (1.0 + uBass);
```

1d. In `update`'s stamp block, replace:

```js
        .set('uT', t)
        .set('uGain', 0.06);
```

with:

```js
        .set('uT', t)
        .set('uBeat', ctx.signals.beat)
        .set('uGain', 0.06 * (1 + ctx.signals.beat * AUDIO_SHIMMER));
```

1e. In `render(target, t)`, replace:

```js
    this.renderProg.use().setTex('uTrail', this.trail.read.tex, 0).set('uT', t).draw();
```

with:

```js
    this.renderProg
      .use()
      .setTex('uTrail', this.trail.read.tex, 0)
      .set('uT', t)
      .set('uBass', ctx.signals.bass * AUDIO_BASS_CURTAIN)
      .draw();
```

- [ ] **Step 2: Verify and commit aurora**

```bash
npm run typecheck && npm run lint && npm run test:unit
git add js/modes/aurora.js
git commit -m "feat: aurora ribbons hear - bass curtains, beat shimmer"
```

- [ ] **Step 3: Garden — beats flush growth along silhouette edges, loudness quickens it**

In `js/modes/garden.js`:

3a. Add constants after `const ITERS = 10; ...`:

```js
const AUDIO_EDGE_GROW = 0.35; // beat → extra deposit along silhouette edges
const AUDIO_GROWTH = 4; // extra reaction-diffusion steps at full loudness
```

3b. In `SIM_FS`, add after `uniform vec3 uSpore;` line:

```glsl
uniform float uBeatGrow; // beat envelope: flushes extra growth along silhouette edges
```

and replace the edge-deposit line:

```glsl
    nB = max(nB, edge * 0.5);
```

with:

```glsl
    nB = max(nB, edge * (0.5 + uBeatGrow));
```

3c. In `update(dt, _t)`, extend the shared program chain — replace:

```js
      .set('uSpore', this._spore);
    for (let i = 0; i < ITERS; i++) {
```

with:

```js
      .set('uSpore', this._spore)
      .set('uBeatGrow', ctx.signals.beat * AUDIO_EDGE_GROW);
    // A loud room grows faster: a few extra sim steps at full loudness.
    const iters = ITERS + Math.round(ctx.signals.audioLevel * AUDIO_GROWTH);
    for (let i = 0; i < iters; i++) {
```

- [ ] **Step 4: Verify, run the mode e2e, commit garden**

```bash
npm run typecheck && npm run lint && npm run test:unit
npx playwright test -g "all seven modes"
git add js/modes/garden.js
git commit -m "feat: silhouette garden hears - beats flush edge growth, loudness quickens it"
```

---

### Task 12: Copy, docs, and the full gate

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:** none — copy only, then the whole-suite gate.

- [ ] **Step 1: README updates**

1a. Quick start, replace:

```markdown
Open <http://localhost:44678>, click **begin**, grant the camera.
```

with:

```markdown
Open <http://localhost:44678>, click **begin**, grant the camera and the microphone
(the mic is optional — deny it and the wall simply doesn't hear).
```

1b. Query parameters paragraph, replace:

```markdown
Query parameters: `?mode=ripple-tank` (pin from boot), `?dwell=180` (seconds per mode),
`?fade=12` (crossfade seconds), `?cycle=0` (disable auto-cycling), `?clock=0` (hide
the overlay clock).
```

with:

```markdown
Query parameters: `?mode=ripple-tank` (pin from boot), `?dwell=180` (seconds per mode),
`?fade=12` (crossfade seconds), `?cycle=0` (disable auto-cycling), `?clock=0` (hide
the overlay clock), `?audio=0` (disable the microphone entirely).
```

1c. After the seven-modes table's MediaPipe paragraph (ending "...motion-only modes keep running."), add a new paragraph:

```markdown
The wall also listens. A room microphone (granted at the same **begin** click) feeds
adaptive loudness, bass/mid/treble, and a beat-onset envelope into every mode and the
global post pass: beats fall as raindrops on the ripple tank, kick the particle swarm,
pop the newest echo, and plant coral; loudness makes the whole wall breathe a little
deeper. No mic, no problem — the audio signals just rest at zero.
```

1d. Kiosk section — replace the auto-skip bullet:

```markdown
- **Camera gate auto-skip** — once the camera permission is durable, reboots go straight
  to the wall with no click.
```

with:

```markdown
- **Camera gate auto-skip** — once the camera permission is durable, reboots go straight
  to the wall with no click; the mic joins automatically only if its permission is
  already durable too (an auto-start never prompts).
```

and update the fake-ui note:

```markdown
(`--use-fake-ui-for-media-stream` auto-grants the camera and microphone prompts;
alternatively grant them once by hand — the permissions persist.)
```

1e. Privacy section, replace:

```markdown
Camera frames never leave the machine. There is no recording, no transmission, no
storage — frames live in GPU textures for exactly as long as an effect needs them.
MediaPipe inference runs locally (models are fetched from a CDN once and cached).
```

with:

```markdown
Camera frames and microphone audio never leave the machine. There is no recording, no
transmission, no storage — frames live in GPU textures for exactly as long as an effect
needs them, and audio is analyzed in-memory into a handful of scalars (loudness, three
bands, a beat envelope) that exist for one frame. MediaPipe inference runs locally
(models are fetched from a CDN once and cached).
```

1f. Development section, replace:

```markdown
npm test                # unit (vitest) + e2e (playwright, fake y4m camera)
```

with:

```markdown
npm test                # unit (vitest) + e2e (playwright, fake y4m camera + WAV mic)
```

1g. Map block — add one line after the `js/vision.js` line:

```
js/audio.js           microphone capture + FFT analysis into raw level/band/flux scalars
```

and replace the `test/e2e/` line:

```
test/e2e/             playwright specs + y4m/WAV fixture generators
```

1h. After the existing design-spec line (`Design spec: ...2026-07-02...`), add:

```markdown
Audio design spec: `docs/superpowers/specs/2026-07-14-audio-reactivity-design.md`.
```

1i. Requirements section — replace:

```markdown
WebGL2 with `EXT_color_buffer_float` (any GPU from the last decade), a webcam, and a
Chromium-family browser for the smoothest ride. Firefox and Safari work for the
motion-only modes; MediaPipe GPU delegate support varies.
```

with:

```markdown
WebGL2 with `EXT_color_buffer_float` (any GPU from the last decade), a webcam, and a
Chromium-family browser for the smoothest ride. A microphone is optional — the wall
hears with one and simply doesn't without. Firefox and Safari work for the motion-only
modes; MediaPipe GPU delegate support varies.
```

- [ ] **Step 2: CLAUDE.md privacy rule**

In `CLAUDE.md` Project Rules, replace:

```markdown
- Camera frames never leave the machine. No recording, no transmission. Don't add any.
```

with:

```markdown
- Camera frames and microphone audio never leave the machine. No recording, no
  transmission. Don't add any.
```

- [ ] **Step 3: The full gate**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: everything green — unit + the complete e2e suite (boot, modes, cycling, soak, first-visit, audio).

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: audio reactivity - README, CLAUDE.md privacy rule"
```

- [ ] **Step 5: Finish the branch**

Use the superpowers:finishing-a-development-branch skill: present the diff summary to Doctor Biz and merge `feat/audio-reactivity` to `main` via PR or explicit merge — never a silent local merge.
