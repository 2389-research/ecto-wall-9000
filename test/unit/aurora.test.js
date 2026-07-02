// ABOUTME: Unit tests for Aurora Ribbons' pure logic: greedy nearest track matching
// ABOUTME: (inherited from the constellation era) and the stroke-stamp interpolation math.
import { describe, expect, it } from 'vitest';
import { matchDetections, strokeStamps } from '../../js/modes/aurora.js';

describe('matchDetections', () => {
  it('returns -1 for every detection when there are no tracks', () => {
    expect(matchDetections([], [{ cx: 0.5, cy: 0.5 }], 0.25)).toEqual([-1]);
  });

  it('matches a detection to the only track in range', () => {
    const tracks = [{ cx: 0.5, cy: 0.5 }];
    expect(matchDetections(tracks, [{ cx: 0.55, cy: 0.5 }], 0.25)).toEqual([0]);
  });

  it('refuses matches beyond the distance gate', () => {
    const tracks = [{ cx: 0.1, cy: 0.1 }];
    expect(matchDetections(tracks, [{ cx: 0.9, cy: 0.9 }], 0.25)).toEqual([-1]);
  });

  it('prefers the globally nearest pair, not first-come order', () => {
    const tracks = [
      { cx: 0.0, cy: 0.0 },
      { cx: 0.3, cy: 0.0 },
    ];
    const dets = [
      { cx: 0.05, cy: 0.0 }, // 0.05 from t0
      { cx: 0.29, cy: 0.0 }, // 0.01 from t1 — should win first
    ];
    expect(matchDetections(tracks, dets, 0.25)).toEqual([0, 1]);
  });

  it('never assigns a track to two detections', () => {
    const tracks = [{ cx: 0.5, cy: 0.5 }];
    const dets = [
      { cx: 0.5, cy: 0.5 },
      { cx: 0.52, cy: 0.5 },
    ];
    expect(matchDetections(tracks, dets, 0.25)).toEqual([0, -1]);
  });

  it('handles more tracks than detections', () => {
    const tracks = [
      { cx: 0.2, cy: 0.2 },
      { cx: 0.8, cy: 0.8 },
    ];
    expect(matchDetections(tracks, [{ cx: 0.78, cy: 0.8 }], 0.25)).toEqual([1]);
  });
});

describe('strokeStamps', () => {
  it('a stationary joint deposits one dim stamp at its position', () => {
    const buf = new Float32Array(16);
    const n = strokeStamps(buf, 0, 0.5, 0.5, 0.5, 0.5, 1, 0.42);
    expect(n).toBe(1);
    expect(buf[0]).toBeCloseTo(0.5);
    expect(buf[1]).toBeCloseTo(0.5);
    expect(buf[2]).toBeCloseTo(0.42); // hue rides in z
    expect(buf[3]).toBeCloseTo(0.35); // floor alpha
  });

  it('interpolates stamps from just past the previous position to the current one', () => {
    const buf = new Float32Array(32 * 4);
    const n = strokeStamps(buf, 0, 0.5, 0.5, 0.5, 0.58, 1, 0.5);
    expect(n).toBe(20); // 0.08 / 0.004 spacing
    expect(buf[1]).toBeCloseTo(0.504); // first stamp is one increment past prev
    expect(buf[(n - 1) * 4 + 1]).toBeCloseTo(0.58); // last lands exactly on current
    expect(buf[3]).toBeCloseTo(1.0); // a fast sweep saturates alpha
  });

  it('caps the stamp count on huge frame jumps', () => {
    const buf = new Float32Array(64 * 4);
    expect(strokeStamps(buf, 0, 0, 0, 0.9, 0, 1, 0.5)).toBe(32);
  });

  it('scales alpha by landmark visibility', () => {
    const buf = new Float32Array(16);
    strokeStamps(buf, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5);
    expect(buf[3]).toBeCloseTo(0.175);
  });

  it('writes from the given texel base and no further than its count', () => {
    const buf = new Float32Array(16 * 4).fill(-1);
    const n = strokeStamps(buf, 2, 0.5, 0.5, 0.5, 0.5, 1, 0.5);
    expect(n).toBe(1);
    expect(buf[8]).not.toBe(-1); // texel 2 was written…
    expect(buf[0]).toBe(-1); // …texels before the base untouched
    expect(buf[12]).toBe(-1); // …and nothing past base + count
  });
});
