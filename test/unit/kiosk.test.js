// ABOUTME: Unit tests for the kiosk context-loss reload policy — exponential backoff on
// ABOUTME: rapid repeat losses, a one-minute ceiling, and forgetting losses after five minutes.
import { describe, expect, it } from 'vitest';
import { reloadDelay } from '../../js/kiosk.js';

const NOW = 1_000_000_000;

describe('reloadDelay', () => {
  it('reloads fast on a first loss', () => {
    const r = reloadDelay([], NOW);
    expect(r.delayMs).toBe(1500);
    expect(r.history).toEqual([NOW]);
  });

  it('backs off exponentially on rapid repeat losses', () => {
    expect(reloadDelay([NOW - 10_000], NOW).delayMs).toBe(6000);
    expect(reloadDelay([NOW - 20_000, NOW - 10_000], NOW).delayMs).toBe(24_000);
  });

  it('caps the backoff at one minute', () => {
    const hist = [NOW - 40_000, NOW - 30_000, NOW - 20_000, NOW - 10_000];
    expect(reloadDelay(hist, NOW).delayMs).toBe(60_000);
  });

  it('forgets losses older than five minutes', () => {
    const r = reloadDelay([NOW - 301_000], NOW);
    expect(r.delayMs).toBe(1500);
    expect(r.history).toEqual([NOW]);
  });

  it('counts only the recent losses in a mixed history', () => {
    const r = reloadDelay([NOW - 400_000, NOW - 5000], NOW);
    expect(r.delayMs).toBe(6000);
    expect(r.history).toEqual([NOW - 5000, NOW]);
  });
});
