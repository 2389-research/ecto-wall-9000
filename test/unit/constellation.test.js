// ABOUTME: Unit tests for Skeleton Constellation's pure matching: greedy nearest pairing
// ABOUTME: of detection centroids to existing tracks with a hard distance gate.
import { describe, expect, it } from 'vitest';
import { matchDetections } from '../../js/modes/constellation.js';

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
