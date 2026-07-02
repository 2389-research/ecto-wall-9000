// ABOUTME: Ripple Tank mode — a wave-equation water surface; room motion is a moving wave
// ABOUTME: source, and the render shows the camera's world refracted through dark water.
// @ts-check
import { bindTarget, createPingPong, Program } from '../gl.js';

// Wave state texel: R = height now, G = height previous step.
const SIM_FS = `#version 300 es
precision highp float;
uniform sampler2D uWave;
uniform sampler2D uMotion;
uniform vec2 uPx;
in vec2 vUV;
out vec4 o;
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

  nh = clamp(nh, -2.0, 2.0);
  o = vec4(nh, w.r, 0.0, 1.0);
}`;

const RENDER_FS = `#version 300 es
precision highp float;
uniform sampler2D uWave;
uniform sampler2D uCam;
uniform vec2 uPx;
in vec2 vUV;
out vec4 outColor;
void main() {
  float h = texture(uWave, vUV).r;
  vec2 grad = vec2(
    texture(uWave, vUV + vec2(uPx.x, 0.0)).r - texture(uWave, vUV - vec2(uPx.x, 0.0)).r,
    texture(uWave, vUV + vec2(0.0, uPx.y)).r - texture(uWave, vUV - vec2(0.0, uPx.y)).r
  );

  // The room, refracted through the surface, as a cold dim reflection.
  vec3 cam = texture(uCam, vUV + grad * 0.65).rgb;
  float lum = dot(cam, vec3(0.299, 0.587, 0.114));
  vec3 seen = vec3(0.30, 0.55, 0.60) * lum * 0.34;

  // Deep water gradient plus wave-crest luminance.
  vec3 deep = mix(vec3(0.010, 0.035, 0.060), vec3(0.020, 0.090, 0.125), vUV.y);
  vec3 col = deep + seen + vec3(0.10, 0.30, 0.35) * abs(h) * 1.3;

  // Specular glints off the wavefronts.
  vec3 n = normalize(vec3(-grad * 14.0, 1.0));
  float spec = pow(max(dot(n, normalize(vec3(0.30, 0.45, 0.80))), 0.0), 60.0);
  col += vec3(0.9, 0.95, 1.0) * spec * 0.28;

  outColor = vec4(col, 1.0);
}`;

export class RippleTank {
  name = 'ripple-tank';
  needs = { pose: false, hands: false, seg: false };

  constructor() {
    /** @type {import('../modes.js').ModeCtx | null} */
    this.ctx = null;
    this._px = [0, 0];
  }

  /** @param {import('../modes.js').ModeCtx} ctx */
  init(ctx) {
    this.ctx = ctx;
    this.simProg = new Program(ctx.gl, SIM_FS);
    this.renderProg = new Program(ctx.gl, RENDER_FS);
    this._alloc(ctx.w, ctx.h);
  }

  /** @param {number} w @param {number} h */
  _alloc(w, h) {
    const gl = /** @type {import('../modes.js').ModeCtx} */ (this.ctx).gl;
    const ww = Math.max(160, Math.round(w / 2));
    const wh = Math.max(90, Math.round(h / 2));
    this.wave = createPingPong(gl, ww, wh, { fmt: 'rgba16f' });
    this._px[0] = 1 / ww;
    this._px[1] = 1 / wh;
  }

  /** @param {number} _dt @param {number} _t */
  update(_dt, _t) {
    const ctx = this.ctx;
    if (!ctx || !this.wave || !this.simProg) return;
    const gl = ctx.gl;
    bindTarget(gl, this.wave.write);
    this.simProg
      .use()
      .setTex('uWave', this.wave.read.tex, 0)
      .setTex('uMotion', ctx.vision.motionTex, 1)
      .set('uPx', this._px)
      .draw();
    this.wave.swap();
  }

  /**
   * @param {import('../gl.js').Target} target
   * @param {number} _t
   */
  render(target, _t) {
    const ctx = this.ctx;
    if (!ctx || !this.wave || !this.renderProg) return;
    bindTarget(ctx.gl, target);
    this.renderProg
      .use()
      .setTex('uWave', this.wave.read.tex, 0)
      .setTex('uCam', ctx.vision.camTex, 1)
      .set('uPx', this._px)
      .draw();
  }

  /** @param {number} w @param {number} h */
  resize(w, h) {
    if (!this.ctx || !this.wave) return;
    this.wave.destroy(this.ctx.gl);
    this._alloc(w, h);
  }

  dispose() {
    if (!this.ctx) return;
    this.wave?.destroy(this.ctx.gl);
    this.simProg?.destroy();
    this.renderProg?.destroy();
    this.wave = undefined;
    this.simProg = undefined;
    this.renderProg = undefined;
    this.ctx = null;
  }
}
