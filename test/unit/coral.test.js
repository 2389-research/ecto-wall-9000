// ABOUTME: Unit tests for Coral Bloom's pure logic: the feed/kill parameter drift that must
// ABOUTME: stay inside the pattern-forming Gray-Scott regime, and the ambient seed scheduler.
import { describe, expect, it } from 'vitest';
import { coralParams, makeSeeder, stepSeeder } from '../../js/modes/coral.js';

describe('coralParams', () => {
  it('keeps feed and kill inside the coral-growing band across hours of drift', () => {
    const out = { f: 0, k: 0, steps: 0 };
    for (let t = 0; t < 4000; t += 3.7) {
      coralParams(t, 1 / 60, 0, out);
      expect(out.f).toBeGreaterThan(0.05);
      expect(out.f).toBeLessThan(0.059);
      expect(out.k).toBeGreaterThan(0.0595);
      expect(out.k).toBeLessThan(0.0645);
    }
  });

  it('runs more sim steps when the room moves', () => {
    const still = coralParams(10, 1 / 60, 0);
    const busy = coralParams(10, 1 / 60, 1);
    expect(busy.steps).toBeGreaterThan(still.steps);
  });

  it('clamps steps for huge and tiny frame gaps', () => {
    expect(coralParams(10, 2.0, 1).steps).toBe(24);
    expect(coralParams(10, 1e-4, 0).steps).toBe(1);
  });

  it('writes into a provided out object instead of allocating', () => {
    const out = { f: 0, k: 0, steps: 0 };
    expect(coralParams(0, 1 / 60, 0, out)).toBe(out);
  });
});

describe('ambient seeder', () => {
  const rand = () => 0.5;

  it('starts dormant with no live seed', () => {
    expect(makeSeeder().seed[3]).toBe(0);
  });

  it('drops a seed once the cooldown lapses in a still room', () => {
    const st = makeSeeder();
    stepSeeder(st, { motion: 0, dt: 10, rand });
    expect(st.seed[3]).toBeGreaterThan(0);
    expect(st.seed[0]).toBeGreaterThan(0.05);
    expect(st.seed[0]).toBeLessThan(0.95);
    expect(st.seed[2]).toBeGreaterThan(0.005); // radius is a visible disc, not a pixel
  });

  it('a moving room seeds itself, so the ambient seeder stays quiet', () => {
    const st = makeSeeder();
    stepSeeder(st, { motion: 0.8, dt: 10, rand });
    expect(st.seed[3]).toBe(0);
    expect(st.cooldown).toBeGreaterThan(0); // rescheduled, not left primed
  });

  it('the seed lives for exactly one step call', () => {
    const st = makeSeeder();
    stepSeeder(st, { motion: 0, dt: 10, rand });
    stepSeeder(st, { motion: 0, dt: 0.016, rand });
    expect(st.seed[3]).toBe(0);
  });

  it('respects the cooldown between seeds', () => {
    const st = makeSeeder();
    stepSeeder(st, { motion: 0, dt: 10, rand });
    stepSeeder(st, { motion: 0, dt: 0.016, rand });
    stepSeeder(st, { motion: 0, dt: 0.016, rand });
    expect(st.seed[3]).toBe(0); // still cooling down
  });
});
