// ABOUTME: Coral Bloom mode — a Gray-Scott reaction-diffusion sim where room motion seeds
// ABOUTME: living coral growth; feed/kill drift slowly so the colony keeps renegotiating itself.
// @ts-check
import { bindTarget, createPingPong, NOISE_GLSL, Program } from '../gl.js';

/**
 * Feed/kill/steps for this frame. The sine drifts are tuned to stay inside the
 * pattern-forming band of the Gray-Scott parameter map (coral, mitosis, worms) —
 * outside it the reaction collapses to a flat gray field. Motion buys extra sim
 * steps, so a busy room literally accelerates growth.
 * @param {number} t wall-clock seconds (wraps hourly upstream; a rare phase hop is fine)
 * @param {number} dt frame seconds
 * @param {number} motion 0..1 room motion energy
 * @param {{f: number, k: number, steps: number}} [out]
 */
export function coralParams(t, dt, motion, out = { f: 0, k: 0, steps: 0 }) {
  out.f = 0.0545 + 0.0035 * Math.sin(t * 0.011);
  out.k = 0.062 + 0.0022 * Math.sin(t * 0.017 + 2.1);
  const rate = 480 + 480 * Math.min(1, Math.max(0, motion));
  out.steps = Math.max(1, Math.min(24, Math.round(rate * dt)));
  return out;
}

/** Fresh ambient-seed scheduler: dormant, first check a few seconds after init. */
export function makeSeeder() {
  return { seed: new Float32Array(4), cooldown: 3 };
}

/**
 * Advance the ambient seeder one frame. In a still room it drops a spore disc at a
 * random spot every several seconds so an empty wall still grows; a moving room
 * seeds itself through the motion field, so the scheduler just re-arms quietly.
 * The seed (x, y, radius, strength) lives for exactly one call.
 * @param {{seed: Float32Array, cooldown: number}} st
 * @param {{motion: number, dt: number, rand: () => number}} env
 */
export function stepSeeder(st, env) {
  st.cooldown -= env.dt;
  st.seed[3] = 0;
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

// Sim state texture: R = chemical A (substrate), G = chemical B (the growing pattern).
const SIM_FS = `#version 300 es
precision highp float;
uniform sampler2D uPrev;
uniform sampler2D uMotion;
uniform vec2 uPx;
uniform float uF;
uniform float uK;
uniform float uInject; // 1 on the first step of a frame: motion + ambient seed deposit B
uniform vec4 uSeed;    // xy pos, z radius, w strength
in vec2 vUV;
out vec4 o;
void main() {
  vec2 c = texture(uPrev, vUV).rg;
  // Classic 9-point laplacian: orthogonal 0.2, diagonal 0.05, center -1.
  vec2 lap = -c
    + 0.2  * (texture(uPrev, vUV + vec2(uPx.x, 0.0)).rg
            + texture(uPrev, vUV - vec2(uPx.x, 0.0)).rg
            + texture(uPrev, vUV + vec2(0.0, uPx.y)).rg
            + texture(uPrev, vUV - vec2(0.0, uPx.y)).rg)
    + 0.05 * (texture(uPrev, vUV + uPx).rg
            + texture(uPrev, vUV - uPx).rg
            + texture(uPrev, vUV + vec2(uPx.x, -uPx.y)).rg
            + texture(uPrev, vUV - vec2(uPx.x, -uPx.y)).rg);

  // A slight feed/kill gradient across the wall grows different species per region.
  float f = uF + (vUV.x - 0.5) * 0.0018;
  float k = uK + (vUV.y - 0.5) * 0.0012;

  float rxn = c.r * c.g * c.g;
  float A = c.r + (1.0 * lap.r - rxn + f * (1.0 - c.r));
  float B = c.g + (0.5 * lap.g + rxn - (f + k) * c.g);

  if (uInject > 0.5) {
    B = max(B, smoothstep(0.15, 0.6, texture(uMotion, vUV).z) * 0.5);
    B = max(B, uSeed.w * smoothstep(uSeed.z, uSeed.z * 0.3, distance(vUV, uSeed.xy)));
  }
  o = vec4(clamp(A, 0.0, 1.0), clamp(B, 0.0, 1.0), 0.0, 1.0);
}`;

const RENDER_FS = `#version 300 es
precision highp float;
uniform sampler2D uSim;
uniform vec2 uPx;
uniform float uT;
in vec2 vUV;
out vec4 outColor;
${NOISE_GLSL}
void main() {
  float B = texture(uSim, vUV).g;

  // Rim light along the reaction front, where the pattern is actively growing.
  float gx = texture(uSim, vUV + vec2(uPx.x, 0.0)).g - texture(uSim, vUV - vec2(uPx.x, 0.0)).g;
  float gy = texture(uSim, vUV + vec2(0.0, uPx.y)).g - texture(uSim, vUV - vec2(0.0, uPx.y)).g;
  float edge = clamp(length(vec2(gx, gy)) * 6.0, 0.0, 1.0);

  // Abyssal floor with a slow drift so an empty wall reads as deep water, not a void.
  float fog = fbm(vUV * 2.6 + vec2(uT * 0.014, -uT * 0.009));
  vec3 col = vec3(0.008, 0.014, 0.030) + vec3(0.020, 0.034, 0.052) * fog;

  // Colony body breathes between bioluminescent teal and violet over ~10 minutes.
  vec3 teal = vec3(0.10, 0.45, 0.42);
  vec3 violet = vec3(0.30, 0.16, 0.52);
  vec3 body = mix(teal, violet, 0.5 + 0.5 * sin(uT * 0.01));
  col += body * smoothstep(0.08, 0.35, B);

  // Growth fronts glow coral-warm; fresh dense deposits flash white-hot.
  col += vec3(0.95, 0.45, 0.30) * edge * 0.55;
  col += vec3(0.90, 0.95, 1.00) * smoothstep(0.42, 0.62, B) * 0.35;

  // Faint caustic shimmer over the whole reef.
  col *= 0.92 + 0.08 * vnoise(vUV * 11.0 + vec2(uT * 0.21, uT * 0.17));

  outColor = vec4(col, 1.0);
}`;

export class CoralBloom {
  name = 'coral-bloom';
  needs = { pose: false, hands: false, seg: false };

  constructor() {
    /** @type {import('../modes.js').ModeCtx | null} */
    this.ctx = null;
    this._px = [0, 0];
    this._params = { f: 0.0545, k: 0.062, steps: 8 };
    this._seeder = makeSeeder();
    this._seed = [0, 0, 0, 0];
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
    const tw = Math.max(160, Math.round(w / 2));
    const th = Math.max(90, Math.round(h / 2));
    this.sim = createPingPong(gl, tw, th, { fmt: 'rgba16f' });
    this._px[0] = 1 / tw;
    this._px[1] = 1 / th;
    // Substrate full, pattern empty: A=1, B=0 everywhere until something seeds it.
    gl.clearColor(1, 0, 0, 1);
    bindTarget(gl, this.sim.a);
    gl.clear(gl.COLOR_BUFFER_BIT);
    bindTarget(gl, this.sim.b);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.clearColor(0, 0, 0, 1);
  }

  /** @param {number} dt @param {number} t */
  update(dt, t) {
    const ctx = this.ctx;
    if (!ctx || !this.sim || !this.simProg) return;
    const gl = ctx.gl;
    const p = coralParams(t, dt, ctx.signals.motionEnergy, this._params);
    stepSeeder(this._seeder, { motion: ctx.signals.motionEnergy, dt, rand: Math.random });
    for (let i = 0; i < 4; i++) this._seed[i] = this._seeder.seed[i];

    for (let i = 0; i < p.steps; i++) {
      bindTarget(gl, this.sim.write);
      this.simProg
        .use()
        .setTex('uPrev', this.sim.read.tex, 0)
        .setTex('uMotion', ctx.vision.motionTex, 1)
        .set('uPx', this._px)
        .set('uF', p.f)
        .set('uK', p.k)
        .set('uInject', i === 0 ? 1 : 0)
        .set('uSeed', this._seed)
        .draw();
      this.sim.swap();
    }
  }

  /**
   * @param {import('../gl.js').Target} target
   * @param {number} t
   */
  render(target, t) {
    const ctx = this.ctx;
    if (!ctx || !this.sim || !this.renderProg) return;
    bindTarget(ctx.gl, target);
    this.renderProg
      .use()
      .setTex('uSim', this.sim.read.tex, 0)
      .set('uPx', this._px)
      .set('uT', t)
      .draw();
  }

  /** @param {number} w @param {number} h */
  resize(w, h) {
    if (!this.ctx || !this.sim) return;
    this.sim.destroy(this.ctx.gl);
    this._alloc(w, h);
  }

  dispose() {
    if (!this.ctx) return;
    this.sim?.destroy(this.ctx.gl);
    this.simProg?.destroy();
    this.renderProg?.destroy();
    this.sim = undefined;
    this.simProg = undefined;
    this.renderProg = undefined;
    this.ctx = null;
  }
}
