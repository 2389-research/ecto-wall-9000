// ABOUTME: Particle Wake mode — a fixed population of GPU particles drifts on curl noise;
// ABOUTME: room motion injects velocity so walkers tow glowing wakes through the field.
// @ts-check
import { bindTarget, createPingPong, NOISE_GLSL, Program } from '../gl.js';

const DIM = 384; // 147,456 particles, state resident in an RGBA32F ping-pong
const AUDIO_KICK = 0.9; // beat → per-particle velocity jitter burst (uv/s per envelope unit)

// State texel: pos.xy in stage uv, vel.zw in uv/s.
const SIM_FS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform sampler2D uMotion;
uniform float uDt;
uniform float uT;
uniform float uSeed;
uniform float uBass; // 0-1: bass swells the curl drift
uniform float uKick; // beat impulse: brief per-particle jitter burst
in vec2 vUV;
out vec4 o;
${NOISE_GLSL}

void main() {
  if (uSeed > 0.5) {
    o = vec4(hash22(vUV * 913.37 + 17.17), 0.0, 0.0);
    return;
  }
  vec4 s = texture(uState, vUV);
  vec2 pos = s.xy;
  vec2 vel = s.zw;

  // Room motion kicks particles along the flow, hard.
  vec4 mo = texture(uMotion, pos);
  vel += mo.xy * smoothstep(0.10, 1.0, mo.z) * uDt * 6.0;

  // Everything relaxes back toward a slow curl-noise drift; bass leans on the weather.
  vec2 drift = curl2(pos * 3.0 + vec2(uT * 0.021, -uT * 0.017)) * (0.022 + 0.030 * uBass);
  vel = mix(vel, drift, 1.0 - exp(-uDt / 2.5));

  // Beats kick the whole swarm: every particle gets its own random shove.
  vel += (hash22(pos * 771.3 + vUV) - 0.5) * uKick * uDt;

  float sp = length(vel);
  if (sp > 0.35) vel *= 0.35 / sp;

  pos = fract(pos + vel * uDt);
  o = vec4(pos, vel);
}`;

const POINT_VS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform int uDim;
uniform float uTreble; // 0-1: sparkle — hot cores swell on treble
out float vSpeed;
void main() {
  ivec2 tc = ivec2(gl_VertexID % uDim, gl_VertexID / uDim);
  vec4 s = texelFetch(uState, tc, 0);
  vSpeed = length(s.zw);
  gl_Position = vec4(s.xy * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0 + smoothstep(0.0, 0.30, vSpeed) * (2.0 + uTreble * 2.5);
}`;

const POINT_FS = `#version 300 es
precision highp float;
in float vSpeed;
out vec4 o;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float a = smoothstep(0.25, 0.0, dot(d, d));
  vec3 slow = vec3(0.10, 0.16, 0.35);
  vec3 fast = vec3(0.60, 0.88, 1.00);
  vec3 c = mix(slow, fast, smoothstep(0.005, 0.25, vSpeed));
  o = vec4(c * a * 0.30, 1.0);
}`;

const FADE_FS = `#version 300 es
precision highp float;
uniform sampler2D uPrev;
uniform float uDecay;
in vec2 vUV;
out vec4 o;
void main() {
  o = texture(uPrev, vUV) * uDecay;
}`;

const RENDER_FS = `#version 300 es
precision highp float;
uniform sampler2D uAccum;
uniform float uT;
in vec2 vUV;
out vec4 outColor;
${NOISE_GLSL}
void main() {
  vec3 c = texture(uAccum, vUV).rgb;
  c = 1.0 - exp(-c * 1.6); // soft-clip stacked trails

  // abyssal backdrop with the faintest drifting nebula
  float neb = fbm(vUV * 2.5 + vec2(uT * 0.008, uT * 0.006));
  c += vec3(0.02, 0.03, 0.06) * neb;
  outColor = vec4(c, 1.0);
}`;

export class ParticleWake {
  name = 'particle-wake';
  needs = { pose: false, hands: false, seg: false };

  constructor() {
    /** @type {import('../modes.js').ModeCtx | null} */
    this.ctx = null;
    this._seeded = false;
    this._lastDt = 1 / 60;
  }

  /** @param {import('../modes.js').ModeCtx} ctx */
  init(ctx) {
    this.ctx = ctx;
    const gl = ctx.gl;
    this.simProg = new Program(gl, SIM_FS);
    this.pointProg = new Program(gl, POINT_FS, POINT_VS);
    this.fadeProg = new Program(gl, FADE_FS);
    this.renderProg = new Program(gl, RENDER_FS);
    // RGBA32F is not linear-filterable; state reads are texel-exact anyway.
    this.state = createPingPong(gl, DIM, DIM, { fmt: 'rgba32f', filter: 'nearest' });
    this._seeded = false;
    this._allocAccum(ctx.w, ctx.h);
  }

  /** @param {number} w @param {number} h */
  _allocAccum(w, h) {
    const gl = /** @type {import('../modes.js').ModeCtx} */ (this.ctx).gl;
    this.accum = createPingPong(gl, w, h, { fmt: 'rgba16f' });
  }

  /** @param {number} dt @param {number} t */
  update(dt, t) {
    const ctx = this.ctx;
    if (!ctx || !this.state || !this.simProg) return;
    this._lastDt = dt;
    const gl = ctx.gl;
    bindTarget(gl, this.state.write);
    this.simProg
      .use()
      .setTex('uState', this.state.read.tex, 0)
      .setTex('uMotion', ctx.vision.motionTex, 1)
      .set('uDt', dt)
      .set('uT', t)
      .set('uSeed', this._seeded ? 0 : 1)
      .set('uBass', ctx.signals.bass)
      .set('uKick', ctx.signals.beat * AUDIO_KICK)
      .draw();
    this.state.swap();
    this._seeded = true;
  }

  /**
   * @param {import('../gl.js').Target} target
   * @param {number} t
   */
  render(target, t) {
    const ctx = this.ctx;
    if (!ctx || !this.state || !this.accum) return;
    if (!this.pointProg || !this.fadeProg || !this.renderProg) return;
    const gl = ctx.gl;

    // trails decay...
    bindTarget(gl, this.accum.write);
    this.fadeProg
      .use()
      .setTex('uPrev', this.accum.read.tex, 0)
      .set('uDecay', Math.exp(-this._lastDt / 1.2))
      .draw();

    // ...and the swarm burns additively on top.
    this.pointProg
      .use()
      .setTex('uState', this.state.read.tex, 0)
      .setInt('uDim', DIM)
      .set('uTreble', ctx.signals.treble);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.POINTS, 0, DIM * DIM);
    gl.disable(gl.BLEND);
    this.accum.swap();

    bindTarget(gl, target);
    this.renderProg.use().setTex('uAccum', this.accum.read.tex, 0).set('uT', t).draw();
  }

  /** @param {number} w @param {number} h */
  resize(w, h) {
    if (!this.ctx || !this.accum) return;
    // Particle state lives in uv space, so the population survives; only trails realloc.
    this.accum.destroy(this.ctx.gl);
    this._allocAccum(w, h);
  }

  dispose() {
    if (!this.ctx) return;
    const gl = this.ctx.gl;
    this.state?.destroy(gl);
    this.accum?.destroy(gl);
    this.simProg?.destroy();
    this.pointProg?.destroy();
    this.fadeProg?.destroy();
    this.renderProg?.destroy();
    this.state = undefined;
    this.accum = undefined;
    this.simProg = undefined;
    this.pointProg = undefined;
    this.fadeProg = undefined;
    this.renderProg = undefined;
    this.ctx = null;
  }
}
