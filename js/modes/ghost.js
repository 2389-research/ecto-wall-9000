// ABOUTME: Ghost Field mode — motion deposits soft presence into a trail buffer that is
// ABOUTME: advected along the flow, diffuses outward, and ages through a chromatic palette.
// @ts-check
import { bindTarget, createPingPong, NOISE_GLSL, Program } from '../gl.js';

// Trail state texture: R = presence energy, G = age in seconds.
const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D uPrev;
uniform sampler2D uMotion;
uniform vec2 uPx;
uniform float uDt;
uniform float uDecay;
in vec2 vUV;
out vec4 o;
void main() {
  vec4 mo = texture(uMotion, vUV);
  // Pull history along the flow so trails smear the way the person moved.
  vec2 adv = vUV - mo.xy * uDt * 0.35;
  vec4 center = texture(uPrev, adv);
  vec4 blur = texture(uPrev, adv + vec2(uPx.x, 0.0))
            + texture(uPrev, adv - vec2(uPx.x, 0.0))
            + texture(uPrev, adv + vec2(0.0, uPx.y))
            + texture(uPrev, adv - vec2(0.0, uPx.y));
  vec4 prev = mix(center, blur * 0.25, 0.22); // slow outward diffusion

  float deposit = smoothstep(0.12, 0.65, mo.z);
  float energy = max(prev.r * uDecay, deposit);
  float age = mix(min(prev.g + uDt, 120.0), 0.0, clamp(deposit * 2.0, 0.0, 1.0));
  o = vec4(energy, age, 0.0, 1.0);
}`;

const RENDER_FS = `#version 300 es
precision highp float;
uniform sampler2D uTrail;
uniform float uT;
in vec2 vUV;
out vec4 outColor;
${NOISE_GLSL}

void main() {
  vec4 tr = texture(uTrail, vUV);
  float energy = tr.r;
  float age = tr.g;

  // Chromatic aging: fresh apparitions are pale teal, cooling to blue, dying violet.
  vec3 fresh = vec3(0.75, 0.95, 1.00);
  vec3 mid   = vec3(0.35, 0.55, 0.95);
  vec3 old   = vec3(0.45, 0.25, 0.65);
  vec3 col = mix(fresh, mid, smoothstep(0.0, 20.0, age));
  col = mix(col, old, smoothstep(15.0, 70.0, age));

  float glow = pow(clamp(energy, 0.0, 1.0), 1.4);
  // A slow shimmer runs through the ectoplasm so trails feel alive.
  float shimmer = 0.85 + 0.15 * vnoise(vUV * 9.0 + vec2(uT * 0.20, -uT * 0.13));
  vec3 c = col * glow * shimmer * 0.9;

  // Ambient fog floor so an empty room is a dim haunted volume, not a void.
  float fog = fbm(vUV * 3.0 + vec2(uT * 0.02, uT * 0.013));
  c += vec3(0.045, 0.075, 0.115) * fog * 0.55;

  outColor = vec4(c, 1.0);
}`;

export class GhostField {
  name = 'ghost-field';
  needs = { pose: false, hands: false, seg: false };

  // Presence half-life feel: exp decay with tau ~= 22s reads as roughly a minute of afterglow.
  static TAU = 22;

  constructor() {
    /** @type {import('../modes.js').ModeCtx | null} */
    this.ctx = null;
    this._px = [0, 0];
  }

  /** @param {import('../modes.js').ModeCtx} ctx */
  init(ctx) {
    this.ctx = ctx;
    this.updateProg = new Program(ctx.gl, UPDATE_FS);
    this.renderProg = new Program(ctx.gl, RENDER_FS);
    this._alloc(ctx.w, ctx.h);
  }

  /** @param {number} w @param {number} h */
  _alloc(w, h) {
    const gl = /** @type {import('../modes.js').ModeCtx} */ (this.ctx).gl;
    const tw = Math.max(160, Math.round(w / 2));
    const th = Math.max(90, Math.round(h / 2));
    this.trail = createPingPong(gl, tw, th, { fmt: 'rgba16f' });
    this._px[0] = 1 / tw;
    this._px[1] = 1 / th;
  }

  /** @param {number} dt @param {number} _t */
  update(dt, _t) {
    const ctx = this.ctx;
    if (!ctx || !this.trail || !this.updateProg) return;
    const gl = ctx.gl;
    bindTarget(gl, this.trail.write);
    this.updateProg
      .use()
      .setTex('uPrev', this.trail.read.tex, 0)
      .setTex('uMotion', ctx.vision.motionTex, 1)
      .set('uPx', this._px)
      .set('uDt', dt)
      .set('uDecay', Math.exp(-dt / GhostField.TAU))
      .draw();
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
    this.trail?.destroy(this.ctx.gl);
    this.updateProg?.destroy();
    this.renderProg?.destroy();
    this.trail = undefined;
    this.updateProg = undefined;
    this.renderProg = undefined;
    this.ctx = null;
  }
}
