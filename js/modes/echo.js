// ABOUTME: Echo Chamber mode — a ring of once-per-second luminance snapshots replayed at
// ABOUTME: 1/3/7/15s taps; only *differences* from the present glow, in spectral tints.
// @ts-check
import { bindTarget, createTarget, destroyTarget, NOISE_GLSL, Program } from '../gl.js';

const SLOT_COUNT = 16;
const TAPS = [1, 3, 7, 15];
const BASE_WEIGHT = [0.4, 0.3, 0.24, 0.18];
const AUDIO_SMEAR = 0.02; // loudness → horizontal slit-scan wander of the echo taps
const AUDIO_POP = 0.8; // beat boost to the newest (1s) tap's gain

/**
 * Resolve which two ring slots a time-tap reads and how to blend them.
 * Snapshot k is taken at integer second k and lives in slot k % slotCount.
 * Writes into `out` (preallocated) so the render loop never allocates.
 * @param {number} clock seconds since the mode started
 * @param {number[]} taps seconds of delay per tap
 * @param {number} slotCount ring size
 * @param {{a: number, b: number, frac: number, valid: boolean}[]} out
 */
export function computeTaps(clock, taps, slotCount, out) {
  for (let i = 0; i < taps.length; i++) {
    const o = out[i];
    const tapTime = clock - taps[i];
    if (tapTime < 0) {
      o.valid = false;
      o.a = 0;
      o.b = 0;
      o.frac = 0;
      continue;
    }
    const k = Math.floor(tapTime);
    o.a = k % slotCount;
    o.b = (k + 1) % slotCount;
    o.frac = tapTime - k;
    o.valid = true;
  }
  return out;
}

// Store the camera as luminance so echoes are shades, not literal replays.
const SNAP_FS = `#version 300 es
precision highp float;
uniform sampler2D uCam;
in vec2 vUV;
out vec4 o;
void main() {
  vec3 c = texture(uCam, vUV).rgb;
  o = vec4(vec3(dot(c, vec3(0.299, 0.587, 0.114))), 1.0);
}`;

const RENDER_FS = `#version 300 es
precision highp float;
uniform sampler2D uCam;
uniform sampler2D uA0; uniform sampler2D uB0;
uniform sampler2D uA1; uniform sampler2D uB1;
uniform sampler2D uA2; uniform sampler2D uB2;
uniform sampler2D uA3; uniform sampler2D uB3;
uniform vec4 uFrac;   // interpolation fraction per tap
uniform vec4 uW;      // weight per tap (0 while a tap has no history yet)
uniform float uT;
uniform float uSmear;
in vec2 vUV;
out vec4 outColor;
${NOISE_GLSL}

const vec3 TINT0 = vec3(0.40, 0.90, 1.00); // 1s  — cyan
const vec3 TINT1 = vec3(1.00, 0.45, 0.85); // 3s  — magenta
const vec3 TINT2 = vec3(1.00, 0.75, 0.40); // 7s  — amber
const vec3 TINT3 = vec3(0.60, 0.45, 1.00); // 15s — violet

float tapDiff(sampler2D a, sampler2D b, float frac, float now, vec2 uv) {
  float e = mix(texture(a, uv).r, texture(b, uv).r, frac);
  return smoothstep(0.04, 0.35, abs(e - now));
}

void main() {
  float now = dot(texture(uCam, vUV).rgb, vec3(0.299, 0.587, 0.114));
  vec3 col = vec3(now * 0.05); // the present, barely there

  // Loudness smears the echoes sideways, scanline by scanline — the past vibrates.
  vec2 suv = vUV + vec2((vnoise(vec2(vUV.y * 24.0, uT * 0.8)) - 0.5) * uSmear, 0.0);

  col += TINT0 * (tapDiff(uA0, uB0, uFrac.x, now, suv) * uW.x);
  col += TINT1 * (tapDiff(uA1, uB1, uFrac.y, now, suv) * uW.y);
  col += TINT2 * (tapDiff(uA2, uB2, uFrac.z, now, suv) * uW.z);
  col += TINT3 * (tapDiff(uA3, uB3, uFrac.w, now, suv) * uW.w);

  // faint drifting haze so an unchanged room still breathes
  float haze = fbm(vUV * 3.0 + vec2(uT * 0.015, -uT * 0.011));
  col += vec3(0.05, 0.045, 0.09) * haze * 0.5;

  // soft-clip overlapping echoes instead of clipping hard
  col = 1.0 - exp(-col * 1.35);
  outColor = vec4(col, 1.0);
}`;

export class EchoChamber {
  name = 'echo-chamber';
  needs = { pose: false, hands: false, seg: false };

  constructor() {
    /** @type {import('../modes.js').ModeCtx | null} */
    this.ctx = null;
    this.clock = 0;
    this.lastSnap = -1;
    this._taps = TAPS.map(() => ({ a: 0, b: 0, frac: 0, valid: false }));
    this._frac = [0, 0, 0, 0];
    this._w = [0, 0, 0, 0];
  }

  /** @param {import('../modes.js').ModeCtx} ctx */
  init(ctx) {
    this.ctx = ctx;
    const gl = ctx.gl;
    this.snapProg = new Program(gl, SNAP_FS);
    this.renderProg = new Program(gl, RENDER_FS);
    this.clock = 0;
    this.lastSnap = -1;
    this._allocSlots(ctx.w, ctx.h);
  }

  /** @param {number} w @param {number} h */
  _allocSlots(w, h) {
    const gl = /** @type {import('../modes.js').ModeCtx} */ (this.ctx).gl;
    const sw = Math.max(160, Math.round(w / 2));
    const sh = Math.max(90, Math.round(h / 2));
    /** @type {import('../gl.js').Target[]} */
    this.slots = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      this.slots.push(createTarget(gl, sw, sh, { fmt: 'rgba8' }));
    }
  }

  /** @param {number} dt @param {number} _t */
  update(dt, _t) {
    const ctx = this.ctx;
    if (!ctx || !this.slots || !this.snapProg) return;
    this.clock += dt;
    const k = Math.floor(this.clock);
    if (k > this.lastSnap) {
      // Snapshot the present into slot k, even across skipped seconds.
      this.lastSnap = k;
      const gl = ctx.gl;
      bindTarget(gl, this.slots[k % SLOT_COUNT]);
      this.snapProg.use().setTex('uCam', ctx.vision.camTex, 0).draw();
    }
  }

  /**
   * @param {import('../gl.js').Target} target
   * @param {number} t
   */
  render(target, t) {
    const ctx = this.ctx;
    if (!ctx || !this.slots || !this.renderProg) return;
    const gl = ctx.gl;
    computeTaps(this.clock, TAPS, SLOT_COUNT, this._taps);
    for (let i = 0; i < TAPS.length; i++) {
      const tap = this._taps[i];
      this._frac[i] = tap.frac;
      // Echoes awaken: each tap fades in over 2s once its history exists.
      this._w[i] = tap.valid ? BASE_WEIGHT[i] * Math.min(1, (this.clock - TAPS[i]) / 2) : 0;
    }
    // The newest echo pops on the beat; the older ones stay stately.
    this._w[0] *= 1 + ctx.signals.beat * AUDIO_POP;
    bindTarget(gl, target);
    const p = this.renderProg.use().setTex('uCam', ctx.vision.camTex, 0);
    for (let i = 0; i < TAPS.length; i++) {
      const tap = this._taps[i];
      const a = tap.valid ? this.slots[tap.a] : this.slots[0];
      const b = tap.valid ? this.slots[tap.b] : this.slots[0];
      p.setTex(`uA${i}`, a.tex, 1 + i * 2);
      p.setTex(`uB${i}`, b.tex, 2 + i * 2);
    }
    p.set('uFrac', this._frac)
      .set('uW', this._w)
      .set('uT', t)
      .set('uSmear', ctx.signals.audioLevel * AUDIO_SMEAR)
      .draw();
  }

  /** @param {number} w @param {number} h */
  resize(w, h) {
    if (!this.ctx || !this.slots) return;
    const gl = this.ctx.gl;
    for (const s of this.slots) destroyTarget(gl, s);
    this._allocSlots(w, h);
    // Old echoes died with the old buffers; let taps re-awaken cleanly.
    this.clock = 0;
    this.lastSnap = -1;
  }

  dispose() {
    if (!this.ctx) return;
    const gl = this.ctx.gl;
    if (this.slots) for (const s of this.slots) destroyTarget(gl, s);
    this.snapProg?.destroy();
    this.renderProg?.destroy();
    this.slots = undefined;
    this.snapProg = undefined;
    this.renderProg = undefined;
    this.ctx = null;
  }
}
