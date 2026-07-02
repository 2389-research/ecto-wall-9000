// ABOUTME: Unit tests for Room Weather's pure logic: the signal→parameter mapping that
// ABOUTME: encodes the spec's modulation matrix, and the lightning trigger/cooldown lifecycle.
import { describe, expect, it } from 'vitest';
import { makeLightning, stepLightning, weatherTargets } from '../../js/modes/weather.js';

describe('weatherTargets', () => {
  it('maps an empty still room to calm baseline weather', () => {
    const w = weatherTargets({ motionEnergy: 0, personCount: 0, handActivity: 0, pressure: 0 });
    expect(w.wind).toBeCloseTo(0.012);
    expect(w.storm).toBe(0);
    expect(w.warmth).toBe(0);
    expect(w.turb).toBe(0);
  });

  it('storm rises with motion and pressure and clamps at 1', () => {
    const w = weatherTargets({ motionEnergy: 1, personCount: 0, handActivity: 0, pressure: 1 });
    expect(w.storm).toBe(1);
  });

  it('a lone visitor warms the palette partway, a crowd saturates it', () => {
    const one = weatherTargets({ motionEnergy: 0, personCount: 1, handActivity: 0, pressure: 0 });
    expect(one.warmth).toBeCloseTo(0.4);
    const five = weatherTargets({ motionEnergy: 0, personCount: 5, handActivity: 0, pressure: 0 });
    expect(five.warmth).toBe(1);
  });

  it('hand activity drives turbulence', () => {
    const w = weatherTargets({ motionEnergy: 0, personCount: 0, handActivity: 0.5, pressure: 0 });
    expect(w.turb).toBeCloseTo(0.6);
  });

  it('wind speed scales with motion energy', () => {
    const w = weatherTargets({ motionEnergy: 0.5, personCount: 0, handActivity: 0, pressure: 0 });
    expect(w.wind).toBeCloseTo(0.082);
  });

  it('writes into a provided out object instead of allocating', () => {
    const out = {};
    const w = weatherTargets(
      { motionEnergy: 0, personCount: 0, handActivity: 0, pressure: 0 },
      out,
    );
    expect(w).toBe(out);
  });
});

describe('lightning', () => {
  const rand = () => 0.5;

  it('makeLightning starts with all slots dark', () => {
    const st = makeLightning();
    for (let i = 0; i < 3; i++) expect(st.flashes[i * 4 + 3]).toBe(0);
    expect(st.next).toBe(0);
  });

  it('stays quiet when the room is calm', () => {
    const st = makeLightning();
    stepLightning(st, { storm: 0.2, motion: 0.9, dt: 0.016, rand });
    expect(st.flashes[3]).toBe(0);
  });

  it('strikes when stormy, moving, and off cooldown', () => {
    const st = makeLightning();
    stepLightning(st, { storm: 0.8, motion: 0.7, dt: 0.016, rand });
    expect(st.flashes[3]).toBeGreaterThan(0); // intensity written
    expect(st.flashes[2]).toBe(0); // fresh age
    expect(st.next).toBe(1);
    expect(st.cooldown).toBeGreaterThan(0);
  });

  it('respects the cooldown between strikes', () => {
    const st = makeLightning();
    stepLightning(st, { storm: 0.8, motion: 0.7, dt: 0.016, rand });
    stepLightning(st, { storm: 0.8, motion: 0.7, dt: 0.016, rand });
    expect(st.next).toBe(1); // the second call did not strike
  });

  it('ages every slot by dt', () => {
    const st = makeLightning();
    stepLightning(st, { storm: 0.8, motion: 0.7, dt: 0.016, rand }); // strike slot 0 at age 0
    stepLightning(st, { storm: 0, motion: 0, dt: 0.5, rand });
    expect(st.flashes[2]).toBeCloseTo(0.5);
  });

  it('round-robins across the three slots', () => {
    const st = makeLightning();
    for (let i = 0; i < 3; i++) {
      st.cooldown = 0;
      stepLightning(st, { storm: 0.9, motion: 0.9, dt: 0.016, rand });
    }
    expect(st.next).toBe(0);
    for (let i = 0; i < 3; i++) expect(st.flashes[i * 4 + 3]).toBeGreaterThan(0);
  });
});
