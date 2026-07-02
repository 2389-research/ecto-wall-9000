// ABOUTME: Kiosk hardening — reload policy for WebGL context loss (with backoff so a sick
// ABOUTME: GPU is not thrashed) and a screen wake lock so the display never sleeps.
// @ts-check

const FORGET_MS = 300_000; // losses older than this no longer count toward backoff
const BASE_MS = 1500;
const CAP_MS = 60_000;
const STORE_KEY = 'ecto-gl-losses';

/**
 * Decide how long to wait before reloading after a GL context loss. Repeat losses within
 * five minutes back off exponentially: 1.5s, 6s, 24s, then a 60s ceiling.
 * @param {number[]} history timestamps (ms) of prior losses
 * @param {number} now current time (ms)
 * @returns {{delayMs: number, history: number[]}} delay plus the updated history to persist
 */
export function reloadDelay(history, now) {
  const recent = history.filter((t) => now - t < FORGET_MS);
  const delayMs = Math.min(CAP_MS, BASE_MS * 4 ** recent.length);
  return { delayMs, history: [...recent, now] };
}

/**
 * Reload the page when the WebGL context dies. Everything here is ambient state, so a
 * reload is a full clean recovery — and the camera gate auto-skips once permission is
 * durable, so the wall comes back without a hand touching it.
 * @param {HTMLCanvasElement} canvas
 */
export function armContextLossReload(canvas) {
  canvas.addEventListener('webglcontextlost', () => {
    let past = [];
    try {
      const parsed = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? '[]');
      if (Array.isArray(parsed)) past = parsed;
    } catch {
      // corrupt storage — treat as a first loss
    }
    const { delayMs, history } = reloadDelay(past, Date.now());
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(history));
    } catch {
      // storage unavailable — the backoff resets on each load, which is survivable
    }
    console.warn(`[kiosk] WebGL context lost — reloading in ${(delayMs / 1000).toFixed(1)}s`);
    setTimeout(() => location.reload(), delayMs);
  });
}

/**
 * Hold a screen wake lock so the display never sleeps mid-exhibition. The browser drops
 * the lock whenever the page is hidden, so it is re-acquired on every return to
 * visibility. The returned object reports live state for the HUD.
 * @returns {{held: boolean}}
 */
export function keepAwake() {
  const state = { held: false };
  if (!('wakeLock' in navigator)) return state;
  const acquire = async () => {
    try {
      const lock = await navigator.wakeLock.request('screen');
      state.held = true;
      lock.addEventListener('release', () => {
        state.held = false;
      });
    } catch {
      // denied (power saver, headless, policy) — the kiosk OS display settings still apply
      state.held = false;
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') acquire();
  });
  acquire();
  return state;
}
