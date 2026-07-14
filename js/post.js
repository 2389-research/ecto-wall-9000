// ABOUTME: Global post-processing pass shared by every mode: animated film grain,
// ABOUTME: gentle vignette, and a slow ~20s luminance "breathing" so the wall feels alive.
// @ts-check
import { bindTarget, Program } from './gl.js';

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform vec2 uRes;
uniform float uT;
uniform float uBreathe;
in vec2 vUV;
out vec4 outColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 c = texture(uScene, vUV).rgb;

  // vignette: bright center, softly darkened corners
  float d = distance(vUV, vec2(0.5));
  float vig = smoothstep(0.95, 0.35, d);
  c *= mix(0.72, 1.0, vig);

  // slow luminance breathing + audio swell (computed on CPU)
  c *= uBreathe;

  // animated film grain
  float g = hash12(vUV * uRes + vec2(uT * 61.7, uT * 83.3)) - 0.5;
  c += g * 0.035;

  // faint filmic crush to keep blacks deep
  c = clamp(c, 0.0, 1.0);
  c = pow(c, vec3(1.06));

  outColor = vec4(c, 1.0);
}`;

export class Post {
  /** @param {WebGL2RenderingContext} gl */
  constructor(gl) {
    this.gl = gl;
    this.prog = new Program(gl, FRAG);
  }

  /**
   * Render the scene texture to the canvas with the film pass applied.
   * @param {WebGLTexture} sceneTex
   * @param {number} t seconds (wrapped)
   * @param {number} [audioLevel] room loudness 0–1
   * @param {number} [beat] onset envelope 0–1
   */
  render(sceneTex, t, audioLevel = 0, beat = 0) {
    const gl = this.gl;
    bindTarget(gl, null);
    // The slow ~20s breath, plus the room's sound: ~2% loudness swell, ~1.5% beat pulse.
    const breathe =
      (1 + 0.02 * Math.sin((2 * Math.PI * t) / 20)) * (1 + 0.02 * audioLevel + 0.015 * beat);
    this.prog
      .use()
      .setTex('uScene', sceneTex, 0)
      .set('uRes', [gl.drawingBufferWidth, gl.drawingBufferHeight])
      .set('uT', t)
      .set('uBreathe', breathe)
      .draw();
  }

  dispose() {
    this.prog.destroy();
  }
}
