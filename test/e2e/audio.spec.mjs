// ABOUTME: E2E for audio reactivity — the HUD proves the wall hears the fake-mic thumps,
// ABOUTME: and the mic-denied / ?audio=0 paths degrade to audio-at-zero without breaking boot.
import { expect, test } from '@playwright/test';
import { brightness, hudText, passGate, watchConsole } from './helpers.mjs';

/**
 * Pull a labeled number out of the HUD line, e.g. hudNum(page, 'audio') → 0.42.
 * Returns -1 when the label is absent so failed polls read obviously wrong.
 * @param {import('@playwright/test').Page} page @param {string} label
 */
async function hudNum(page, label) {
  const m = (await hudText(page)).match(new RegExp(`${label} (\\d+(?:\\.\\d+)?)`));
  return m ? Number(m[1]) : -1;
}

test('the wall hears: level rises and beats fire on the thump track', async ({ page }) => {
  const con = watchConsole(page);
  await page.goto('/?mode=ripple-tank');
  await passGate(page);
  await page.keyboard.press('h');

  await expect.poll(() => hudText(page), { timeout: 15_000 }).toContain('mic live');
  // The fixture opens with 2s of silence, then thumps every 500ms.
  await expect.poll(() => hudNum(page, 'audio'), { timeout: 20_000 }).toBeGreaterThan(0.05);
  // The beat envelope snaps to 1 per thump and decays with tau 250ms; the HUD samples
  // every 500ms, so polling catches a fresh spike within a few thumps.
  await expect.poll(() => hudNum(page, 'beat'), { timeout: 20_000 }).toBeGreaterThan(0.2);
  expect(con.errors).toEqual([]);
});

test('mic denied: the wall boots, cycles, and audio rests at zero', async ({ page }) => {
  const con = watchConsole(page);
  // Reject only audio getUserMedia, exactly like a user clicking "Block" on the mic
  // prompt — the camera call passes through untouched (gotcha #3: the degradation
  // path gets a first-class test, not an accidental-fallback one).
  await page.addInitScript(() => {
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) =>
      c?.audio ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) : orig(c);
  });
  await page.goto('/?dwell=2&fade=1');
  await passGate(page);
  await page.keyboard.press('h');

  await expect.poll(() => hudText(page), { timeout: 10_000 }).toContain('mic off');
  await expect.poll(() => brightness(page), { timeout: 15_000 }).toBeGreaterThan(1);
  expect(await hudNum(page, 'audio')).toBe(0);
  expect(await hudNum(page, 'beat')).toBe(0);

  // Deaf, not dead: the cycle keeps turning (same probe as the auto-cycle spec).
  const seen = new Set();
  for (let i = 0; i < 15 && seen.size < 2; i++) {
    const m = (await hudText(page)).match(/:: ([a-z-]+)/);
    if (m) seen.add(m[1]);
    await page.waitForTimeout(1000);
  }
  expect(seen.size).toBeGreaterThanOrEqual(2);
  expect(con.errors).toEqual([]); // the mic failure surfaces as a warning, never an error
});

test('?audio=0 disables audio entirely: no mic request, no AudioContext', async ({ page }) => {
  // Count (not mock) the audio entry points; real calls pass straight through.
  await page.addInitScript(() => {
    window.__micRequests = 0;
    window.__audioCtxCount = 0;
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => {
      if (c?.audio) window.__micRequests += 1;
      return orig(c);
    };
    const AC = window.AudioContext;
    window.AudioContext = class extends AC {
      constructor() {
        super();
        window.__audioCtxCount += 1;
      }
    };
  });
  await page.goto('/?audio=0&mode=ripple-tank');
  await passGate(page);
  await page.keyboard.press('h');

  await expect.poll(() => hudText(page), { timeout: 10_000 }).toContain('mic off');
  await page.waitForTimeout(4000); // the thump track is now well past its lead-in silence
  expect(await hudNum(page, 'audio')).toBe(0);
  expect(await hudNum(page, 'beat')).toBe(0);
  expect(await page.evaluate(() => window.__micRequests)).toBe(0);
  expect(await page.evaluate(() => window.__audioCtxCount)).toBe(0);
});
