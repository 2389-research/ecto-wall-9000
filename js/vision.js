// ABOUTME: The wall's sensory system: camera capture, display-space normalization (mirror +
// ABOUTME: cover crop), in-shader motion field, async motion-energy readback, and lazy MediaPipe tasks.
// @ts-check
import {
  AsyncReader,
  bindTarget,
  createPingPong,
  createTarget,
  createTex,
  destroyTarget,
  Program,
  uploadData,
  uploadVideo,
} from './gl.js';
import { camToDisp, coverMap } from './signals.js';

const MP_VERSION = '0.10.14';
const MP_ESM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/+esm`;
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODELS = {
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  hands:
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  seg: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite',
};

// Camera → display-space copy applying the cover crop and the mirror flip.
const NORMALIZE_FS = `#version 300 es
precision highp float;
uniform sampler2D uCam;
uniform vec4 uMap; // sx sy ox oy
in vec2 vUV;
out vec4 o;
void main() {
  vec2 cuv = uMap.zw + vUV * uMap.xy;
  cuv.x = 1.0 - cuv.x;
  o = texture(uCam, cuv);
}`;

const LUM_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
in vec2 vUV;
out vec4 o;
void main() {
  vec3 c = texture(uSrc, vUV).rgb;
  o = vec4(vec3(dot(c, vec3(0.299, 0.587, 0.114))), 1.0);
}`;

// Poor-man's normal flow from temporal + spatial luminance gradients.
const FLOW_FS = `#version 300 es
precision highp float;
uniform sampler2D uCur;
uniform sampler2D uPrev;
uniform vec2 uPx;
uniform float uVidDt;
in vec2 vUV;
out vec4 o;
void main() {
  float c = texture(uCur, vUV).r;
  float p = texture(uPrev, vUV).r;
  float it = c - p;
  float gx = texture(uCur, vUV + vec2(uPx.x, 0.0)).r - texture(uCur, vUV - vec2(uPx.x, 0.0)).r;
  float gy = texture(uCur, vUV + vec2(0.0, uPx.y)).r - texture(uCur, vUV - vec2(0.0, uPx.y)).r;
  vec2 g = vec2(gx, gy) * 0.5;
  float g2 = dot(g, g) + 1e-4;
  vec2 flow = -it * (g / g2) * uPx / max(uVidDt, 1e-3); // uv per second
  float sp = length(flow);
  if (sp > 0.6) flow *= 0.6 / sp;
  float mag = smoothstep(0.010, 0.10, abs(it));
  o = vec4(flow, mag, 1.0);
}`;

// Temporally smoothed, softly blurred motion field: xy = flow, z = magnitude.
const ACCUM_FS = `#version 300 es
precision highp float;
uniform sampler2D uPrevMotion;
uniform sampler2D uFlow;
uniform vec2 uPx;
uniform float uDecay;
uniform float uBlend;
in vec2 vUV;
out vec4 o;
void main() {
  vec4 prev = texture(uPrevMotion, vUV);
  vec4 f = texture(uFlow, vUV) * 0.4
    + texture(uFlow, vUV + vec2(uPx.x, 0.0)) * 0.15
    + texture(uFlow, vUV - vec2(uPx.x, 0.0)) * 0.15
    + texture(uFlow, vUV + vec2(0.0, uPx.y)) * 0.15
    + texture(uFlow, vUV - vec2(0.0, uPx.y)) * 0.15;
  vec2 dir = mix(prev.xy, f.xy, uBlend);
  float mag = max(prev.z * uDecay, f.z);
  o = vec4(dir, mag, 1.0);
}`;

// Box-average the motion field down to a tiny grid for CPU energy readback.
const ENERGY_FS = `#version 300 es
precision highp float;
uniform sampler2D uMotion;
uniform vec2 uSrcPx;
in vec2 vUV;
out vec4 o;
void main() {
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    for (int j = 0; j < 4; j++) {
      vec2 off = (vec2(float(i), float(j)) - 1.5) * uSrcPx * 2.0;
      s += texture(uMotion, vUV + off).z;
    }
  }
  o = vec4(s / 16.0);
}`;

const ENERGY_W = 16;
const ENERGY_H = 9;

/**
 * @typedef {{pose: boolean, hands: boolean, seg: boolean}} Needs
 */

export class Vision {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {number} stageW @param {number} stageH internal render size
   */
  constructor(gl, stageW, stageH) {
    this.gl = gl;
    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;

    this.normalizeProg = new Program(gl, NORMALIZE_FS);
    this.lumProg = new Program(gl, LUM_FS);
    this.flowProg = new Program(gl, FLOW_FS);
    this.accumProg = new Program(gl, ACCUM_FS);
    this.energyProg = new Program(gl, ENERGY_FS);

    /** @type {WebGLTexture | null} */
    this.camRawTex = null;
    this.camRawW = 0;
    this.camRawH = 0;
    this.camMap = coverMap(16, 9, 16, 9);
    this.cameraAlive = false;
    /** @type {(() => void) | null} */
    this.onLost = null;

    this.lastVideoTime = -1;
    this._vidDt = 1 / 30;
    this.newFrame = false;
    this.frameIdx = 0;
    this.energyRaw = 0;

    // MediaPipe state
    /** @type {Needs} */
    this.needs = { pose: false, hands: false, seg: false };
    /** @type {'off' | 'loading' | 'ready' | 'failed'} */
    this.mpStatus = 'off';
    /** @type {(() => void) | null} */
    this.onMpChange = null;
    /** @type {{pose?: any, hands?: any, seg?: any}} */
    this._tasks = {};
    /** @type {{pose?: boolean, hands?: boolean, seg?: boolean}} */
    this._creating = {};
    this._mod = /** @type {any} */ (null);
    this._fileset = /** @type {any} */ (null);
    this._lastTs = 0;
    /** @type {{x: number, y: number, vis: number}[][]} */
    this.poses = [];
    /** @type {{x: number, y: number}[][]} */
    this.hands = [];
    /** @type {WebGLTexture | null} */
    this.segTex = null;
    this.segW = 0;
    this.segH = 0;
    this.segReady = false;
    /** @type {Uint8Array | null} */
    this._segBytes = null;

    // All resolution-dependent GPU state lives in one bundle so resize can rebuild it wholesale.
    this.pipe = this._makePipe(stageW, stageH);
  }

  /** @param {number} w @param {number} h */
  _makePipe(w, h) {
    const gl = this.gl;
    const mw = Math.max(64, Math.round(w / 6));
    const mh = Math.max(36, Math.round(h / 6));
    if (this.camRawW && this.camRawH) {
      this.camMap = coverMap(this.camRawW, this.camRawH, w, h);
    }
    return {
      stageW: w,
      stageH: h,
      motionW: mw,
      motionH: mh,
      camTarget: createTarget(gl, w, h, { fmt: 'rgba8' }),
      lumPP: createPingPong(gl, mw, mh, { fmt: 'rgba16f' }),
      flowTarget: createTarget(gl, mw, mh, { fmt: 'rgba16f' }),
      motionPP: createPingPong(gl, mw, mh, { fmt: 'rgba16f' }),
      // rgba32f so readPixels(RGBA/FLOAT) hits the driver's native path — no conversion stall.
      energyTarget: createTarget(gl, ENERGY_W, ENERGY_H, { fmt: 'rgba32f' }),
      reader: new AsyncReader(gl, ENERGY_W, ENERGY_H),
    };
  }

  /** @param {number} w @param {number} h */
  resize(w, h) {
    const p = this.pipe;
    if (w === p.stageW && h === p.stageH) return;
    const gl = this.gl;
    destroyTarget(gl, p.camTarget);
    p.lumPP.destroy(gl);
    destroyTarget(gl, p.flowTarget);
    p.motionPP.destroy(gl);
    destroyTarget(gl, p.energyTarget);
    p.reader.destroy(gl);
    this.pipe = this._makePipe(w, h);
  }

  /** Start (or restart) the camera. Resolves once frames are flowing. */
  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    this.video.srcObject = stream;
    await this.video.play();
    await new Promise((resolve) => {
      if (this.video.videoWidth) resolve(undefined);
      else this.video.addEventListener('loadedmetadata', () => resolve(undefined), { once: true });
    });
    this.camRawW = this.video.videoWidth;
    this.camRawH = this.video.videoHeight;
    this.camMap = coverMap(this.camRawW, this.camRawH, this.pipe.stageW, this.pipe.stageH);
    const gl = this.gl;
    if (this.camRawTex) gl.deleteTexture(this.camRawTex);
    this.camRawTex = createTex(gl, this.camRawW, this.camRawH, { fmt: 'rgba8' });
    this.cameraAlive = true;
    this.lastVideoTime = -1;
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', () => {
      this.cameraAlive = false;
      this.onLost?.();
    });
    return this;
  }

  get camTex() {
    return this.pipe.camTarget.tex;
  }

  /** Current motion field texture: xy = flow (uv/s), z = magnitude. */
  get motionTex() {
    return this.pipe.motionPP.read.tex;
  }

  /** Cover-crop mapping as a vec4 uniform value [sx, sy, ox, oy] (for raw-cam-space textures). */
  get camMapVec4() {
    return [this.camMap.sx, this.camMap.sy, this.camMap.ox, this.camMap.oy];
  }

  /**
   * Per-frame update: video upload, motion field passes, energy readback, MediaPipe cadence.
   * @param {number} dt seconds since last frame
   */
  update(dt) {
    const gl = this.gl;
    const p = this.pipe;
    this.frameIdx++;
    this.newFrame = false;

    if (this.cameraAlive && this.camRawTex && this.video.readyState >= 2) {
      const vt = this.video.currentTime;
      if (vt !== this.lastVideoTime) {
        const vidDt = this.lastVideoTime < 0 ? 1 / 30 : Math.min(0.2, vt - this.lastVideoTime);
        this.lastVideoTime = vt;
        this.newFrame = true;
        this._vidDt = Math.max(1 / 120, vidDt);
        uploadVideo(gl, this.camRawTex, this.video);

        bindTarget(gl, p.camTarget);
        this.normalizeProg
          .use()
          .setTex('uCam', this.camRawTex, 0)
          .set('uMap', this.camMapVec4)
          .draw();

        bindTarget(gl, p.lumPP.write);
        this.lumProg.use().setTex('uSrc', p.camTarget.tex, 0).draw();

        bindTarget(gl, p.flowTarget);
        this.flowProg
          .use()
          .setTex('uCur', p.lumPP.write.tex, 0)
          .setTex('uPrev', p.lumPP.read.tex, 1)
          .set('uPx', [1 / p.motionW, 1 / p.motionH])
          .set('uVidDt', this._vidDt)
          .draw();
        p.lumPP.swap();
      }
    }

    // Motion accumulation runs every frame so trails decay smoothly between camera frames.
    bindTarget(gl, p.motionPP.write);
    this.accumProg
      .use()
      .setTex('uPrevMotion', p.motionPP.read.tex, 0)
      .setTex('uFlow', p.flowTarget.tex, 1)
      .set('uPx', [1 / p.motionW, 1 / p.motionH])
      .set('uDecay', Math.exp(-dt / 0.4))
      .set('uBlend', 1 - Math.exp(-dt / 0.15))
      .draw();
    p.motionPP.swap();

    // Energy readback at ~10Hz, never blocking.
    if (this.frameIdx % 6 === 0) {
      bindTarget(gl, p.energyTarget);
      this.energyProg
        .use()
        .setTex('uMotion', this.motionTex, 0)
        .set('uSrcPx', [1 / p.motionW, 1 / p.motionH])
        .draw();
      p.reader.request(gl, p.energyTarget);
    }
    const px = p.reader.poll(gl);
    if (px) {
      let s = 0;
      for (let i = 0; i < px.length; i += 4) s += px[i];
      this.energyRaw = Math.min(1, (s / (px.length / 4)) * 6);
    }

    this._mediapipeTick();
  }

  /**
   * Declare which MediaPipe capabilities the active modes need right now.
   * Tasks load lazily on first demand; failures degrade visibly via mpStatus.
   * @param {Needs} needs
   */
  setNeeds(needs) {
    this.needs = { ...needs };
    const any = needs.pose || needs.hands || needs.seg;
    if (any && this.mpStatus === 'off') this._loadMediaPipe();
  }

  async _loadMediaPipe() {
    this.mpStatus = 'loading';
    this.onMpChange?.();
    try {
      const mod = await import(MP_ESM);
      this._fileset = await mod.FilesetResolver.forVisionTasks(MP_WASM);
      this._mod = mod;
      this.mpStatus = 'ready';
    } catch (err) {
      console.warn('[vision] MediaPipe unavailable — pose/hand/segmentation modes disabled:', err);
      this.mpStatus = 'failed';
    }
    this.onMpChange?.();
  }

  /** @param {'pose' | 'hands' | 'seg'} kind */
  async _ensureTask(kind) {
    if (this.mpStatus !== 'ready' || this._tasks[kind] || this._creating[kind]) return;
    this._creating[kind] = true;
    try {
      const { PoseLandmarker, HandLandmarker, ImageSegmenter } = this._mod;
      if (kind === 'pose') {
        this._tasks.pose = await PoseLandmarker.createFromOptions(this._fileset, {
          baseOptions: { modelAssetPath: MODELS.pose, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numPoses: 4,
        });
      } else if (kind === 'hands') {
        this._tasks.hands = await HandLandmarker.createFromOptions(this._fileset, {
          baseOptions: { modelAssetPath: MODELS.hands, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numHands: 4,
        });
      } else {
        this._tasks.seg = await ImageSegmenter.createFromOptions(this._fileset, {
          baseOptions: { modelAssetPath: MODELS.seg, delegate: 'GPU' },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
      }
    } catch (err) {
      console.warn(`[vision] MediaPipe ${kind} task failed to start:`, err);
      this.mpStatus = 'failed';
      this.onMpChange?.();
    } finally {
      this._creating[kind] = false;
    }
  }

  _timestamp() {
    this._lastTs = Math.max(this._lastTs + 1, Math.round(performance.now()));
    return this._lastTs;
  }

  /** Staggered inference so pose/hands/seg never run in the same frame. */
  _mediapipeTick() {
    if (this.mpStatus !== 'ready' || !this.newFrame || !this.cameraAlive) return;
    const phase = this.frameIdx % 4;
    try {
      if (phase === 0 && this.needs.pose) {
        if (!this._tasks.pose) this._ensureTask('pose');
        else {
          const res = this._tasks.pose.detectForVideo(this.video, this._timestamp());
          const lms = res?.landmarks ?? [];
          this.poses = lms.map((/** @type {MPLandmark[]} */ lm) =>
            lm.map((p) => {
              const [x, y] = camToDisp(this.camMap, p.x, p.y);
              return { x, y, vis: p.visibility ?? 1 };
            }),
          );
        }
      } else if (phase === 1 && this.needs.hands) {
        if (!this._tasks.hands) this._ensureTask('hands');
        else {
          const res = this._tasks.hands.detectForVideo(this.video, this._timestamp());
          const lms = res?.landmarks ?? [];
          this.hands = lms.map((/** @type {MPLandmark[]} */ lm) =>
            lm.map((p) => {
              const [x, y] = camToDisp(this.camMap, p.x, p.y);
              return { x, y };
            }),
          );
        }
      } else if (phase === 2 && this.needs.seg) {
        if (!this._tasks.seg) this._ensureTask('seg');
        else {
          this._tasks.seg.segmentForVideo(
            this.video,
            this._timestamp(),
            (/** @type {any} */ result) => {
              this._ingestMask(result);
            },
          );
        }
      }
    } catch (err) {
      console.warn('[vision] MediaPipe inference error:', err);
    }
  }

  /** @param {any} result */
  _ingestMask(result) {
    const mask = result?.confidenceMasks?.[0];
    if (!mask) return;
    const gl = this.gl;
    const w = mask.width;
    const h = mask.height;
    const data = mask.getAsFloat32Array();
    if (!this._segBytes || this._segBytes.length !== data.length) {
      this._segBytes = new Uint8Array(data.length);
    }
    // Reverse rows so the mask matches GL's bottom-up orientation like camRawTex.
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w;
      const dst = y * w;
      for (let x = 0; x < w; x++) this._segBytes[dst + x] = data[src + x] * 255;
    }
    if (!this.segTex || this.segW !== w || this.segH !== h) {
      if (this.segTex) gl.deleteTexture(this.segTex);
      this.segTex = createTex(gl, w, h, { fmt: 'r8' });
      this.segW = w;
      this.segH = h;
    }
    uploadData(gl, this.segTex, w, h, this._segBytes, 'r8');
    this.segReady = true;
    result.close?.();
  }

  /** Can the given needs be served right now (or plausibly soon)? */
  /** @param {Needs} needs */
  canServe(needs) {
    if (!needs.pose && !needs.hands && !needs.seg) return true;
    return this.mpStatus !== 'failed';
  }
}
