// ABOUTME: Room Weather mode — a procedural sky whose wind, storminess, warmth, turbulence,
// ABOUTME: lightning, and rain are modulated by room motion, person count, and hand activity.
// @ts-check
import { bindTarget, NOISE_GLSL, Program } from '../gl.js';
import { ema } from '../signals.js';

// Wind phase wraps rarely to protect float precision on week-long runs; the one-frame
// pattern jump at the wrap is far rarer than the hourly uT wrap the other modes accept.
const WIND_WRAP = 2048;

/**
 * Map room signals to weather parameter targets — the spec's modulation matrix.
 * Motion + recent history drive the storm, people warm the palette, hands stir turbulence.
 * @param {{motionEnergy: number, personCount: number, handActivity: number, pressure: number}} s
 * @param {{wind?: number, storm?: number, warmth?: number, turb?: number}} [out]
 */
export function weatherTargets(s, out = {}) {
  out.wind = 0.012 + s.motionEnergy * 0.14;
  out.storm = Math.min(1, s.motionEnergy * 0.8 + s.pressure * 0.9);
  out.warmth = Math.min(1, s.personCount / 2.5);
  out.turb = Math.min(1, s.handActivity * 1.2);
  return out;
}

/**
 * Fresh lightning state: three flash slots, flat [x, y, age, intensity] per slot,
 * born old and dark so nothing glows at boot.
 */
export function makeLightning() {
  const flashes = new Float32Array(12);
  for (let i = 0; i < 3; i++) flashes[i * 4 + 2] = 99;
  return { flashes, next: 0, cooldown: 0 };
}

/**
 * Advance lightning one frame: age every slot, and when the room is stormy, moving,
 * and the cooldown has lapsed, strike into the next slot round-robin.
 * @param {{flashes: Float32Array, next: number, cooldown: number}} st
 * @param {{storm: number, motion: number, dt: number, rand: () => number}} env
 */
export function stepLightning(st, env) {
  st.cooldown -= env.dt;
  for (let i = 0; i < 3; i++) st.flashes[i * 4 + 2] += env.dt;
  if (st.cooldown <= 0 && env.storm > 0.5 && env.motion > 0.5) {
    const o = st.next * 4;
    st.flashes[o] = 0.15 + env.rand() * 0.7;
    st.flashes[o + 1] = 0.55 + env.rand() * 0.35; // upper sky, in GL uv (v up)
    st.flashes[o + 2] = 0;
    st.flashes[o + 3] = 0.7 + env.rand() * 0.5;
    st.next = (st.next + 1) % 3;
    st.cooldown = 2.5 + env.rand() * 4;
  }
  return st;
}

const WEATHER_FS = `#version 300 es
precision highp float;
uniform float uT;
uniform vec2 uWind;    // accumulated wind phase
uniform float uStorm;  // 0 calm .. 1 tempest
uniform float uWarmth; // 0 empty-cold .. 1 crowd-warm
uniform float uTurb;   // hand-driven turbulence
uniform vec4 uFlash0;  // xy pos, z age, w intensity
uniform vec4 uFlash1;
uniform vec4 uFlash2;
in vec2 vUV;
out vec4 outColor;
${NOISE_GLSL}

// Domain-warped clouds: hands stirring the room literally stir the warp.
float cloud(vec2 p) {
  float warp = 1.4 + uTurb * 2.2;
  vec2 q = vec2(fbm(p), fbm(p + vec2(5.2, 1.3)));
  vec2 r = vec2(fbm(p + q * warp + vec2(1.7, 9.2)), fbm(p + q * warp + vec2(8.3, 2.8)));
  return fbm(p + r * 1.8);
}

float flashPulse(vec4 f, vec2 uv) {
  float pulse = f.w * exp(-f.z * 5.0);
  pulse *= 0.75 + 0.25 * sin(f.z * 55.0); // strobe flicker
  return pulse * exp(-distance(uv, f.xy) * 4.0);
}

void main() {
  vec2 uv = vUV;

  // Fresh strikes tear the raster for a few frames: the spec's glitch parameter.
  float fresh = max(max(uFlash0.w * exp(-uFlash0.z * 5.0), uFlash1.w * exp(-uFlash1.z * 5.0)),
                    uFlash2.w * exp(-uFlash2.z * 5.0));
  float glitch = smoothstep(0.35, 1.0, fresh) * uStorm;
  uv.x += (hash12(vec2(floor(uv.y * 90.0), floor(uT * 47.0))) - 0.5) * glitch * 0.03;

  vec2 p = uv * vec2(3.0, 2.1) + uWind;
  float cl = cloud(p);
  float dens = smoothstep(0.55 - uStorm * 0.35, 0.9, cl);

  // Sky gradient collapses from deep blue night to bruised slate as the storm builds.
  vec3 zen = mix(vec3(0.015, 0.030, 0.075), vec3(0.028, 0.030, 0.038), uStorm);
  vec3 hor = mix(vec3(0.060, 0.100, 0.170), vec3(0.075, 0.070, 0.080), uStorm);
  vec3 sky = mix(hor, zen, uv.y);

  vec3 cloudLo = mix(vec3(0.10, 0.13, 0.20), vec3(0.045, 0.045, 0.060), uStorm);
  vec3 cloudHi = mix(vec3(0.30, 0.36, 0.46), vec3(0.14, 0.14, 0.17), uStorm);
  vec3 cCol = mix(cloudLo, cloudHi, fbm(p * 1.7 + 3.1));

  vec3 col = mix(sky, cCol, dens);

  // Lightning: point glow, amplified where it lights cloud interiors.
  float glow = flashPulse(uFlash0, uv) + flashPulse(uFlash1, uv) + flashPulse(uFlash2, uv);
  col += vec3(0.75, 0.82, 1.00) * glow * (0.35 + dens * 0.9);

  // Thin rain dashes once the room really storms.
  float rainAmt = smoothstep(0.55, 0.95, uStorm);
  float colId = floor(uv.x * 140.0);
  float ph = hash12(vec2(colId, 7.0));
  float fy = fract(uv.y * (2.0 + ph) + uT * (1.4 + ph * 0.8) * 4.0 + ph * 7.0);
  float streak = smoothstep(0.0, 0.15, fy) * smoothstep(0.35, 0.15, fy);
  col += vec3(0.35, 0.45, 0.60) * streak * rainAmt * 0.20;

  // Temperature grade from occupancy, exposure dip in storm, flash overglow.
  vec3 tint = mix(vec3(0.88, 0.94, 1.12), vec3(1.12, 1.00, 0.86), uWarmth);
  col *= tint * (mix(1.0, 0.8, uStorm) + glow * 0.4);

  outColor = vec4(col, 1.0);
}`;

export class RoomWeather {
  name = 'room-weather';
  needs = { pose: true, hands: true, seg: false };

  constructor() {
    /** @type {import('../modes.js').ModeCtx | null} */
    this.ctx = null;
    this._wind = [0, 0];
    this._angle = 0;
    this._storm = 0;
    this._warmth = 0;
    this._turb = 0;
    this._windSpeed = 0.012;
    this._targets = { wind: 0.012, storm: 0, warmth: 0, turb: 0 };
    this._light = makeLightning();
    this._f0 = [0, 0, 99, 0];
    this._f1 = [0, 0, 99, 0];
    this._f2 = [0, 0, 99, 0];
  }

  /** @param {import('../modes.js').ModeCtx} ctx */
  init(ctx) {
    this.ctx = ctx;
    this.renderProg = new Program(ctx.gl, WEATHER_FS);
  }

  /** @param {number} dt @param {number} _t */
  update(dt, _t) {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = ctx.signals;
    const tg = weatherTargets(
      {
        motionEnergy: s.motionEnergy,
        personCount: s.personCount,
        handActivity: s.handActivity,
        pressure: s.pressure,
      },
      this._targets,
    );

    // Weather changes on weather timescales: minutes of activity build the storm.
    this._storm = ema(this._storm, tg.storm ?? 0, dt, 6);
    this._warmth = ema(this._warmth, tg.warmth ?? 0, dt, 10);
    this._turb = ema(this._turb, tg.turb ?? 0, dt, 3);
    this._windSpeed = ema(this._windSpeed, tg.wind ?? 0.012, dt, 4);

    // Integrate wind so speed changes never jump the cloud field.
    this._angle = (this._angle + dt * 0.008) % (Math.PI * 2); // only ever fed to sin/cos
    this._wind[0] = (this._wind[0] + Math.cos(this._angle) * this._windSpeed * dt) % WIND_WRAP;
    this._wind[1] =
      (this._wind[1] + Math.sin(this._angle) * this._windSpeed * dt * 0.35) % WIND_WRAP;

    stepLightning(this._light, {
      storm: this._storm,
      motion: s.motionEnergy,
      dt,
      rand: Math.random,
    });
  }

  /**
   * @param {import('../gl.js').Target} target
   * @param {number} t
   */
  render(target, t) {
    const ctx = this.ctx;
    if (!ctx || !this.renderProg) return;
    const fl = this._light.flashes;
    for (let i = 0; i < 4; i++) {
      this._f0[i] = fl[i];
      this._f1[i] = fl[4 + i];
      this._f2[i] = fl[8 + i];
    }
    bindTarget(ctx.gl, target);
    this.renderProg
      .use()
      .set('uT', t)
      .set('uWind', this._wind)
      .set('uStorm', this._storm)
      .set('uWarmth', this._warmth)
      .set('uTurb', this._turb)
      .set('uFlash0', this._f0)
      .set('uFlash1', this._f1)
      .set('uFlash2', this._f2)
      .draw();
  }

  /** @param {number} _w @param {number} _h */
  resize(_w, _h) {
    // Fully procedural; nothing here depends on resolution.
  }

  dispose() {
    this.renderProg?.destroy();
    this.renderProg = undefined;
    this.ctx = null;
  }
}
