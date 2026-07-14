// ABOUTME: Boot and conductor for ECTO-WALL 9000: GL init, start gate, render loop,
// ABOUTME: quality governor, keyboard control, HUD, and wiring between vision/signals/modes.
// @ts-check
import { AudioEngine } from './audio.js';
import { initClock } from './clock.js';
import { initGL } from './gl.js';
import { armContextLossReload, keepAwake } from './kiosk.js';
import { AuroraRibbons } from './modes/aurora.js';
import { CoralBloom } from './modes/coral.js';
import { EchoChamber } from './modes/echo.js';
import { SilhouetteGarden } from './modes/garden.js';
import { GhostField } from './modes/ghost.js';
import { ParticleWake } from './modes/particle.js';
import { RippleTank } from './modes/ripple.js';
import { ModeManager } from './modes.js';
import { initPanel } from './panel.js';
import { Post } from './post.js';
import { ema, QualityGovernor, Signals } from './signals.js';
import { Vision } from './vision.js';

const T_WRAP = 3600; // keep shader time floats precise on week-long runs
const MAX_DPR = 1.5;

/** @param {string} id */
function el(id) {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
}

const canvas = /** @type {HTMLCanvasElement} */ (el('wall'));
const gate = el('gate');
const gateError = el('gate-error');
const startBtn = el('start');
const hud = el('hud');

const query = new URLSearchParams(location.search);
const dwell = Number(query.get('dwell')) > 0 ? Number(query.get('dwell')) : 180;
const fade = Number(query.get('fade')) > 0 ? Number(query.get('fade')) : 12;
const cycleParam = query.get('cycle');
const auto = !(cycleParam === '0' || cycleParam === 'false');
const pinParam = query.get('mode');
const clockParam = query.get('clock');
const clockOn = !(clockParam === '0' || clockParam === 'false');
const audioParam = query.get('audio');
const audioOn = !(audioParam === '0' || audioParam === 'false');

/** @param {string} msg */
function fatal(msg) {
  gateError.textContent = msg;
  gateError.hidden = false;
  startBtn.setAttribute('hidden', '');
}

let gl;
try {
  gl = initGL(canvas);
} catch (err) {
  fatal(err instanceof Error ? err.message : String(err));
  throw err;
}

armContextLossReload(canvas);
const wake = keepAwake();

const signals = new Signals();
const governor = new QualityGovernor();
const post = new Post(gl);

// Vision starts at a placeholder size; applyStage() below sets the real one immediately.
const vision = new Vision(gl, 640, 360);

// The wall's ear. Constructed unconditionally (bare arrays, no I/O) — with ?audio=0 it is
// simply never started, so no getUserMedia and no AudioContext ever exist.
const audio = new AudioEngine();

const modes = [
  new GhostField(),
  new ParticleWake(),
  new RippleTank(),
  new EchoChamber(),
  new AuroraRibbons(),
  new CoralBloom(),
  new SilhouetteGarden(),
];
const manager = new ModeManager(gl, vision, signals, modes, { dwell, fade, auto });
vision.onMpChange = () => manager.refreshAvailability();

if (pinParam) {
  if (!manager.pin(pinParam)) console.warn(`[main] unknown mode in ?mode=: ${pinParam}`);
}

// --- stage sizing -------------------------------------------------------------------------

let stageW = 0;
let stageH = 0;

function applyStage() {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const bw = Math.max(2, Math.round(canvas.clientWidth * dpr));
  const bh = Math.max(2, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const scale = governor.scale;
  const sw = Math.max(320, Math.round(bw * scale));
  const sh = Math.max(180, Math.round(bh * scale));
  if (sw !== stageW || sh !== stageH) {
    stageW = sw;
    stageH = sh;
    vision.resize(sw, sh);
    manager.resize(sw, sh);
  }
}

window.addEventListener('resize', applyStage);
applyStage();

// --- camera gate --------------------------------------------------------------------------

let retryTimer = 0;

async function startCamera() {
  gateError.hidden = true;
  try {
    await vision.start();
    gate.classList.add('leaving');
    setTimeout(() => gate.setAttribute('hidden', ''), 1700);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    gateError.textContent = `Camera unavailable: ${msg}`;
    gateError.hidden = false;
    return false;
  }
}

// Mic failure of any kind is swallowed: audio signals rest at zero, the wall never notices.
async function startAudio() {
  if (!audioOn) return;
  try {
    await audio.start();
  } catch (err) {
    console.warn('[main] mic unavailable - audio signals rest at zero:', err);
  }
}

vision.onLost = () => {
  // The camera vanished (unplugged, OS revoked). Keep rendering; retry quietly.
  clearInterval(retryTimer);
  retryTimer = window.setInterval(async () => {
    try {
      await vision.start();
      clearInterval(retryTimer);
    } catch {
      // keep trying; the wall stays alive on ambient drift
    }
  }, 3000);
};

startBtn.addEventListener('click', async () => {
  // Camera then mic: two separate getUserMedia calls in the same gesture, so a denied
  // mic can never take the camera down with it.
  if (await startCamera()) await startAudio();
});

/**
 * Durable permission state for a capability, or 'unsupported' where the permissions API
 * won't say — which the auto-skip must treat like an undecided prompt.
 * @param {string} name
 */
async function permissionState(name) {
  try {
    const st = await navigator.permissions.query({ name: /** @type {PermissionName} */ (name) });
    return st.state;
  } catch {
    return 'unsupported';
  }
}

// Skip the gate only when every permission decision is already durable (kiosk reboot
// case). An undecided mic keeps the gate up: Begin is the only gesture that may ask, so
// hiding it would strand the mic at 'prompt' forever. A denied mic is a decision — skip
// the gate and stay deaf; asking again is not ours to do.
(async () => {
  if ((await permissionState('camera')) !== 'granted') return;
  const mic = audioOn ? await permissionState('microphone') : null; // null: audio opted out
  if (mic === 'prompt' || mic === 'unsupported') return;
  if (!(await startCamera())) return;
  if (mic === 'granted') await startAudio();
})();

// --- keyboard + panel ----------------------------------------------------------------------

function toggleHud() {
  hud.hidden = !hud.hidden;
}

function toggleFullscreen() {
  // Both promises can reject (iframe, kiosk policy, races) — swallow, or a stray
  // visitor keypress becomes an unhandled-rejection console error.
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}

document.addEventListener('keydown', (ev) => {
  if (ev.key >= '1' && ev.key <= '9') {
    const name = manager.modeNames[Number(ev.key) - 1];
    if (name) manager.pin(name);
  } else if (ev.key === 'ArrowRight') {
    manager.next();
  } else if (ev.key === 'ArrowLeft') {
    manager.prev();
  } else if (ev.key === 'a') {
    manager.resumeAuto();
  } else if (ev.key === 'h') {
    toggleHud();
  } else if (ev.key === 'f') {
    toggleFullscreen();
  }
});

initPanel(el('panel'), manager, { toggleFullscreen, toggleHud });

if (clockOn) initClock(el('clock'));
else el('clock').setAttribute('hidden', '');

// --- idle auto-hide (cursor + panel) --------------------------------------------------------

let idleTimer = 0;

function wakeUI() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => document.body.classList.add('idle'), 3000);
}

document.addEventListener('mousemove', wakeUI);
document.addEventListener('pointerdown', wakeUI);
document.addEventListener('keydown', wakeUI);
wakeUI();

// --- HUD ----------------------------------------------------------------------------------

setInterval(() => {
  if (hud.hidden) return;
  const s = manager.state();
  const fading = s.incoming ? ` → ${s.incoming} ${(s.mix * 100).toFixed(0)}%` : '';
  hud.textContent =
    `ECTO-WALL 9000 :: ${s.active}${fading} [${s.auto ? 'auto' : 'pinned'}]` +
    ` | fps ${fps.toFixed(0)} | scale ${governor.scale}` +
    ` | motion ${signals.motionEnergy.toFixed(2)} | people ${signals.personCount}` +
    ` | hands ${signals.handActivity.toFixed(2)} | mp ${vision.mpStatus}` +
    ` | audio ${signals.audioLevel.toFixed(2)} beat ${signals.beat.toFixed(2)}` +
    ` | cam ${vision.cameraAlive ? 'live' : 'off'} | mic ${audio.micAlive ? 'live' : 'off'}` +
    ` | wake ${wake.held ? 'on' : 'off'}`;
}, 500);

// --- render loop --------------------------------------------------------------------------

let t = 0;
let fps = 60;
let last = performance.now();

// Reused every frame — the render loop allocates nothing.
const sigInputs = {
  energyRaw: 0,
  poses: /** @type {{x: number, y: number, vis: number}[][]} */ ([]),
  hands: /** @type {{x: number, y: number}[][]} */ ([]),
  audioLevelRaw: 0,
  audioBandsRaw: new Float32Array(3),
  audioFluxRaw: 0,
};

/** @param {number} now */
function frame(now) {
  const dt = Math.min(0.1, Math.max(1e-4, (now - last) / 1000));
  last = now;
  t = (t + dt) % T_WRAP;

  fps = ema(fps, 1 / dt, dt, 2);
  const before = governor.scale;
  governor.update(fps, dt);
  if (governor.scale !== before) applyStage();

  vision.update(dt);
  audio.update(dt);
  sigInputs.energyRaw = vision.energyRaw;
  sigInputs.poses = vision.poses;
  sigInputs.hands = vision.hands;
  sigInputs.audioLevelRaw = audio.levelRaw;
  sigInputs.audioBandsRaw = audio.bandsRaw; // reference swap — no copy; signals.update() reads audio.bandsRaw's data directly
  sigInputs.audioFluxRaw = audio.fluxRaw;
  signals.update(sigInputs, dt);
  manager.update(dt, t);
  const sceneTex = manager.render(t);
  if (sceneTex) post.render(sceneTex, t, signals.audioLevel, signals.beat);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
