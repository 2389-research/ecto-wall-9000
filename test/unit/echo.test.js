// ABOUTME: Unit tests for Echo Chamber's pure ring-buffer math: which snapshot slots
// ABOUTME: a time-tap reads, the interpolation fraction, wrap-around, and validity before fill.
import { describe, expect, it } from 'vitest';
import { computeTaps } from '../../js/modes/echo.js';

const makeOut = (n) => Array.from({ length: n }, () => ({ a: 0, b: 0, frac: 0, valid: false }));

describe('computeTaps', () => {
  it('marks taps invalid before enough history exists', () => {
    const out = makeOut(2);
    computeTaps(0.5, [1, 3], 16, out);
    expect(out[0].valid).toBe(false);
    expect(out[1].valid).toBe(false);
  });

  it('interpolates between adjacent snapshots', () => {
    const out = makeOut(1);
    computeTaps(20.25, [3], 16, out);
    // tap time 17.25 -> between snapshot 17 (slot 1) and 18 (slot 2), 25% along
    expect(out[0]).toEqual({ a: 1, b: 2, frac: 0.25, valid: true });
  });

  it('becomes valid exactly when the tap fits in recorded history', () => {
    const out = makeOut(1);
    computeTaps(2, [1], 16, out);
    expect(out[0]).toMatchObject({ a: 1, b: 2, valid: true });
    expect(out[0].frac).toBeCloseTo(0, 9);
  });

  it('wraps slot indices around the ring', () => {
    const out = makeOut(1);
    computeTaps(33.5, [1], 16, out);
    // tap time 32.5 -> snapshot 32 lives in slot 0, snapshot 33 in slot 1
    expect(out[0]).toEqual({ a: 0, b: 1, frac: 0.5, valid: true });
  });

  it('supports the longest tap as soon as its snapshot exists', () => {
    const out = makeOut(1);
    computeTaps(15.5, [15], 16, out);
    expect(out[0]).toEqual({ a: 0, b: 1, frac: 0.5, valid: true });
    const out2 = makeOut(1);
    computeTaps(14.9, [15], 16, out2);
    expect(out2[0].valid).toBe(false);
  });

  it('reuses the provided output array without reordering taps', () => {
    const out = makeOut(4);
    const ret = computeTaps(30, [1, 3, 7, 15], 16, out);
    expect(ret).toBe(out);
    expect(out.map((t) => t.valid)).toEqual([true, true, true, true]);
    // tap 7 -> time 23 -> slots 7 and 8
    expect(out[2]).toMatchObject({ a: 7, b: 8 });
  });
});
