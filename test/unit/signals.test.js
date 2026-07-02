// ABOUTME: Unit tests for the pure-logic signal core: smoothing, geometry mapping,
// ABOUTME: activity history, mode cycle scheduling, and the adaptive quality governor.
import { describe, expect, it } from 'vitest';
import {
  CycleScheduler,
  camToDisp,
  coverMap,
  ema,
  fadeEnvelope,
  HistoryRing,
  QualityGovernor,
  Signals,
} from '../../js/signals.js';

describe('ema', () => {
  it('converges to ~63% of target after one time constant', () => {
    let v = 0;
    const tau = 0.5;
    const steps = 100;
    for (let i = 0; i < steps; i++) v = ema(v, 1, tau / steps, tau);
    expect(v).toBeCloseTo(1 - 1 / Math.E, 2);
  });

  it('is timestep-invariant', () => {
    let a = 0;
    let b = 0;
    for (let i = 0; i < 10; i++) a = ema(a, 1, 0.1, 0.5);
    for (let i = 0; i < 100; i++) b = ema(b, 1, 0.01, 0.5);
    expect(Math.abs(a - b)).toBeLessThan(0.02);
  });
});

describe('fadeEnvelope', () => {
  it('maps endpoints exactly and midpoint to 0.5', () => {
    expect(fadeEnvelope(0)).toBe(0);
    expect(fadeEnvelope(1)).toBe(1);
    expect(fadeEnvelope(0.5)).toBeCloseTo(0.5, 10);
  });

  it('is monotonic and eases at the ends', () => {
    let prev = -1;
    for (let x = 0; x <= 1.001; x += 0.05) {
      const y = fadeEnvelope(Math.min(1, x));
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
    expect(fadeEnvelope(0.01)).toBeLessThan(0.001);
    expect(fadeEnvelope(0.99)).toBeGreaterThan(0.999);
  });

  it('clamps outside [0,1]', () => {
    expect(fadeEnvelope(-2)).toBe(0);
    expect(fadeEnvelope(3)).toBe(1);
  });
});

describe('coverMap', () => {
  it('is identity for matching aspect ratios', () => {
    const m = coverMap(1280, 720, 1920, 1080);
    expect(m).toEqual({ sx: 1, sy: 1, ox: 0, oy: 0 });
  });

  it('crops vertically when camera is squarer than display', () => {
    const m = coverMap(640, 480, 1920, 1080);
    expect(m.sx).toBeCloseTo(1, 6);
    expect(m.sy).toBeCloseTo(0.75, 6);
    expect(m.ox).toBeCloseTo(0, 6);
    expect(m.oy).toBeCloseTo(0.125, 6);
  });

  it('crops horizontally when camera is wider than display', () => {
    const m = coverMap(1920, 1080, 1024, 768);
    expect(m.sy).toBeCloseTo(1, 6);
    expect(m.sx).toBeCloseTo(1024 / 768 / (1920 / 1080), 6);
    expect(m.ox).toBeCloseTo((1 - m.sx) / 2, 6);
  });
});

describe('camToDisp', () => {
  it('mirrors x by default (the wall behaves like a mirror)', () => {
    const m = coverMap(1280, 720, 1280, 720);
    expect(camToDisp(m, 0.2, 0.7)).toEqual([0.8, 0.7]);
  });

  it('can skip mirroring', () => {
    const m = coverMap(1280, 720, 1280, 720);
    expect(camToDisp(m, 0.2, 0.7, false)).toEqual([0.2, 0.7]);
  });

  it('inverts the cover crop: camera center maps to display center', () => {
    const m = coverMap(640, 480, 1920, 1080);
    const [dx, dy] = camToDisp(m, 0.5, 0.5);
    expect(dx).toBeCloseTo(0.5, 6);
    expect(dy).toBeCloseTo(0.5, 6);
    const [, topY] = camToDisp(m, 0.5, 0.125);
    expect(topY).toBeCloseTo(0, 6);
  });
});

describe('HistoryRing', () => {
  it('averages a single partial slot', () => {
    const r = new HistoryRing(4, 60);
    r.push(1, 1);
    expect(r.average()).toBeCloseTo(1, 6);
  });

  it('tracks slot-resolution history', () => {
    const r = new HistoryRing(4, 60);
    for (let i = 0; i < 60; i++) r.push(1, 1);
    expect(r.average()).toBeCloseTo(1, 6);
    for (let i = 0; i < 60; i++) r.push(0, 1);
    expect(r.average()).toBeCloseTo(0.5, 6);
  });

  it('forgets old history once the ring wraps', () => {
    const r = new HistoryRing(2, 10);
    for (let i = 0; i < 10; i++) r.push(1, 1);
    for (let i = 0; i < 20; i++) r.push(0, 1);
    expect(r.average()).toBeCloseTo(0, 6);
  });
});

describe('CycleScheduler', () => {
  const make = (opts = {}) =>
    new CycleScheduler(['a', 'b', 'c'], { dwell: 10, fade: 2, auto: true, ...opts });

  it('starts stable on the first mode', () => {
    const s = make();
    expect(s.state()).toMatchObject({ active: 'a', incoming: null, mix: 0, auto: true });
  });

  it('begins fading after the dwell elapses, carrying leftover time into the fade', () => {
    const s = make();
    s.tick(9.9);
    expect(s.state().incoming).toBeNull();
    s.tick(0.2);
    const st = s.state();
    expect(st.incoming).toBe('b');
    expect(st.mix).toBeGreaterThan(0);
    expect(st.mix).toBeLessThan(0.15);
  });

  it('completes the fade and resets dwell', () => {
    const s = make();
    s.tick(10);
    s.tick(2);
    expect(s.state()).toMatchObject({ active: 'b', incoming: null, mix: 0 });
    s.tick(9.5);
    expect(s.state().incoming).toBeNull();
    s.tick(0.6);
    expect(s.state().incoming).toBe('c');
  });

  it('wraps from the last mode to the first', () => {
    const s = make();
    s.tick(12); // -> b
    s.tick(12); // -> c
    s.tick(12); // -> a
    expect(s.state().active).toBe('a');
  });

  it('pin() fades to the target and disables auto', () => {
    const s = make();
    expect(s.pin('c')).toBe(true);
    expect(s.state()).toMatchObject({ incoming: 'c', auto: false });
    s.tick(2);
    expect(s.state().active).toBe('c');
    s.tick(100);
    expect(s.state()).toMatchObject({ active: 'c', incoming: null });
  });

  it('pin() on the active mode just disables auto', () => {
    const s = make();
    expect(s.pin('a')).toBe(true);
    expect(s.state()).toMatchObject({ active: 'a', incoming: null, auto: false });
  });

  it('retargeting mid-fade snaps the old fade first', () => {
    const s = make();
    s.tick(10.5); // fading a -> b
    expect(s.state().incoming).toBe('b');
    s.pin('c');
    expect(s.state()).toMatchObject({ active: 'b', incoming: 'c' });
  });

  it('next()/prev() move through the ring and disable auto', () => {
    const s = make();
    s.next();
    expect(s.state()).toMatchObject({ incoming: 'b', auto: false });
    s.tick(2);
    const s2 = make();
    s2.prev();
    expect(s2.state().incoming).toBe('c');
  });

  it('resumeAuto() re-enables cycling with a fresh dwell', () => {
    const s = make();
    s.pin('b');
    s.tick(2);
    s.resumeAuto();
    s.tick(10.5);
    expect(s.state().incoming).toBe('c');
  });

  it('setAvailable() filters the cycle and evacuates unavailable active modes', () => {
    const s = make();
    s.setAvailable(['a', 'c']);
    s.tick(10.5);
    expect(s.state().incoming).toBe('c'); // skipped b
    const s2 = make();
    s2.setAvailable(['b', 'c']);
    expect(s2.state().incoming).toBe('b'); // evacuating a
    expect(s2.pin('a')).toBe(false);
  });
});

describe('QualityGovernor', () => {
  const run = (g, fps, seconds, dt = 0.1) => {
    let scale = g.scale;
    for (let t = 0; t < seconds - 1e-9; t += dt) scale = g.update(fps, dt);
    return scale;
  };

  it('holds full quality at high fps', () => {
    const g = new QualityGovernor();
    expect(run(g, 60, 30)).toBe(1);
  });

  it('downshifts after sustained low fps, to a floor', () => {
    const g = new QualityGovernor();
    expect(run(g, 30, 2.9)).toBe(1);
    expect(run(g, 30, 0.3)).toBe(0.5);
    expect(run(g, 30, 3.2)).toBe(0.25);
    expect(run(g, 30, 60)).toBe(0.25);
  });

  it('recovers after sustained high fps', () => {
    const g = new QualityGovernor();
    run(g, 30, 7); // -> 0.25
    expect(g.scale).toBe(0.25);
    expect(run(g, 60, 10.1)).toBe(0.5);
    expect(run(g, 60, 10.1)).toBe(1);
  });

  it('treats the dead band as stable and resets hold timers', () => {
    const g = new QualityGovernor();
    run(g, 30, 2.9);
    run(g, 50, 1); // dead band resets the low timer
    expect(run(g, 30, 2.9)).toBe(1);
  });
});

describe('Signals', () => {
  it('smooths motion energy toward the raw value', () => {
    const s = new Signals();
    for (let i = 0; i < 60; i++) s.update({ energyRaw: 1, poses: [], hands: [] }, 1 / 60);
    expect(s.motionEnergy).toBeGreaterThan(0.8);
    expect(s.motionEnergy).toBeLessThanOrEqual(1);
  });

  it('raises person count instantly but lowers it only after 2s of absence', () => {
    const s = new Signals();
    const pose = [{ x: 0.5, y: 0.5 }];
    s.update({ energyRaw: 0, poses: [pose, pose], hands: [] }, 1 / 60);
    expect(s.personCount).toBe(2);
    for (let i = 0; i < 60; i++) s.update({ energyRaw: 0, poses: [], hands: [] }, 1 / 60);
    expect(s.personCount).toBe(2); // only 1s of absence
    for (let i = 0; i < 90; i++) s.update({ energyRaw: 0, poses: [], hands: [] }, 1 / 60);
    expect(s.personCount).toBe(0);
  });

  it('reads hand activity from landmark velocity and decays when hands go still', () => {
    const s = new Signals();
    const hand = (off) => [Array.from({ length: 21 }, (_, i) => ({ x: 0.3 + off, y: i / 21 }))];
    for (let i = 0; i < 30; i++)
      s.update({ energyRaw: 0, poses: [], hands: hand(i * 0.02) }, 1 / 30);
    const busy = s.handActivity;
    expect(busy).toBeGreaterThan(0.15);
    for (let i = 0; i < 120; i++) s.update({ energyRaw: 0, poses: [], hands: hand(0.6) }, 1 / 30);
    expect(s.handActivity).toBeLessThan(busy / 2);
  });

  it('exposes long-run pressure from the activity history', () => {
    const s = new Signals();
    for (let i = 0; i < 120; i++) s.update({ energyRaw: 0.8, poses: [], hands: [] }, 1);
    expect(s.pressure).toBeGreaterThan(0.5);
  });
});
