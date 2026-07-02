// ABOUTME: Overlay clock in the macOS-screensaver spirit — a large locale-formatted time
// ABOUTME: with a spelled-out date line above it, updated once a second off the render loop.
// @ts-check

/**
 * Hours and minutes in the locale's own convention (12h with day period, or 24h).
 * @param {Date} date
 * @param {string} [locale] omit to follow the browser locale
 */
export function formatTime(date, locale) {
  return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Weekday, month, and day spelled out, ordered by the locale.
 * @param {Date} date
 * @param {string} [locale] omit to follow the browser locale
 */
export function formatDate(date, locale) {
  return date.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' });
}

/**
 * Build the two clock lines into `root` and keep them current at 1Hz.
 * @param {HTMLElement} root
 */
export function initClock(root) {
  const dateEl = document.createElement('div');
  dateEl.className = 'clock-date';
  const timeEl = document.createElement('div');
  timeEl.className = 'clock-time';
  root.append(dateEl, timeEl);
  const tick = () => {
    const now = new Date();
    const t = formatTime(now);
    const d = formatDate(now);
    if (timeEl.textContent !== t) timeEl.textContent = t;
    if (dateEl.textContent !== d) dateEl.textContent = d;
  };
  setInterval(tick, 1000);
  tick();
}
