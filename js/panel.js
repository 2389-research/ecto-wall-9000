// ABOUTME: Floating control panel — on-screen parity with the keyboard: mode pins,
// ABOUTME: prev/next, auto-resume, HUD toggle, and fullscreen. Fades out with the idle UI.
// @ts-check

/** Short button labels; anything unlisted falls back to the mode name's first word. */
const LABELS = {
  'ghost-field': 'ghost',
  'particle-wake': 'wake',
  'ripple-tank': 'ripple',
  'echo-chamber': 'echo',
  'silhouette-garden': 'garden',
};

/**
 * @param {string} label @param {Record<string, string>} data
 * @param {string} [title]
 */
function button(label, data, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (title) b.title = title;
  for (const [k, v] of Object.entries(data)) b.dataset[k] = v;
  return b;
}

/**
 * Build the panel into `root` and keep it in sync with the cycle state at 2Hz.
 * @param {HTMLElement} root
 * @param {import('./modes.js').ModeManager} manager
 * @param {{toggleFullscreen: () => void, toggleHud: () => void}} actions
 */
export function initPanel(root, manager, actions) {
  root.append(button('◀', { action: 'prev' }, 'previous mode (pins)'));
  /** @type {HTMLButtonElement[]} */
  const modeBtns = [];
  manager.modeNames.forEach((name, i) => {
    const label = LABELS[/** @type {keyof LABELS} */ (name)] ?? name.split('-')[0];
    const b = button(`${i + 1} ${label}`, { mode: name }, name);
    modeBtns.push(b);
    root.append(b);
  });
  root.append(button('▶', { action: 'next' }, 'next mode (pins)'));
  const autoBtn = button('auto', { action: 'auto' }, 'resume auto-cycling');
  root.append(autoBtn);
  root.append(button('hud', { action: 'hud' }, 'toggle diagnostics'));
  root.append(button('⛶', { action: 'fullscreen' }, 'toggle fullscreen'));

  const sync = () => {
    const s = manager.state();
    const avail = manager.scheduler.available;
    for (const b of modeBtns) {
      const name = b.dataset.mode ?? '';
      b.classList.toggle('active', name === s.active || name === s.incoming);
      b.disabled = !avail.has(name);
    }
    autoBtn.classList.toggle('active', s.auto);
  };

  root.addEventListener('click', (ev) => {
    const btn = ev.target instanceof HTMLElement ? ev.target.closest('button') : null;
    if (!btn) return;
    const { mode, action } = btn.dataset;
    if (mode) manager.pin(mode);
    else if (action === 'prev') manager.prev();
    else if (action === 'next') manager.next();
    else if (action === 'auto') manager.resumeAuto();
    else if (action === 'hud') actions.toggleHud();
    else if (action === 'fullscreen') actions.toggleFullscreen();
    sync();
  });

  setInterval(() => {
    if (document.body.classList.contains('idle')) return; // invisible — skip the work
    sync();
  }, 500);
  sync();
}
