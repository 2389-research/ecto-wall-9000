// ABOUTME: Shared e2e helpers — console gate with a CDN-offline allowance, the start-gate
// ABOUTME: pass, canvas brightness probe, and HUD reader.

/**
 * Collect console traffic. Errors fail tests, with one carve-out: resource-load failures
 * against the MediaPipe CDNs are downgraded to warnings, because offline is a designed
 * degradation (vision reports mp=failed and the wall keeps running). Local errors and
 * page errors are never excused.
 * @param {import('@playwright/test').Page} page
 */
export function watchConsole(page) {
  const errors = [];
  const warnings = [];
  const cdnOffline = /cdn\.jsdelivr\.net|storage\.googleapis\.com/;
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error') {
      if (cdnOffline.test(text)) warnings.push(`cdn: ${text}`);
      else errors.push(`console.error: ${text}`);
    } else if (m.type() === 'warning') {
      warnings.push(text);
    }
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return { errors, warnings };
}

/**
 * Get past the start gate: the fake-UI flag grants camera permission, so the gate
 * normally auto-skips; fall back to clicking the start button.
 * @param {import('@playwright/test').Page} page
 */
export async function passGate(page) {
  try {
    await page.waitForSelector('#gate[hidden]', { timeout: 5000 });
  } catch {
    await page.click('#start');
    await page.waitForSelector('#gate[hidden]', { timeout: 8000 });
  }
}

/**
 * Mean canvas brightness on a 0–255 scale, via a 64×36 downsample.
 * @param {import('@playwright/test').Page} page
 */
export function brightness(page) {
  return page.evaluate(() => {
    const c = /** @type {HTMLCanvasElement} */ (document.getElementById('wall'));
    const o = document.createElement('canvas');
    o.width = 64;
    o.height = 36;
    const g = o.getContext('2d');
    if (!g) return 0;
    g.drawImage(c, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return sum / (d.length / 4);
  });
}

/** @param {import('@playwright/test').Page} page */
export async function hudText(page) {
  return (await page.textContent('#hud')) ?? '';
}
