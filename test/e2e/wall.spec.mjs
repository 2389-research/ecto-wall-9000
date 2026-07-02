// ABOUTME: End-to-end specs for ECTO-WALL 9000 — boot, per-mode rendering, query-param
// ABOUTME: pinning, auto-cycle with keyboard control, and a 60s lifecycle soak.
import { expect, test } from '@playwright/test';
import { brightness, hudText, passGate, watchConsole } from './helpers.mjs';

const ALL_MODES = [
  ['1', 'ghost-field', 3400],
  ['2', 'particle-wake', 3400],
  ['3', 'ripple-tank', 3400],
  ['4', 'echo-chamber', 3400],
  ['5', 'aurora-ribbons', 9000], // first MediaPipe load happens here
  ['6', 'coral-bloom', 3400],
  ['7', 'silhouette-garden', 7000], // segmentation model load + garden growth
];

test('boots: gate clears, wall renders, HUD reports a live camera', async ({ page }) => {
  const con = watchConsole(page);
  await page.goto('/?dwell=60&fade=2');
  await passGate(page);
  await page.waitForTimeout(2500);
  expect(await brightness(page)).toBeGreaterThan(1);

  await page.keyboard.press('h'); // HUD starts hidden
  await expect.poll(() => hudText(page), { timeout: 10_000 }).toContain('ECTO-WALL 9000');
  expect(await hudText(page)).toContain('cam live');
  expect(con.errors).toEqual([]);
});

test('?mode= pins a mode from boot', async ({ page }) => {
  await page.goto('/?mode=ripple-tank');
  await passGate(page);
  await page.keyboard.press('h');
  await expect.poll(() => hudText(page), { timeout: 10_000 }).toContain('ripple-tank');
  expect(await hudText(page)).toContain('[pinned]');
});

test('all seven modes render something', async ({ page }) => {
  test.setTimeout(180_000);
  const con = watchConsole(page);
  await page.goto('/?dwell=60&fade=2');
  await passGate(page);
  await page.keyboard.press('h');

  for (const [key, name, settle] of ALL_MODES) {
    await page.keyboard.press(String(key));
    await page.waitForTimeout(Number(settle));
    const hud = await hudText(page);
    if (hud.includes('mp failed') && !hud.includes(String(name))) {
      // Designed degradation: with the CDN unreachable, MediaPipe modes leave the
      // roster and the pin is refused. Log and move on.
      console.log(`skip ${name}: MediaPipe unavailable (mp failed)`);
      continue;
    }
    expect(hud, `${name} should be active`).toContain(String(name));
    const b = await brightness(page);
    console.log(`${name}: brightness ${b.toFixed(2)}`);
    expect(b, `${name} should not render black`).toBeGreaterThan(1);
  }
  expect(con.errors).toEqual([]);
});

test('auto-cycles, and arrow keys pin / a resumes', async ({ page }) => {
  await page.goto('/?dwell=2&fade=1');
  await passGate(page);
  await page.keyboard.press('h');

  const seen = new Set();
  for (let i = 0; i < 14; i++) {
    const m = (await hudText(page)).match(/:: ([a-z-]+)/);
    if (m) seen.add(m[1]);
    await page.waitForTimeout(1000);
  }
  expect(seen.size).toBeGreaterThanOrEqual(2);
  expect(await hudText(page)).toContain('[auto]');

  // Poll rather than sleep: a first MediaPipe load can stall the main thread for
  // seconds, delaying key delivery and HUD refresh. Assert convergence, not instants.
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => hudText(page), { timeout: 15_000 }).toContain('[pinned]');

  await page.keyboard.press('a');
  await expect.poll(() => hudText(page), { timeout: 15_000 }).toContain('[auto]');
});

test('control panel: pins modes, resumes auto, offers fullscreen, hides when idle', async ({
  page,
}) => {
  await page.goto('/?dwell=60&fade=2');
  await passGate(page);

  await page.mouse.move(480, 270);
  await expect(page.locator('#panel')).toBeVisible();
  await expect(page.locator('#panel [data-action="fullscreen"]')).toBeVisible();

  await page.click('#panel [data-mode="ripple-tank"]');
  await page.keyboard.press('h');
  await expect.poll(() => hudText(page), { timeout: 10_000 }).toContain('ripple-tank');
  expect(await hudText(page)).toContain('[pinned]');

  await page.mouse.move(10, 10); // fresh activity so the panel is interactive
  await page.click('#panel [data-action="auto"]');
  await expect.poll(() => hudText(page), { timeout: 10_000 }).toContain('[auto]');

  // Ambient discipline: with no input the panel fades and stops catching clicks.
  await expect
    .poll(() => page.evaluate(() => document.body.classList.contains('idle')), {
      timeout: 8_000,
    })
    .toBe(true);
  const pe = await page.evaluate(
    () => getComputedStyle(/** @type {Element} */ (document.getElementById('panel'))).pointerEvents,
  );
  expect(pe).toBe('none');
});

test('overlay clock shows locale time; ?clock=0 hides it', async ({ page }) => {
  await page.goto('/?dwell=60&fade=2');
  await passGate(page);

  const time = page.locator('#clock .clock-time');
  await expect(time).toBeVisible();
  await expect(time).toHaveText(/\d{1,2}[:.]\d{2}/); // hh:mm in any locale convention
  await expect(page.locator('#clock .clock-date')).not.toBeEmpty();

  // The clock blends into the wall's light rather than sitting flat on top of it.
  const blend = await page.evaluate(
    () => getComputedStyle(/** @type {Element} */ (document.getElementById('clock'))).mixBlendMode,
  );
  expect(blend).toBe('overlay');

  await page.goto('/?clock=0');
  await expect(page.locator('#clock')).toBeHidden();
});

test('recovers from WebGL context loss by reloading', async ({ page }) => {
  await page.goto('/?dwell=60&fade=2');
  await passGate(page);
  await page.waitForTimeout(1500);

  // Kill the GL context for real via the extension built for exactly this. The wall's
  // recovery policy is a backed-off reload (all state is ambient), so expect a fresh
  // load event, an auto-skipped gate, and pixels again.
  const reloaded = page.waitForEvent('load', { timeout: 20_000 });
  await page.evaluate(() => {
    const c = /** @type {HTMLCanvasElement} */ (document.getElementById('wall'));
    c.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  });
  await reloaded;
  await passGate(page);
  await page.waitForTimeout(2500);
  expect(await brightness(page)).toBeGreaterThan(1);
});

test('60s soak: full cycle churn with zero console errors', async ({ page }) => {
  test.setTimeout(150_000);
  const con = watchConsole(page);
  await page.goto('/?dwell=6&fade=2'); // ~8s per mode: every mode inits and disposes
  await passGate(page);
  await page.waitForTimeout(60_000);

  expect(await brightness(page)).toBeGreaterThan(0.5);
  await page.keyboard.press('h');
  await expect.poll(() => hudText(page), { timeout: 10_000 }).toContain('cam live');
  const hud = await hudText(page);
  const fps = Number(hud.match(/fps (\d+)/)?.[1] ?? 0);
  expect(fps).toBeGreaterThan(10);
  expect(con.errors).toEqual([]);
  console.log(`soak done: fps ${fps}, ${con.warnings.length} warnings (driver advisories etc.)`);
});
