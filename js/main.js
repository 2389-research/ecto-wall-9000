// ABOUTME: Boot and conductor for ECTO-WALL 9000: GL init, start gate, render loop,
// ABOUTME: quality governor, keyboard control, HUD, and wiring between vision/signals/modes.
// @ts-check
import { initGL } from './gl.js';
import { SkeletonConstellation } from './modes/constellation.js';
import { EchoChamber } from './modes/echo.js';
import { GhostField } from './modes/ghost.js';
import { ParticleWake } from './modes/particle.js';
import { RippleTank } from './modes/ripple.js';
import { ModeManager } from './modes.js';
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

const signals = new Signals();
const governor = new QualityGovernor();
const post = new Post(gl);

// Vision starts at a placeholder size; applyStage() below sets the real one immediately.
const vision = new Vision(gl, 640, 360);

const modes = [
  new GhostField(),
  new ParticleWake(),
  new RippleTank(),
  new EchoChamber(),
  new SkeletonConstellation(),
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    gateError.textContent = `Camera unavailable: ${msg}`;
    gateError.hidden = false;
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

startBtn.addEventListener('click', startCamera);

// Skip the gate entirely when the camera permission is already durable (kiosk reboot case).
(async () => {
  try {
    const st = await navigator.permissions.query({
      name: /** @type {PermissionName} */ ('camera'),
    });
    if (st.state === 'granted') await startCamera();
  } catch {
    // permissions API unsupported for camera — the gate stays, which is fine
  }
})();

// --- keyboard -----------------------------------------------------------------------------

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
    hud.hidden = !hud.hidden;
  } else if (ev.key === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  }
});

// --- cursor auto-hide ---------------------------------------------------------------------

let cursorTimer = 0;

function wakeCursor() {
  document.body.classList.remove('hide-cursor');
  clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => document.body.classList.add('hide-cursor'), 3000);
}

document.addEventListener('mousemove', wakeCursor);
wakeCursor();

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
    ` | cam ${vision.cameraAlive ? 'live' : 'off'}`;
}, 500);

// --- render loop --------------------------------------------------------------------------

let t = 0;
let fps = 60;
let last = performance.now();

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
  signals.update({ energyRaw: vision.energyRaw, poses: vision.poses, hands: vision.hands }, dt);
  manager.update(dt, t);
  const sceneTex = manager.render(t);
  if (sceneTex) post.render(sceneTex, t);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
