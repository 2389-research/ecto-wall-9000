// ABOUTME: Silhouette Garden mode — Gray-Scott reaction-diffusion grows coral-moss where
// ABOUTME: people's silhouette edges sow it; growth matures, and composts back to soil.
// @ts-check
import { bindTarget, createPingPong, NOISE_GLSL, Program } from '../gl.js';

const ITERS = 10; // reaction-diffusion steps per frame

// Field texel: R = chemical A, G = chemical B, B = age in seconds.
// Classic Gray-Scott coral regime: f 0.0545, k 0.062, DA 0.2097, DB 0.105.
const SIM_FS = `#version 300 es
precision highp float;
uniform sampler2D uField;
uniform sampler2D uSeg;  // camera-space confidence mask (r8), GL row order
uniform vec4 uMap;       // display→camera cover map: sx sy ox oy
uniform vec2 uPx;
uniform float uInit;     // 1 = reset field to bare soil
uniform float uFirst;    // 1 on the first iteration of a frame
uniform float uDt;       // wall dt, applied once per frame on the first iteration
uniform vec3 uSpore;     // xy pos, z strength — CPU-timed ambient spore
in vec2 vUV;
out vec4 o;

float segAt(vec2 uv) {
  vec2 cuv = uMap.zw + uv * uMap.xy;
  cuv.x = 1.0 - cuv.x; // mirror to match the displayed room
  return texture(uSeg, cuv).r;
}

void main() {
  if (uInit > 0.5) {
    o = vec4(1.0, 0.0, 0.0, 1.0);
    return;
  }
  vec4 c = texture(uField, vUV);
  vec4 l = texture(uField, vUV + vec2(uPx.x, 0.0)) + texture(uField, vUV - vec2(uPx.x, 0.0))
         + texture(uField, vUV + vec2(0.0, uPx.y)) + texture(uField, vUV - vec2(0.0, uPx.y))
         - 4.0 * c;
  float A = c.r;
  float B = c.g;
  float rate = A * B * B;
  float nA = A + (0.2097 * l.r - rate + 0.0545 * (1.0 - A));
  float nB = B + (0.1050 * l.g + rate - (0.062 + 0.0545) * B);
  float age = c.b;

  if (uFirst > 0.5) {
    // People sow the garden along their silhouette outline.
    float m = segAt(vUV);
    float gx = segAt(vUV + vec2(uPx.x * 2.0, 0.0)) - segAt(vUV - vec2(uPx.x * 2.0, 0.0));
    float gy = segAt(vUV + vec2(0.0, uPx.y * 2.0)) - segAt(vUV - vec2(0.0, uPx.y * 2.0));
    float edge = smoothstep(0.15, 0.60, abs(gx) + abs(gy)) * smoothstep(0.20, 0.55, m);
    nB = max(nB, edge * 0.5);

    // A rare drifting spore keeps an empty room's garden alive.
    nB = max(nB, smoothstep(uSpore.z, 0.0, distance(vUV, uSpore.xy)) * 0.55);

    // The garden slowly composts; live silhouettes outpace the decay easily.
    nB *= exp(-uDt / 150.0);
    age = nB > 0.08 ? min(age + uDt, 240.0) : age * exp(-uDt / 45.0);
  }

  o = vec4(clamp(nA, 0.0, 1.0), clamp(nB, 0.0, 1.0), age, 1.0);
}`;

const RENDER_FS = `#version 300 es
precision highp float;
uniform sampler2D uField;
uniform sampler2D uSeg;
uniform vec4 uMap;
uniform vec2 uPx;
in vec2 vUV;
out vec4 outColor;
${NOISE_GLSL}

float segAt(vec2 uv) {
  vec2 cuv = uMap.zw + uv * uMap.xy;
  cuv.x = 1.0 - cuv.x;
  return texture(uSeg, cuv).r;
}

void main() {
  vec4 c = texture(uField, vUV);
  float B = c.g;
  float age = c.b;
  float g = smoothstep(0.06, 0.45, B);

  // Fake relief lit from the upper left, from the growth gradient.
  float bx = texture(uField, vUV + vec2(uPx.x, 0.0)).g - texture(uField, vUV - vec2(uPx.x, 0.0)).g;
  float by = texture(uField, vUV + vec2(0.0, uPx.y)).g - texture(uField, vUV - vec2(0.0, uPx.y)).g;
  vec3 n = normalize(vec3(-bx * 6.0, -by * 6.0, 1.0));
  float lit = max(dot(n, normalize(vec3(0.35, 0.55, 0.75))), 0.0);

  // Young shoots glow; old growth settles into dark moss; fresh fringes bloom.
  float mat = smoothstep(2.0, 60.0, age);
  vec3 plant = mix(vec3(0.30, 0.75, 0.38), vec3(0.10, 0.30, 0.16), mat);
  plant += vec3(0.75, 0.90, 0.45) * smoothstep(0.30, 0.55, B) * (1.0 - mat) * 0.6;

  vec3 soil = vec3(0.012, 0.020, 0.016) + vec3(0.010, 0.016, 0.012) * fbm(vUV * 6.0);
  vec3 col = mix(soil, plant * (0.45 + 0.75 * lit), g);

  // Whoever stands in the garden right now casts the faintest warm presence-light.
  float m = segAt(vUV);
  col += vec3(0.10, 0.09, 0.05) * smoothstep(0.3, 0.9, m) * (0.5 + 0.5 * g);

  outColor = vec4(col, 1.0);
}`;

export class SilhouetteGarden {
  name = 'silhouette-garden';
  needs = { pose: false, hands: false, seg: true };

  constructor() {
    /** @type {import('../modes.js').ModeCtx | null} */
    this.ctx = null;
    this._px = [0, 0];
    this._map = [1, 1, 0, 0];
    this._spore = [0, 0, 0];
    this._sporeT = 0.2; // sow quickly after init so the mode never opens on bare soil
    this._needsInit = true;
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
    const fw = Math.max(160, Math.round(w / 2));
    const fh = Math.max(90, Math.round(h / 2));
    this.field = createPingPong(gl, fw, fh, { fmt: 'rgba16f' });
    this._px[0] = 1 / fw;
    this._px[1] = 1 / fh;
    this._needsInit = true;
    this._sporeT = 0.2;
  }

  /** @param {number} dt @param {number} _t */
  update(dt, _t) {
    const ctx = this.ctx;
    if (!ctx || !this.field || !this.simProg) return;
    const gl = ctx.gl;
    const vision = ctx.vision;
    const map = vision.camMap;
    this._map[0] = map.sx;
    this._map[1] = map.sy;
    this._map[2] = map.ox;
    this._map[3] = map.oy;

    this._sporeT -= dt;
    if (this._sporeT <= 0) {
      this._spore[0] = 0.1 + Math.random() * 0.8;
      this._spore[1] = 0.1 + Math.random() * 0.8;
      this._spore[2] = this._px[0] * 4; // sow radius, a few field texels
      this._sporeT = 3 + Math.random() * 4;
    } else {
      this._spore[2] = 0;
    }

    const prog = this.simProg
      .use()
      .setTex('uSeg', vision.segTex, 1)
      .set('uMap', this._map)
      .set('uPx', this._px)
      .set('uDt', dt)
      .set('uSpore', this._spore);
    for (let i = 0; i < ITERS; i++) {
      bindTarget(gl, this.field.write);
      prog
        .setTex('uField', this.field.read.tex, 0)
        .set('uInit', this._needsInit ? 1 : 0)
        .set('uFirst', i === 0 ? 1 : 0)
        .draw();
      this.field.swap();
      this._needsInit = false;
    }
  }

  /**
   * @param {import('../gl.js').Target} target
   * @param {number} _t
   */
  render(target, _t) {
    const ctx = this.ctx;
    if (!ctx || !this.field || !this.renderProg) return;
    bindTarget(ctx.gl, target);
    this.renderProg
      .use()
      .setTex('uField', this.field.read.tex, 0)
      .setTex('uSeg', ctx.vision.segTex, 1)
      .set('uMap', this._map)
      .set('uPx', this._px)
      .draw();
  }

  /** @param {number} w @param {number} h */
  resize(w, h) {
    if (!this.ctx || !this.field) return;
    // The pattern is texel-scale physics; a resize replants the garden from spores.
    this.field.destroy(this.ctx.gl);
    this._alloc(w, h);
  }

  dispose() {
    if (!this.ctx) return;
    this.field?.destroy(this.ctx.gl);
    this.simProg?.destroy();
    this.renderProg?.destroy();
    this.field = undefined;
    this.simProg = undefined;
    this.renderProg = undefined;
    this.ctx = null;
  }
}
