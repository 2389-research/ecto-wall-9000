// ABOUTME: Skeleton Constellation mode — pose and hand landmarks become constellations of
// ABOUTME: stars and bone lines; when a person leaves, their stars drift skyward and dissolve.
// @ts-check
import { bindTarget, createTex, NOISE_GLSL, Program, uploadData } from '../gl.js';

const TEX_W = 512; // data texture width; stars in [0, LINE_BASE), line pairs after
const LINE_BASE = 256;
const POSE_N = 33;
const HAND_N = 21;
const MAX_POSE = 4;
const MAX_HAND = 4;
const MATCH_DIST = 0.25; // centroid gate for track↔detection matching, in display uv
const LEAVE_S = 8; // seconds for a leaving constellation to dissolve
const DRIFT = 0.014; // uv/s of skyward drift while dissolving

// Bone list over MediaPipe's 33-landmark pose topology, flat [a0,b0, a1,b1, ...].
const POSE_EDGES = new Uint8Array([
  0, 11, 0, 12, 11, 12, 11, 13, 13, 15, 12, 14, 14, 16, 11, 23, 12, 24, 23, 24, 23, 25, 25, 27, 24,
  26, 26, 28,
]);

// Star size per pose landmark: head and extremities read as the bright anchor stars.
const POSE_SIZE = new Float32Array(POSE_N).fill(1.0);
POSE_SIZE[0] = 2.2; // nose / head
POSE_SIZE[11] = 1.3;
POSE_SIZE[12] = 1.3; // shoulders
POSE_SIZE[15] = 1.6;
POSE_SIZE[16] = 1.6; // wrists
POSE_SIZE[23] = 1.2;
POSE_SIZE[24] = 1.2; // hips
POSE_SIZE[27] = 1.4;
POSE_SIZE[28] = 1.4; // ankles

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

/**
 * One tracked person or hand: smoothed landmarks chasing the latest detection.
 * Landmarks are stored flat as [x, y, vis] triplets in display uv (y-down).
 */
class Track {
  /**
   * @param {number} n landmark count
   * @param {{x: number, y: number, vis?: number}[]} det
   * @param {{cx: number, cy: number}} cent
   */
  constructor(n, det, cent) {
    this.n = n;
    this.pts = new Float32Array(n * 3);
    this.tgt = new Float32Array(n * 3);
    this.alpha = 0; // fades in on birth, out on leave
    this.live = true;
    this.cx = cent.cx;
    this.cy = cent.cy;
    this.hit = true;
    this._copy(this.tgt, det);
    this.pts.set(this.tgt);
  }

  /** @param {Float32Array} dst @param {{x: number, y: number, vis?: number}[]} det */
  _copy(dst, det) {
    const m = Math.min(this.n, det.length);
    for (let j = 0; j < m; j++) {
      dst[j * 3] = det[j].x;
      dst[j * 3 + 1] = det[j].y;
      dst[j * 3 + 2] = det[j].vis ?? 1;
    }
  }

  /** @param {{x: number, y: number, vis?: number}[]} det @param {{cx: number, cy: number}} cent */
  retarget(det, cent) {
    this._copy(this.tgt, det);
    this.cx = cent.cx;
    this.cy = cent.cy;
    this.live = true;
    this.hit = true;
  }

  /**
   * Advance one frame; returns false once fully dissolved.
   * @param {number} dt
   */
  advance(dt) {
    if (this.live) {
      const k = 1 - Math.exp(-dt / 0.12);
      for (let i = 0; i < this.pts.length; i++) this.pts[i] += (this.tgt[i] - this.pts[i]) * k;
      this.alpha = Math.min(1, this.alpha + dt / 1.2);
      return true;
    }
    // Leaving: the constellation holds its shape, drifts skyward, and dissolves.
    this.alpha = Math.max(0, this.alpha - dt / LEAVE_S);
    for (let j = 0; j < this.n; j++) this.pts[j * 3 + 1] -= DRIFT * dt; // y-down space: up
    return this.alpha > 0;
  }
}

/**
 * Advance every track and compact away the dissolved ones in place.
 * @param {Track[]} arr
 * @param {number} dt
 */
function compact(arr, dt) {
  let w = 0;
  for (let i = 0; i < arr.length; i++) {
    const tr = arr[i];
    if (tr.advance(dt)) arr[w++] = tr;
  }
  arr.length = w;
}

const BG_FS = `#version 300 es
precision highp float;
uniform float uT;
uniform vec2 uRes;
in vec2 vUV;
out vec4 o;
${NOISE_GLSL}
void main() {
  // deep-night gradient, darkest up top so the constellations own the sky
  vec3 c = mix(vec3(0.010, 0.014, 0.032), vec3(0.002, 0.004, 0.012), vUV.y);

  // slow nebula banks
  float neb = fbm(vUV * vec2(2.2, 1.6) + vec2(uT * 0.006, -uT * 0.004));
  c += vec3(0.020, 0.026, 0.055) * neb;

  // sparse static micro-stars on a ~3px grid, each with its own twinkle rate
  vec2 cell = floor(vUV * uRes / 3.0);
  float h = hash12(cell);
  float star = step(0.9974, h);
  float tw = 0.55 + 0.45 * sin(uT * (1.0 + h * 2.0) + h * 251.0);
  c += vec3(0.75, 0.85, 1.0) * star * tw * (0.10 + 0.55 * hash12(cell + 31.7));
  o = vec4(c, 1.0);
}`;

const STAR_VS = `#version 300 es
uniform sampler2D uData;
uniform float uT;
uniform float uScale;
uniform float uGain;
uniform float uSpread;
out float vA;
void main() {
  vec4 d = texelFetch(uData, ivec2(gl_VertexID, 0), 0);
  // landmark space is y-down (image convention); clip space is y-up
  vec2 p = vec2(d.x, 1.0 - d.y) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
  float tw = 0.70 + 0.30 * sin(uT * 2.6 + float(gl_VertexID) * 7.31);
  vA = d.w * tw * uGain;
  gl_PointSize = max(d.z * uScale * uSpread, 1.0);
}`;

const STAR_FS = `#version 300 es
precision highp float;
in float vA;
out vec4 o;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float fall = smoothstep(0.25, 0.0, dot(q, q));
  o = vec4(vec3(0.78, 0.88, 1.00) * fall * vA, 1.0);
}`;

const LINE_VS = `#version 300 es
uniform sampler2D uData;
uniform int uBase;
out float vA;
void main() {
  vec4 d = texelFetch(uData, ivec2(uBase + gl_VertexID, 0), 0);
  vec2 p = vec2(d.x, 1.0 - d.y) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
  vA = d.w;
}`;

const LINE_FS = `#version 300 es
precision highp float;
in float vA;
out vec4 o;
void main() {
  o = vec4(vec3(0.35, 0.55, 0.90) * vA * 0.30, 1.0);
}`;

export class SkeletonConstellation {
  name = 'skeleton-constellation';
  needs = { pose: true, hands: true, seg: false };

  constructor() {
    /** @type {import('../modes.js').ModeCtx | null} */
    this.ctx = null;
    /** @type {Track[]} */
    this.poseTracks = [];
    /** @type {Track[]} */
    this.handTracks = [];
    this._buf = new Float32Array(TEX_W * 4);
    this._res = [1, 1];
    this._scale = 1;
    this._starCount = 0;
    this._lineVerts = 0;
    /** @type {object | null} */
    this._lastPoses = null;
    /** @type {object | null} */
    this._lastHands = null;
  }

  /** @param {import('../modes.js').ModeCtx} ctx */
  init(ctx) {
    this.ctx = ctx;
    const gl = ctx.gl;
    this.bgProg = new Program(gl, BG_FS);
    this.starProg = new Program(gl, STAR_FS, STAR_VS);
    this.lineProg = new Program(gl, LINE_FS, LINE_VS);
    // RGBA32F wants nearest filtering; texelFetch reads are exact anyway.
    this.dataTex = createTex(gl, TEX_W, 1, { fmt: 'rgba32f', filter: 'nearest' });
    this.poseTracks.length = 0;
    this.handTracks.length = 0;
    this._lastPoses = null;
    this._lastHands = null;
    this._starCount = 0;
    this._lineVerts = 0;
    this.resize(ctx.w, ctx.h);
  }

  /**
   * Fold one detector's fresh results into its track list: retarget matches,
   * birth tracks for new arrivals, mark the abandoned as leaving.
   * @param {{x: number, y: number, vis?: number}[][]} dets
   * @param {Track[]} tracks
   * @param {number} n landmark count per detection
   * @param {number} cap
   */
  _ingest(dets, tracks, n, cap) {
    for (const tr of tracks) tr.hit = false;
    const cents = dets.map(centroidOf);
    const match = matchDetections(tracks, cents, MATCH_DIST);
    for (let d = 0; d < dets.length; d++) {
      const ti = match[d];
      if (ti >= 0) tracks[ti].retarget(dets[d], cents[d]);
      else if (tracks.length < cap) tracks.push(new Track(n, dets[d], cents[d]));
    }
    for (const tr of tracks) if (!tr.hit) tr.live = false;
  }

  /** @param {number} dt @param {number} _t */
  update(dt, _t) {
    const ctx = this.ctx;
    if (!ctx || !this.dataTex) return;
    const v = ctx.vision;
    // Detection arrays are replaced wholesale per inference; identity change = fresh data.
    if (v.poses !== this._lastPoses) {
      this._lastPoses = v.poses;
      this._ingest(v.poses, this.poseTracks, POSE_N, MAX_POSE);
    }
    if (v.hands !== this._lastHands) {
      this._lastHands = v.hands;
      this._ingest(v.hands, this.handTracks, HAND_N, MAX_HAND);
    }
    compact(this.poseTracks, dt);
    compact(this.handTracks, dt);
    this._fill(ctx.gl);
  }

  /**
   * Pack every track into the data texture: star texels first, then line
   * endpoint pairs from LINE_BASE. Texel = (x, y, size, alpha).
   * @param {WebGL2RenderingContext} gl
   */
  _fill(gl) {
    const buf = this._buf;
    let si = 0;
    for (const tr of this.poseTracks) {
      for (let j = 0; j < POSE_N; j++) {
        const o = si * 4;
        buf[o] = tr.pts[j * 3];
        buf[o + 1] = tr.pts[j * 3 + 1];
        buf[o + 2] = POSE_SIZE[j];
        buf[o + 3] = tr.alpha * (0.25 + 0.75 * vGate(tr.pts[j * 3 + 2]));
        si++;
      }
    }
    for (const tr of this.handTracks) {
      for (let j = 0; j < HAND_N; j++) {
        const o = si * 4;
        buf[o] = tr.pts[j * 3];
        buf[o + 1] = tr.pts[j * 3 + 1];
        buf[o + 2] = 0.7;
        buf[o + 3] = tr.alpha * 0.85;
        si++;
      }
    }
    let li = LINE_BASE;
    for (const tr of this.poseTracks) {
      for (let e = 0; e < POSE_EDGES.length; e += 2) {
        const a = POSE_EDGES[e] * 3;
        const b = POSE_EDGES[e + 1] * 3;
        const la = tr.alpha * vGate(tr.pts[a + 2]) * vGate(tr.pts[b + 2]);
        let o = li * 4;
        buf[o] = tr.pts[a];
        buf[o + 1] = tr.pts[a + 1];
        buf[o + 2] = 0;
        buf[o + 3] = la;
        o += 4;
        buf[o] = tr.pts[b];
        buf[o + 1] = tr.pts[b + 1];
        buf[o + 2] = 0;
        buf[o + 3] = la;
        li += 2;
      }
    }
    this._starCount = si;
    this._lineVerts = li - LINE_BASE;
    if (this.dataTex) uploadData(gl, this.dataTex, TEX_W, 1, buf, 'rgba32f');
  }

  /**
   * @param {import('../gl.js').Target} target
   * @param {number} t
   */
  render(target, t) {
    const ctx = this.ctx;
    if (!ctx || !this.bgProg || !this.starProg || !this.lineProg || !this.dataTex) return;
    const gl = ctx.gl;
    bindTarget(gl, target);
    this.bgProg.use().set('uT', t).set('uRes', this._res).draw();

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    if (this._lineVerts > 0) {
      this.lineProg.use().setTex('uData', this.dataTex, 0).setInt('uBase', LINE_BASE);
      gl.drawArrays(gl.LINES, 0, this._lineVerts);
    }
    if (this._starCount > 0) {
      const sp = this.starProg
        .use()
        .setTex('uData', this.dataTex, 0)
        .set('uT', t)
        .set('uScale', this._scale);
      // wide faint halo first, then the bright core
      sp.set('uGain', 0.1).set('uSpread', 5.0);
      gl.drawArrays(gl.POINTS, 0, this._starCount);
      sp.set('uGain', 1.0).set('uSpread', 1.0);
      gl.drawArrays(gl.POINTS, 0, this._starCount);
    }
    gl.disable(gl.BLEND);
  }

  /** @param {number} w @param {number} h */
  resize(w, h) {
    // Tracks live in uv space and the data texture is resolution-independent.
    this._res[0] = w;
    this._res[1] = h;
    this._scale = (h / 1080) * 7;
  }

  dispose() {
    if (!this.ctx) return;
    const gl = this.ctx.gl;
    if (this.dataTex) gl.deleteTexture(this.dataTex);
    this.bgProg?.destroy();
    this.starProg?.destroy();
    this.lineProg?.destroy();
    this.dataTex = undefined;
    this.bgProg = undefined;
    this.starProg = undefined;
    this.lineProg = undefined;
    this.poseTracks.length = 0;
    this.handTracks.length = 0;
    this.ctx = null;
  }
}
