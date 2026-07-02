// ABOUTME: Minimal WebGL2 helpers for ECTO-WALL 9000: shader programs, render targets,
// ABOUTME: ping-pong buffers, video/data uploads, shared noise GLSL, and non-blocking readback.
// @ts-check

/** Attribute-less fullscreen "big triangle" vertex shader shared by all quad passes. */
export const QUAD_VS = `#version 300 es
precision highp float;
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Shared GLSL chunk: hashes, value noise, fbm, and 2D curl. Prepend inside fragment shaders. */
export const NOISE_GLSL = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(19.7, 7.3);
    a *= 0.5;
  }
  return v;
}
vec2 curl2(vec2 p) {
  float e = 0.06;
  float n1 = fbm(p + vec2(0.0, e));
  float n2 = fbm(p - vec2(0.0, e));
  float n3 = fbm(p + vec2(e, 0.0));
  float n4 = fbm(p - vec2(e, 0.0));
  return vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
}`;

/**
 * Create the WebGL2 context with the extensions the wall requires.
 * Throws with a human-readable message if the GPU can't run us.
 * @param {HTMLCanvasElement} canvas
 */
export function initGL(canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 is not available in this browser.');
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error(
      'EXT_color_buffer_float is not supported; the wall needs float render targets.',
    );
  }
  gl.getExtension('OES_texture_float_linear'); // optional nicety
  // One forever-bound VAO: every draw here is attribute-less (gl_VertexID pulls from textures).
  gl.bindVertexArray(gl.createVertexArray());
  return gl;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {'rgba8' | 'rgba16f' | 'rgba32f' | 'r8'} fmt
 */
function fmtInfo(gl, fmt) {
  switch (fmt) {
    case 'rgba8':
      return { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
    case 'rgba16f':
      return { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT };
    case 'rgba32f':
      // Not filterable without OES_texture_float_linear — pair with 'nearest'.
      return { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT };
    case 'r8':
      return { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE };
    default:
      throw new Error(`Unknown texture format: ${fmt}`);
  }
}

/**
 * @typedef {{fmt: 'rgba8' | 'rgba16f' | 'rgba32f' | 'r8', filter?: 'linear' | 'nearest', wrap?: 'clamp' | 'repeat', data?: ArrayBufferView | null}} TexOpts
 */

/**
 * @param {WebGL2RenderingContext} gl
 * @param {number} w @param {number} h
 * @param {TexOpts} opts
 */
export function createTex(gl, w, h, opts) {
  const { fmt, filter = 'linear', wrap = 'clamp', data = null } = opts;
  const info = fmtInfo(gl, fmt);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, info.internal, w, h, 0, info.format, info.type, data);
  const f = filter === 'linear' ? gl.LINEAR : gl.NEAREST;
  const wr = wrap === 'clamp' ? gl.CLAMP_TO_EDGE : gl.REPEAT;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wr);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wr);
  return tex;
}

/**
 * @typedef {{fbo: WebGLFramebuffer, tex: WebGLTexture, w: number, h: number}} Target
 */

/**
 * Texture + framebuffer pair you can render into and sample from.
 * @param {WebGL2RenderingContext} gl
 * @param {number} w @param {number} h
 * @param {TexOpts} opts
 * @returns {Target}
 */
export function createTarget(gl, w, h, opts) {
  const tex = createTex(gl, w, h, opts);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`Framebuffer incomplete (0x${status.toString(16)}) for ${opts.fmt} ${w}x${h}`);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, w, h };
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {Target} t
 */
export function destroyTarget(gl, t) {
  gl.deleteFramebuffer(t.fbo);
  gl.deleteTexture(t.tex);
}

/**
 * Ping-pong pair: render into `.write`, sample `.read`, then `swap()`.
 * @param {WebGL2RenderingContext} gl
 * @param {number} w @param {number} h
 * @param {TexOpts} opts
 */
export function createPingPong(gl, w, h, opts) {
  const a = createTarget(gl, w, h, opts);
  const b = createTarget(gl, w, h, opts);
  return {
    a,
    b,
    flipped: false,
    get read() {
      return this.flipped ? this.b : this.a;
    },
    get write() {
      return this.flipped ? this.a : this.b;
    },
    swap() {
      this.flipped = !this.flipped;
    },
    /** @param {WebGL2RenderingContext} g */
    destroy(g) {
      destroyTarget(g, this.a);
      destroyTarget(g, this.b);
    },
  };
}

/**
 * Bind a render target (or the canvas when null) and set the viewport to match.
 * @param {WebGL2RenderingContext} gl
 * @param {Target | null} target
 */
export function bindTarget(gl, target) {
  if (target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  }
}

/** Compiled + linked program with cached uniform locations and typed setters. */
export class Program {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {string} fragSrc
   * @param {string} [vertSrc]
   */
  constructor(gl, fragSrc, vertSrc = QUAD_VS) {
    this.gl = gl;
    this.prog = link(gl, vertSrc, fragSrc);
    /** @type {Map<string, WebGLUniformLocation | null>} */
    this.locs = new Map();
  }

  use() {
    this.gl.useProgram(this.prog);
    return this;
  }

  /** @param {string} name */
  loc(name) {
    let l = this.locs.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.prog, name);
      this.locs.set(name, l);
    }
    return l;
  }

  /**
   * Set a float or float-vector uniform.
   * @param {string} name @param {number | number[]} v
   */
  set(name, v) {
    const gl = this.gl;
    const l = this.loc(name);
    if (l === null) return this;
    if (typeof v === 'number') gl.uniform1f(l, v);
    else if (v.length === 2) gl.uniform2f(l, v[0], v[1]);
    else if (v.length === 3) gl.uniform3f(l, v[0], v[1], v[2]);
    else if (v.length === 4) gl.uniform4f(l, v[0], v[1], v[2], v[3]);
    else gl.uniform1fv(l, v);
    return this;
  }

  /** @param {string} name @param {number} i */
  setInt(name, i) {
    const l = this.loc(name);
    if (l !== null) this.gl.uniform1i(l, i);
    return this;
  }

  /** @param {string} name @param {WebGLTexture | null} tex @param {number} unit */
  setTex(name, tex, unit) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this.setInt(name, unit);
    return this;
  }

  /** Draw the fullscreen big triangle (for QUAD_VS-based passes). */
  draw() {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
    return this;
  }

  destroy() {
    this.gl.deleteProgram(this.prog);
  }
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {string} vertSrc @param {string} fragSrc
 */
function link(gl, vertSrc, fragSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`Program link failed: ${log}`);
  }
  return prog;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {number} kind @param {string} src
 */
function compile(gl, kind, src) {
  const sh = gl.createShader(kind);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? 'unknown error';
    const numbered = src
      .split('\n')
      .map((line, i) => `${String(i + 1).padStart(3)} ${line}`)
      .join('\n');
    gl.deleteShader(sh);
    throw new Error(`Shader compile failed:\n${log}\n${numbered}`);
  }
  return sh;
}

/**
 * Upload the current video frame. FLIP_Y so v=0 is the bottom, matching GL convention.
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} tex
 * @param {HTMLVideoElement} video
 */
export function uploadVideo(gl, tex, video) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
}

/**
 * Upload raw pixel data into an existing texture (no y-flip; callers pre-orient rows).
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} tex
 * @param {number} w @param {number} h
 * @param {ArrayBufferView} data
 * @param {'rgba8' | 'rgba16f' | 'rgba32f' | 'r8'} fmt
 */
export function uploadData(gl, tex, w, h, data, fmt) {
  const info = fmtInfo(gl, fmt);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, info.format, info.type, data);
}

/**
 * Non-blocking float readback: request() kicks a GPU→buffer copy with a fence,
 * poll() returns the pixels once the fence signals (or null while pending).
 * Never stalls the render loop.
 */
export class AsyncReader {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {number} w @param {number} h
   */
  constructor(gl, w, h) {
    this.w = w;
    this.h = h;
    this.buf = gl.createBuffer();
    this.pixels = new Float32Array(w * h * 4);
    /** @type {WebGLSync | null} */
    this.sync = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, this.pixels.byteLength, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }

  /**
   * Begin an async read of the given target. No-op if a read is already in flight.
   * @param {WebGL2RenderingContext} gl
   * @param {Target} target
   */
  request(gl, target) {
    if (this.sync) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buf);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return true;
  }

  /**
   * @param {WebGL2RenderingContext} gl
   * @returns {Float32Array | null} the pixel data once ready, else null
   */
  poll(gl) {
    if (!this.sync) return null;
    const status = gl.clientWaitSync(this.sync, 0, 0);
    if (status === gl.TIMEOUT_EXPIRED) return null;
    gl.deleteSync(this.sync);
    this.sync = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buf);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.pixels);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return this.pixels;
  }

  /** @param {WebGL2RenderingContext} gl */
  destroy(gl) {
    if (this.sync) gl.deleteSync(this.sync);
    gl.deleteBuffer(this.buf);
  }
}
