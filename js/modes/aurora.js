// ABOUTME: Aurora Ribbons mode — nose, wrists, and ankles paint hue-coded light ribbons into
// ABOUTME: a rising, wavering feedback buffer; empty rooms keep dim procedural curtains alive.
// @ts-check
import { bindTarget, createPingPong, createTex, NOISE_GLSL, Program, uploadData } from '../gl.js';

const TEX_W = 1024; // stamp data texture width; 4 poses × 5 joints × 32 stamps fits easily
const MAX_POSE = 4;
const MATCH_DIST = 0.25; // centroid gate for track↔detection matching, in display uv
const STAMP_SPACING = 0.004; // uv between stamps along a stroke
const MAX_STAMPS = 32; // per joint per frame
const FADE_TAU = 8; // seconds for painted light to dissolve

// Painting joints over MediaPipe's 33-landmark pose: nose, wrists, ankles.
const JOINTS = [0, 15, 16, 27, 28];
// One hue anchor per joint (drifted slowly in the shader): green nose, teal/magenta
// wrists, blue/chartreuse ankles — each limb signs the air in its own color.
const HUES = new Float32Array([0.36, 0.5, 0.83, 0.58, 0.3]);
const STRIDE = 7; // per-joint floats: tx, ty, x, y, px, py, vis

/**
 * Greedy globally-nearest matching of detection centroids to track centroids.
 * Returns, for each detection, the matched track index or -1. Each track is
 * claimed at most once and no pair beyond maxDist is ever matched.
 * @param {{cx: number, cy: number}[]} tracks
 * @param {{cx: number, cy: number}[]} dets
 * @param {number} maxDist
 * @returns {number[]}
 */
export function matchDetections(tracks, dets, maxDist) {
  /** @type {[number, number, number][]} dist, det index, track index */
  const pairs = [];
  for (let d = 0; d < dets.length; d++) {
    for (let t = 0; t < tracks.length; t++) {
      const dist = Math.hypot(dets[d].cx - tracks[t].cx, dets[d].cy - tracks[t].cy);
      if (dist <= maxDist) pairs.push([dist, d, t]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const out = new Array(dets.length).fill(-1);
  const claimed = new Set();
  for (const [, d, t] of pairs) {
    if (out[d] !== -1 || claimed.has(t)) continue;
    out[d] = t;
    claimed.add(t);
  }
  return out;
}

/**
 * Write one joint's stroke into the stamp buffer as texels of (x, y, hue, alpha):
 * stamps are spaced evenly from just past the previous position to the current one,
 * so strokes stay continuous at any frame rate. Alpha has a dim floor for resting
 * joints and saturates for fast sweeps. Returns the number of texels written.
 * @param {Float32Array} buf
 * @param {number} base first texel index to write
 * @param {number} px @param {number} py previous position (display uv)
 * @param {number} x @param {number} y current position (display uv)
 * @param {number} vis 0..1 visibility weight
 * @param {number} hue 0..1 hue anchor
 */
export function strokeStamps(buf, base, px, py, x, y, vis, hue) {
  const dist = Math.hypot(x - px, y - py);
  const n = Math.max(1, Math.min(MAX_STAMPS, Math.ceil(dist / STAMP_SPACING)));
  const alpha = vis * Math.min(1, 0.35 + dist * 10);
  for (let i = 1; i <= n; i++) {
    const o = (base + i - 1) * 4;
    const s = i / n;
    buf[o] = px + (x - px) * s;
    buf[o + 1] = py + (y - py) * s;
    buf[o + 2] = hue;
    buf[o + 3] = alpha;
  }
  return n;
}

/**
 * Visibility gate: maps MediaPipe visibility to a 0..1 confidence weight.
 * @param {number} v
 */
function vGate(v) {
  return Math.min(1, Math.max(0, (v - 0.35) / 0.4));
}

/**
 * Visibility-weighted centroid of one detection's landmarks.
 * @param {{x: number, y: number, vis?: number}[]} lm
 * @returns {{cx: number, cy: number}}
 */
function centroidOf(lm) {
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (const p of lm) {
    const w = 0.05 + (p.vis ?? 1); // never zero, so low-vis poses still average
    sx += p.x * w;
    sy += p.y * w;
    sw += w;
  }
  return sw > 0 ? { cx: sx / sw, cy: sy / sw } : { cx: 0.5, cy: 0.5 };
}

// Painted light rises and wavers like a curtain while it dissolves.
const FADE_FS = `#version 300 es
precision highp float;
uniform sampler2D uPrev;
uniform float uDt;
uniform float uDecay;
uniform float uT;
in vec2 vUV;
out vec4 o;
${NOISE_GLSL}
void main() {
  vec2 wob = curl2(vUV * 3.0 + vec2(0.0, uT * 0.05)) * 0.008;
  vec2 src = vUV - vec2(wob.x, 0.012 + wob.y) * uDt;
  o = texture(uPrev, src) * uDecay;
}`;

const STAMP_VS = `#version 300 es
uniform sampler2D uData;
uniform float uSize;
out float vHue;
out float vA;
void main() {
  vec4 d = texelFetch(uData, ivec2(gl_VertexID, 0), 0);
  // landmark space is y-down (image convention); clip space is y-up
  vec2 p = vec2(d.x, 1.0 - d.y) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = uSize;
  vHue = d.z;
  vA = d.w;
}`;

const STAMP_FS = `#version 300 es
precision highp float;
uniform float uT;
uniform float uGain;
in float vHue;
in float vA;
out vec4 o;
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float fall = exp(-dot(q, q) * 9.0) - 0.11; // soft core, hard zero at the rim
  vec3 col = hsv2rgb(vec3(fract(vHue + uT * 0.003), 0.75, 1.0));
  o = vec4(col * max(fall, 0.0) * vA * uGain, 1.0);
}`;

const RENDER_FS = `#version 300 es
precision highp float;
uniform sampler2D uTrail;
uniform float uT;
in vec2 vUV;
out vec4 outColor;
${NOISE_GLSL}
void main() {
  // Dim procedural curtains keep the sky alive when nobody is painting.
  float band = fbm(vec2(vUV.x * 2.6 + uT * 0.012, vUV.y * 0.7 - uT * 0.016));
  float curtain = pow(band, 2.4) * (0.30 + 0.70 * vUV.y);
  vec3 col = vec3(0.012, 0.020, 0.030) + vec3(0.10, 0.34, 0.24) * curtain * 0.45;

  vec3 tr = texture(uTrail, vUV).rgb;
  col += tr + tr * tr * 0.5; // painted light, with a soft self-bloom

  outColor = vec4(col, 1.0);
}`;

/** One pooled track slot: matching centroid plus flat per-joint kinematics. */
function makeSlot() {
  return { used: false, hit: false, cx: 0, cy: 0, arr: new Float32Array(JOINTS.length * STRIDE) };
}

export class AuroraRibbons {
  name = 'aurora-ribbons';
  needs = { pose: true, hands: false, seg: false };

  constructor() {
    /** @type {import('../modes.js').ModeCtx | null} */
    this.ctx = null;
    this._slots = [makeSlot(), makeSlot(), makeSlot(), makeSlot()];
    /** @type {ReturnType<typeof makeSlot>[]} */
    this._tracks = [];
    this._buf = new Float32Array(TEX_W * 4);
    this._stampCount = 0;
    this._size = 6;
    /** @type {object | null} */
    this._lastPoses = null;
  }

  /** @param {import('../modes.js').ModeCtx} ctx */
  init(ctx) {
    this.ctx = ctx;
    const gl = ctx.gl;
    this.fadeProg = new Program(gl, FADE_FS);
    this.stampProg = new Program(gl, STAMP_FS, STAMP_VS);
    this.renderProg = new Program(gl, RENDER_FS);
    // RGBA32F wants nearest filtering; texelFetch reads are exact anyway.
    this.dataTex = createTex(gl, TEX_W, 1, { fmt: 'rgba32f', filter: 'nearest' });
    for (const s of this._slots) s.used = false;
    this._tracks.length = 0;
    this._lastPoses = null;
    this._stampCount = 0;
    this._alloc(ctx.w, ctx.h);
  }

  /** @param {number} w @param {number} h */
  _alloc(w, h) {
    const gl = /** @type {import('../modes.js').ModeCtx} */ (this.ctx).gl;
    const tw = Math.max(160, Math.round(w / 2));
    const th = Math.max(90, Math.round(h / 2));
    this.trail = createPingPong(gl, tw, th, { fmt: 'rgba16f' });
    this._size = Math.max(3, (th / 540) * 9);
  }

  /**
   * Fold fresh pose results into the track pool: retarget matches, claim slots for
   * new arrivals, release the unmatched — their painted light simply fades away.
   * @param {{x: number, y: number, vis?: number}[][]} dets
   */
  _ingest(dets) {
    for (const tr of this._tracks) tr.hit = false;
    const cents = dets.map(centroidOf);
    const match = matchDetections(this._tracks, cents, MATCH_DIST);
    for (let d = 0; d < dets.length; d++) {
      const ti = match[d];
      if (ti >= 0) this._retarget(this._tracks[ti], dets[d], cents[d]);
      else this._birth(dets[d], cents[d]);
    }
    let w = 0;
    for (const tr of this._tracks) {
      if (tr.hit) this._tracks[w++] = tr;
      else tr.used = false;
    }
    this._tracks.length = w;
  }

  /**
   * @param {ReturnType<typeof makeSlot>} tr
   * @param {{x: number, y: number, vis?: number}[]} det
   * @param {{cx: number, cy: number}} cent
   */
  _retarget(tr, det, cent) {
    const a = tr.arr;
    for (let j = 0; j < JOINTS.length; j++) {
      const lm = det[JOINTS[j]];
      const o = j * STRIDE;
      a[o] = lm ? lm.x : a[o];
      a[o + 1] = lm ? lm.y : a[o + 1];
      a[o + 6] = lm ? (lm.vis ?? 1) : 0;
    }
    tr.cx = cent.cx;
    tr.cy = cent.cy;
    tr.hit = true;
  }

  /**
   * @param {{x: number, y: number, vis?: number}[]} det
   * @param {{cx: number, cy: number}} cent
   */
  _birth(det, cent) {
    if (this._tracks.length >= MAX_POSE) return;
    let slot = null;
    for (const s of this._slots) {
      if (!s.used) {
        slot = s;
        break;
      }
    }
    if (!slot) return;
    slot.used = true;
    const a = slot.arr;
    for (let j = 0; j < JOINTS.length; j++) {
      const lm = det[JOINTS[j]];
      const o = j * STRIDE;
      const x = lm ? lm.x : 0.5;
      const y = lm ? lm.y : 0.5;
      // Snap the whole kinematic chain to the detection so birth never streaks.
      a[o] = x;
      a[o + 1] = y;
      a[o + 2] = x;
      a[o + 3] = y;
      a[o + 4] = x;
      a[o + 5] = y;
      a[o + 6] = lm ? (lm.vis ?? 1) : 0;
    }
    slot.cx = cent.cx;
    slot.cy = cent.cy;
    slot.hit = true;
    this._tracks.push(slot);
  }

  /** @param {number} dt @param {number} t */
  update(dt, t) {
    const ctx = this.ctx;
    if (!ctx || !this.trail || !this.fadeProg || !this.stampProg || !this.dataTex) return;
    const gl = ctx.gl;
    const v = ctx.vision;
    // Detection arrays are replaced wholesale per inference; identity change = fresh data.
    if (v.poses !== this._lastPoses) {
      this._lastPoses = v.poses;
      this._ingest(v.poses);
    }

    // Pursue targets and lay stroke stamps from each joint's previous position.
    const k = 1 - Math.exp(-dt / 0.09);
    let base = 0;
    for (const tr of this._tracks) {
      const a = tr.arr;
      for (let j = 0; j < JOINTS.length; j++) {
        const o = j * STRIDE;
        a[o + 4] = a[o + 2];
        a[o + 5] = a[o + 3];
        a[o + 2] += (a[o] - a[o + 2]) * k;
        a[o + 3] += (a[o + 1] - a[o + 3]) * k;
        const vis = vGate(a[o + 6]);
        if (vis <= 0.01 || base > TEX_W - MAX_STAMPS) continue;
        base += strokeStamps(this._buf, base, a[o + 4], a[o + 5], a[o + 2], a[o + 3], vis, HUES[j]);
      }
    }
    this._stampCount = base;
    if (base > 0) uploadData(gl, this.dataTex, TEX_W, 1, this._buf, 'rgba32f');

    // Fade + rise, then stamp fresh light additively into the same frame.
    bindTarget(gl, this.trail.write);
    this.fadeProg
      .use()
      .setTex('uPrev', this.trail.read.tex, 0)
      .set('uDt', dt)
      .set('uDecay', Math.exp(-dt / FADE_TAU))
      .set('uT', t)
      .draw();
    if (this._stampCount > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.stampProg
        .use()
        .setTex('uData', this.dataTex, 0)
        .set('uSize', this._size)
        .set('uT', t)
        .set('uGain', 0.06);
      gl.drawArrays(gl.POINTS, 0, this._stampCount);
      gl.disable(gl.BLEND);
    }
    this.trail.swap();
  }

  /**
   * @param {import('../gl.js').Target} target
   * @param {number} t
   */
  render(target, t) {
    const ctx = this.ctx;
    if (!ctx || !this.trail || !this.renderProg) return;
    bindTarget(ctx.gl, target);
    this.renderProg.use().setTex('uTrail', this.trail.read.tex, 0).set('uT', t).draw();
  }

  /** @param {number} w @param {number} h */
  resize(w, h) {
    if (!this.ctx || !this.trail) return;
    this.trail.destroy(this.ctx.gl);
    this._alloc(w, h);
  }

  dispose() {
    if (!this.ctx) return;
    const gl = this.ctx.gl;
    if (this.dataTex) gl.deleteTexture(this.dataTex);
    this.trail?.destroy(gl);
    this.fadeProg?.destroy();
    this.stampProg?.destroy();
    this.renderProg?.destroy();
    this.dataTex = undefined;
    this.trail = undefined;
    this.fadeProg = undefined;
    this.stampProg = undefined;
    this.renderProg = undefined;
    this._tracks.length = 0;
    for (const s of this._slots) s.used = false;
    this._lastPoses = null;
    this.ctx = null;
  }
}
