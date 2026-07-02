// ABOUTME: ModeManager — owns the scene render targets, drives the CycleScheduler, lazily
// ABOUTME: inits/disposes modes, and crossfades between them with a motion-reactive dissolve.
// @ts-check
import { bindTarget, createTarget, destroyTarget, NOISE_GLSL, Program } from './gl.js';
import { CycleScheduler, fadeEnvelope } from './signals.js';

/**
 * The shared context handed to every mode. One object, mutated on resize.
 * @typedef {Object} ModeCtx
 * @property {WebGL2RenderingContext} gl
 * @property {import('./vision.js').Vision} vision
 * @property {import('./signals.js').Signals} signals
 * @property {number} w stage width in pixels
 * @property {number} h stage height in pixels
 */

/**
 * The contract every mode implements.
 * @typedef {Object} Mode
 * @property {string} name
 * @property {{pose: boolean, hands: boolean, seg: boolean}} needs
 * @property {(ctx: ModeCtx) => void} init
 * @property {(dt: number, t: number) => void} update
 * @property {(target: import('./gl.js').Target, t: number) => void} render
 * @property {(w: number, h: number) => void} resize
 * @property {() => void} dispose
 */

// Motion-reactive dissolve: the incoming mode is revealed first wherever the room is
// moving; in a still room a drifting noise field makes the fade organic instead of linear.
const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform sampler2D uMotion;
uniform float uMix;
uniform float uT;
in vec2 vUV;
out vec4 outColor;
${NOISE_GLSL}

const float S = 0.18; // softness of the reveal edge

void main() {
  float n = vnoise(vUV * 5.0 + vec2(uT * 0.07, -uT * 0.05));
  float m = clamp(texture(uMotion, vUV).z * 1.6, 0.0, 1.0);
  float th = 1.0 - clamp(0.65 * m + 0.35 * n, 0.0, 1.0);
  float x = uMix * (1.0 + 2.0 * S) - S;
  float reveal = smoothstep(th - S, th + S, x);
  outColor = mix(texture(uFrom, vUV), texture(uTo, vUV), reveal);
}`;

export class ModeManager {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {import('./vision.js').Vision} vision
   * @param {import('./signals.js').Signals} signals
   * @param {Mode[]} modes
   * @param {{dwell?: number, fade?: number, auto?: boolean}} [opts]
   */
  constructor(gl, vision, signals, modes, opts = {}) {
    this.gl = gl;
    this.vision = vision;
    this.modes = modes;
    /** @type {Map<string, Mode>} */
    this.byName = new Map(modes.map((m) => [m.name, m]));
    this.scheduler = new CycleScheduler(
      modes.map((m) => m.name),
      opts,
    );
    this.compositeProg = new Program(gl, COMPOSITE_FS);
    /** @type {ModeCtx} */
    this.ctx = { gl, vision, signals, w: 0, h: 0 };
    /** @type {Set<string>} */
    this._inited = new Set();
    this._lastActive = '';
    /** @type {string | null} */
    this._lastIncoming = null;
    /** @type {import('./gl.js').Target | null} */
    this.sceneA = null;
    /** @type {import('./gl.js').Target | null} */
    this.sceneB = null;
    /** @type {import('./gl.js').Target | null} */
    this.sceneOut = null;
  }

  get modeNames() {
    return this.modes.map((m) => m.name);
  }

  /** Re-filter the cycle to modes whose vision needs can currently be served. */
  refreshAvailability() {
    const ok = this.modes.filter((m) => this.vision.canServe(m.needs)).map((m) => m.name);
    this.scheduler.setAvailable(ok);
  }

  /** @param {number} w @param {number} h */
  resize(w, h) {
    if (w === this.ctx.w && h === this.ctx.h) return;
    const gl = this.gl;
    if (this.sceneA) destroyTarget(gl, this.sceneA);
    if (this.sceneB) destroyTarget(gl, this.sceneB);
    if (this.sceneOut) destroyTarget(gl, this.sceneOut);
    this.sceneA = createTarget(gl, w, h, { fmt: 'rgba8' });
    this.sceneB = createTarget(gl, w, h, { fmt: 'rgba8' });
    this.sceneOut = createTarget(gl, w, h, { fmt: 'rgba8' });
    this.ctx.w = w;
    this.ctx.h = h;
    for (const name of this._inited) {
      this.byName.get(name)?.resize(w, h);
    }
  }

  /** Init newly-live modes, dispose ones that fully faded out, sync vision needs. */
  _syncLive() {
    const s = this.scheduler;
    if (s.active === this._lastActive && s.incoming === this._lastIncoming) return;
    this._lastActive = s.active;
    this._lastIncoming = s.incoming;
    let pose = false;
    let hands = false;
    let seg = false;
    for (const m of this.modes) {
      const live = m.name === s.active || m.name === s.incoming;
      if (live && !this._inited.has(m.name)) {
        m.init(this.ctx);
        this._inited.add(m.name);
      } else if (!live && this._inited.has(m.name)) {
        m.dispose();
        this._inited.delete(m.name);
      }
      if (live) {
        pose = pose || m.needs.pose;
        hands = hands || m.needs.hands;
        seg = seg || m.needs.seg;
      }
    }
    this.vision.setNeeds({ pose, hands, seg });
  }

  /** @param {number} dt @param {number} t */
  update(dt, t) {
    if (!this.sceneA) return;
    this.scheduler.tick(dt);
    this._syncLive();
    const s = this.scheduler;
    this.byName.get(s.active)?.update(dt, t);
    if (s.incoming) this.byName.get(s.incoming)?.update(dt, t);
  }

  /**
   * Render the current mode (or crossfading pair) and return the scene texture for post.
   * @param {number} t
   * @returns {WebGLTexture | null}
   */
  render(t) {
    const { sceneA, sceneB, sceneOut } = this;
    if (!sceneA || !sceneB || !sceneOut) return null;
    const s = this.scheduler;
    const active = this.byName.get(s.active);
    if (!active) return null;
    active.render(sceneA, t);
    const incoming = s.incoming ? this.byName.get(s.incoming) : null;
    if (!incoming) return sceneA.tex;

    incoming.render(sceneB, t);
    bindTarget(this.gl, sceneOut);
    this.compositeProg
      .use()
      .setTex('uFrom', sceneA.tex, 0)
      .setTex('uTo', sceneB.tex, 1)
      .setTex('uMotion', this.vision.motionTex, 2)
      .set('uMix', fadeEnvelope(s.mixT))
      .set('uT', t)
      .draw();
    return sceneOut.tex;
  }

  /** @param {string} name */
  pin(name) {
    return this.scheduler.pin(name);
  }

  next() {
    this.scheduler.next();
  }

  prev() {
    this.scheduler.prev();
  }

  resumeAuto() {
    this.scheduler.resumeAuto();
  }

  state() {
    return this.scheduler.state();
  }
}
