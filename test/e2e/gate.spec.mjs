// ABOUTME: E2E for the start gate's permission decisions — the auto-skip may only fire when
// ABOUTME: every permission is settled; an undecided mic keeps the gate up for a Begin click.
import { expect, test } from '@playwright/test';
import { hudText, watchConsole } from './helpers.mjs';

/**
 * Report a fixed permission state per capability, and count getUserMedia calls by kind.
 * The e2e context pre-grants both devices, so real getUserMedia still succeeds — the stub
 * only shapes what the auto-skip decision sees, exactly like an install where the camera
 * is durable but the mic was never asked.
 * @param {import('@playwright/test').Page} page
 * @param {{camera: string, microphone: string}} states
 */
function stubPermissions(page, states) {
  return page.addInitScript((st) => {
    navigator.permissions.query = (d) =>
      Promise.resolve(
        /** @type {PermissionStatus} */ (
          /** @type {unknown} */ ({ state: st[d.name] ?? 'prompt' })
        ),
      );
    window.__camRequests = 0;
    window.__micRequests = 0;
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => {
      if (c?.video) window.__camRequests += 1;
      if (c?.audio) window.__micRequests += 1;
      return orig(c);
    };
  }, states);
}

test('camera durable, mic undecided: the gate stays, and Begin acquires both', async ({ page }) => {
  const con = watchConsole(page);
  await stubPermissions(page, { camera: 'granted', microphone: 'prompt' });
  await page.goto('/?dwell=60&fade=2');

  // The auto-skip decision is a few permission queries — give it generous real time,
  // then require the gate intact with nothing started: the gate is the consent surface,
  // so an undecided mic means no devices run behind it.
  await page.waitForTimeout(2000);
  await expect(page.locator('#gate')).toBeVisible();
  await expect(page.locator('#start')).toBeVisible();
  expect(await page.evaluate(() => window.__camRequests)).toBe(0);
  expect(await page.evaluate(() => window.__micRequests)).toBe(0);

  // One Begin click asks for both in the same gesture and the wall comes up hearing.
  await page.click('#start');
  await expect(page.locator('#gate')).toBeHidden({ timeout: 8000 });
  expect(await page.evaluate(() => window.__camRequests)).toBe(1);
  expect(await page.evaluate(() => window.__micRequests)).toBe(1);
  await page.keyboard.press('h');
  await expect.poll(() => hudText(page), { timeout: 15_000 }).toContain('mic live');
  expect(con.errors).toEqual([]);
});

test('mic denied: still a decision — the gate auto-skips and never asks again', async ({
  page,
}) => {
  const con = watchConsole(page);
  await stubPermissions(page, { camera: 'granted', microphone: 'denied' });
  await page.goto('/?dwell=60&fade=2');

  await expect(page.locator('#gate')).toBeHidden({ timeout: 8000 });
  expect(await page.evaluate(() => window.__camRequests)).toBe(1);
  expect(await page.evaluate(() => window.__micRequests)).toBe(0);
  await page.keyboard.press('h');
  await expect.poll(() => hudText(page), { timeout: 10_000 }).toContain('mic off');
  expect(con.errors).toEqual([]);
});

test('?audio=0: an undecided mic cannot hold the gate when audio is opted out', async ({
  page,
}) => {
  const con = watchConsole(page);
  await stubPermissions(page, { camera: 'granted', microphone: 'prompt' });
  await page.goto('/?audio=0&dwell=60&fade=2');

  await expect(page.locator('#gate')).toBeHidden({ timeout: 8000 });
  expect(await page.evaluate(() => window.__camRequests)).toBe(1);
  expect(await page.evaluate(() => window.__micRequests)).toBe(0);
  await page.keyboard.press('h');
  await expect.poll(() => hudText(page), { timeout: 10_000 }).toContain('mic off');
  expect(con.errors).toEqual([]);
});
