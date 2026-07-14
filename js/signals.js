// ABOUTME: Pure-logic signal core for ECTO-WALL 9000 — no DOM, no WebGL, fully unit-testable.
// ABOUTME: Smoothing, camera→display geometry, activity history, cycle scheduling, quality governor, audio math.
// @ts-check

/**
 * Time-correct exponential moving average.
 * @param {number} prev current smoothed value
 * @param {number} next incoming raw value
 * @param {number} dt seconds since last update
 * @param {number} tau time constant in seconds
 */
export function ema(prev, next, dt, tau) {
  const a = 1 - Math.exp(-dt / tau);
  return prev + (next - prev) * a;
}

/** @param {number} x */
function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

// Default audio bands when no mic input arrives; shared and never written.
const ZERO_BANDS = new Float32Array(3);

/**
 * Smoothstep crossfade envelope: eased at both ends, 0.5 at midpoint.
 * @param {number} x raw fade progress
 */
export function fadeEnvelope(x) {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/**
 * Cover-fit mapping from display uv to camera uv: camUV = offset + dispUV * scale.
 * The camera is cropped (never letterboxed) so it always fills the display.
 * @param {number} camW @param {number} camH @param {number} outW @param {number} outH
 * @returns {{sx: number, sy: number, ox: number, oy: number}}
 */
export function coverMap(camW, camH, outW, outH) {
  const camA = camW / camH;
  const outA = outW / outH;
  let sx = 1;
  let sy = 1;
  if (camA > outA) sx = outA / camA;
  else sy = camA / outA;
  return { sx, sy, ox: (1 - sx) / 2, oy: (1 - sy) / 2 };
}

/**
 * Map a normalized camera-space point (e.g. a MediaPipe landmark) into display uv space,
 * inverting the cover crop. Mirrors x by default because the wall renders like a mirror.
 * @param {{sx: number, sy: number, ox: number, oy: number}} map
 * @param {number} x @param {number} y @param {boolean} [mirror]
 * @returns {[number, number]}
 */
export function camToDisp(map, x, y, mirror = true) {
  const xm = mirror ? 1 - x : x;
  return [(xm - map.ox) / map.sx, (y - map.oy) / map.sy];
}

/**
 * Fixed-size ring of time-averaged history slots (e.g. minute-resolution motion history).
 * Feeds the long-run `pressure` barometer.
 */
export class HistoryRing {
  /** @param {number} slots @param {number} slotSeconds */
  constructor(slots = 60, slotSeconds = 60) {
    this.slotSeconds = slotSeconds;
    this.slots = new Float64Array(slots);
    this.filled = 0;
    this.idx = 0;
    this.acc = 0;
    this.accT = 0;
  }

  /** @param {number} value @param {number} dt */
  push(value, dt) {
    this.acc += value * dt;
    this.accT += dt;
    if (this.accT >= this.slotSeconds) {
      this.slots[this.idx] = this.acc / this.accT;
      this.idx = (this.idx + 1) % this.slots.length;
      this.filled = Math.min(this.filled + 1, this.slots.length);
      this.acc = 0;
      this.accT = 0;
    }
  }

  /** Average over completed slots plus the current partial slot. */
  average() {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < this.filled; i++) {
      sum += this.slots[(this.idx - 1 - i + this.slots.length) % this.slots.length];
      n++;
    }
    if (this.accT > 0) {
      sum += this.acc / this.accT;
      n++;
    }
    return n ? sum / n : 0;
  }
}

/**
 * Drives which mode is on the wall: auto-cycling with timed dwell, crossfades with a
 * fixed duration, manual pinning, and availability filtering (e.g. MediaPipe offline).
 * Time is fed via tick(dt); leftover time cascades across state boundaries so a large
 * dt behaves identically to many small ones.
 */
export class CycleScheduler {
  /**
   * @param {string[]} names mode names in cycle order
   * @param {{dwell?: number, fade?: number, auto?: boolean}} [opts]
   */
  constructor(names, opts = {}) {
    const { dwell = 180, fade = 12, auto = true } = opts;
    this.names = [...names];
    this.available = new Set(names);
    this.dwell = dwell;
    this.fade = fade;
    this.auto = auto;
    this.active = names[0];
    /** @type {string | null} */
    this.incoming = null;
    this.mixT = 0;
    this.dwellLeft = dwell;
  }

  #avail() {
    return this.names.filter((n) => this.available.has(n));
  }

  /** @param {number} dir */
  #neighbor(dir) {
    const av = this.#avail();
    if (!av.length) return null;
    const i = av.indexOf(this.active);
    if (i < 0) return av[0];
    return av[(i + dir + av.length) % av.length];
  }

  /** @param {string} name */
  #fadeTo(name) {
    if (this.incoming) {
      // Retarget mid-fade: snap the old fade so the wall never runs three modes at once.
      this.active = this.incoming;
      this.incoming = null;
      this.mixT = 0;
    }
    if (name !== this.active) {
      this.incoming = name;
      this.mixT = 0;
    }
  }

  /** @param {number} dt */
  tick(dt) {
    let rem = dt;
    while (rem > 1e-9) {
      if (this.incoming) {
        const need = (1 - this.mixT) * this.fade;
        const step = Math.min(rem, need);
        this.mixT += step / this.fade;
        rem -= step;
        if (this.mixT >= 1 - 1e-9) {
          this.active = this.incoming;
          this.incoming = null;
          this.mixT = 0;
          this.dwellLeft = this.dwell;
        }
      } else if (this.auto) {
        const step = Math.min(rem, this.dwellLeft);
        this.dwellLeft -= step;
        rem -= step;
        if (this.dwellLeft <= 1e-9) {
          const n = this.#neighbor(1);
          if (n && n !== this.active) {
            this.incoming = n;
            this.mixT = 0;
          } else {
            this.dwellLeft = this.dwell;
          }
        }
      } else {
        break;
      }
    }
    return this.state();
  }

  state() {
    return {
      active: this.active,
      incoming: this.incoming,
      mix: this.mixT,
      auto: this.auto,
      remaining: this.dwellLeft,
    };
  }

  /** Pin a mode (disables auto-cycling). Returns false if unknown or unavailable. @param {string} name */
  pin(name) {
    if (!this.names.includes(name) || !this.available.has(name)) return false;
    this.auto = false;
    this.#fadeTo(name);
    return true;
  }

  next() {
    this.auto = false;
    const n = this.#neighbor(1);
    if (n) this.#fadeTo(n);
  }

  prev() {
    this.auto = false;
    const n = this.#neighbor(-1);
    if (n) this.#fadeTo(n);
  }

  resumeAuto() {
    this.auto = true;
    this.dwellLeft = this.dwell;
  }

  /** Restrict the cycle to available modes; evacuates the active mode if it became unavailable. @param {string[]} list */
  setAvailable(list) {
    this.available = new Set(list);
    if (!this.#avail().length) return;
    if (this.incoming && !this.available.has(this.incoming)) {
      this.incoming = null;
      this.mixT = 0;
    }
    if (!this.available.has(this.active)) {
      const n = this.#neighbor(1);
      if (n) this.#fadeTo(n);
    }
  }
}

/**
 * Adaptive quality governor with hysteresis: sustained low fps halves the render scale,
 * sustained high fps restores it. Never flaps inside the dead band.
 */
export class QualityGovernor {
  /** @param {{down?: number, up?: number, downHold?: number, upHold?: number, floor?: number}} [opts] */
  constructor(opts = {}) {
    const { down = 45, up = 55, downHold = 3, upHold = 10, floor = 0.25 } = opts;
    this.down = down;
    this.up = up;
    this.downHold = downHold;
    this.upHold = upHold;
    this.floor = floor;
    this.scale = 1;
    this.lowT = 0;
    this.highT = 0;
  }

  /** @param {number} fps @param {number} dt */
  update(fps, dt) {
    if (fps < this.down && this.scale > this.floor) {
      this.lowT += dt;
      this.highT = 0;
      if (this.lowT >= this.downHold) {
        this.scale = Math.max(this.floor, this.scale / 2);
        this.lowT = 0;
      }
    } else if (fps > this.up && this.scale < 1) {
      this.highT += dt;
      this.lowT = 0;
      if (this.highT >= this.upHold) {
        this.scale = Math.min(1, this.scale * 2);
        this.highT = 0;
      }
    } else {
      this.lowT = 0;
      this.highT = 0;
    }
    return this.scale;
  }
}

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
    if (!this._primed) {
      // Prime the running mean on the first sample so mic turn-on isn't a beat.
      this.avg = flux;
      this._primed = true;
      return 0;
    }
    this._sinceOnset += dt;
    this.beat *= Math.exp(-dt / this.decayTau);
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

/**
 * The room's smoothed nervous system. Fed raw per-frame inputs, exposes eased values
 * every mode reads: motionEnergy, personCount, handActivity, long-run pressure, and the
 * audio senses — audioLevel, bass, mid, treble, and the beat envelope.
 */
export class Signals {
  constructor() {
    this.motionEnergy = 0;
    this.personCount = 0;
    this.handActivity = 0;
    this.history = new HistoryRing(60, 60);
    this._absence = 0;
    /** @type {{x: number, y: number}[][]} */
    this._prevHands = [];
    /** @type {{x: number, y: number}[][] | null} */
    this._handsRef = null;
    this._lastMatched = 0;
    this.audioLevel = 0;
    this.bass = 0;
    this.mid = 0;
    this.treble = 0;
    this.beat = 0;
    this._levelGain = new AutoGain();
    this._bandGains = [new AutoGain(), new AutoGain(), new AutoGain()];
    this._onset = new OnsetDetector();
  }

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
    this.motionEnergy = ema(this.motionEnergy, clamp01(energyRaw), dt, 0.5);

    // Person count: rises instantly, falls only after 2s of sustained absence
    // so a missed detection frame doesn't flicker the room's population.
    const n = poses.length;
    if (n >= this.personCount) {
      this.personCount = n;
      this._absence = 0;
    } else {
      this._absence += dt;
      if (this._absence >= 2) {
        this.personCount = n;
        this._absence = 0;
      }
    }

    // Hand activity: mean landmark speed across hands, matched by index. The hands array
    // is replaced wholesale per inference, so identity gates the work: the delta and the
    // snapshot copy run only when fresh landmarks arrive (~7.5Hz). Between inferences
    // inst is 0 by construction (the data hasn't moved), so nothing is computed.
    let inst = 0;
    if (hands !== this._handsRef) {
      let speed = 0;
      let matched = 0;
      for (let i = 0; i < hands.length; i++) {
        const h = hands[i];
        const p = this._prevHands[i];
        if (p && p.length === h.length) {
          let s = 0;
          for (let j = 0; j < h.length; j++) s += Math.hypot(h[j].x - p[j].x, h[j].y - p[j].y);
          speed += s / h.length;
          matched++;
        }
      }
      inst = matched ? clamp01(speed / matched / dt / 1.5) : 0;
      this._prevHands = hands.map((h) => h.map((p) => ({ x: p.x, y: p.y })));
      this._handsRef = hands;
      this._lastMatched = matched;
    }
    this.handActivity = ema(this.handActivity, inst, dt, this._lastMatched ? 0.35 : 1.2);

    // Audio: each raw signal through its own adaptive gain, then a short smoothing EMA.
    // With no mic these inputs sit at zero and every field rests at exact zero.
    this.audioLevel = ema(this.audioLevel, this._levelGain.update(audioLevelRaw, dt), dt, 0.25);
    this.bass = ema(this.bass, this._bandGains[0].update(audioBandsRaw[0], dt), dt, 0.15);
    this.mid = ema(this.mid, this._bandGains[1].update(audioBandsRaw[1], dt), dt, 0.15);
    this.treble = ema(this.treble, this._bandGains[2].update(audioBandsRaw[2], dt), dt, 0.15);
    this.beat = this._onset.update(audioFluxRaw, dt);

    this.history.push(this.motionEnergy, dt);
  }

  /** Long-run activity average (0–1): a slow barometer of how busy the room has been. */
  get pressure() {
    return this.history.average();
  }
}
