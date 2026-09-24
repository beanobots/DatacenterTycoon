/**
 * Core determinism primitives: the seeded streams and the simulation clock.
 *
 * Spec chapter 9 determinism rules: fixed order, seeded independent streams by
 * subsystem, persisted stream state, and never using frame time as economic
 * time.
 */

import { describe, expect, it } from 'vitest';
import { RandomStream, RandomStreams, STREAM_NAMES, hashSeed } from '../src/core/rng.js';
import { SimulationClock, cadenceFor, dayOfYear } from '../src/core/clock.js';
import { safeDivide, sampleHourlyCurve, sampleMonthlyCurve, remap, clamp01 } from '../src/core/math.js';

describe('random streams', () => {
  it('reproduces the same sequence from the same seed', () => {
    const draw = () => {
      const stream = RandomStreams.fromSeed('alpha').get('weather');
      return Array.from({ length: 20 }, () => stream.float01());
    };
    expect(draw()).toEqual(draw());
  });

  it('gives different subsystems independent sequences', () => {
    const streams = RandomStreams.fromSeed('alpha');
    const weather = Array.from({ length: 10 }, () => streams.get('weather').float01());
    const market = Array.from({ length: 10 }, () => streams.get('market').float01());
    expect(weather).not.toEqual(market);
  });

  it('is unaffected by how much another subsystem drew', () => {
    const withoutNoise = RandomStreams.fromSeed('alpha');
    const a = Array.from({ length: 5 }, () => withoutNoise.get('failure').float01());

    const withNoise = RandomStreams.fromSeed('alpha');
    for (let i = 0; i < 1000; i += 1) withNoise.get('market').float01();
    const b = Array.from({ length: 5 }, () => withNoise.get('failure').float01());

    expect(b).toEqual(a);
  });

  it('round-trips its state exactly', () => {
    const streams = RandomStreams.fromSeed('alpha');
    for (let i = 0; i < 37; i += 1) streams.get('events').float01();
    const restored = RandomStreams.fromState(streams.toState());
    expect(restored.get('events').float01()).toBe(
      RandomStreams.fromState(streams.toState()).get('events').float01(),
    );
  });

  it('serialises every named stream', () => {
    const state = RandomStreams.fromSeed('alpha').toState();
    for (const name of STREAM_NAMES) expect(state[name]).toBeDefined();
  });

  it('derives per-asset streams deterministically', () => {
    const base = new RandomStream(hashSeed('base'));
    expect(base.derive('rack-7').float01()).toBe(new RandomStream(hashSeed('base')).derive('rack-7').float01());
    expect(base.derive('rack-7').float01()).not.toBe(base.derive('rack-8').float01());
  });

  it('produces only finite values in range', () => {
    const stream = RandomStreams.fromSeed('ranges').get('weather');
    for (let i = 0; i < 5000; i += 1) {
      const value = stream.float01();
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      expect(Number.isFinite(stream.normal(0, 1))).toBe(true);
      const int = stream.int(3, 9);
      expect(int).toBeGreaterThanOrEqual(3);
      expect(int).toBeLessThanOrEqual(9);
    }
  });

  it('refuses to pick from an empty list rather than returning undefined', () => {
    expect(() => RandomStreams.fromSeed('x').get('events').pick([])).toThrow();
  });
});

describe('simulation clock', () => {
  it('rejects a tick length that does not divide an hour', () => {
    expect(() => new SimulationClock(new Date('2025-01-01T00:00:00Z'), 7)).toThrow();
    expect(() => new SimulationClock(new Date('2025-01-01T00:00:00Z'), 0)).toThrow();
  });

  it('advances in fixed steps of simulated time', () => {
    const clock = new SimulationClock(new Date('2025-01-01T00:00:00Z'), 15);
    const tick = clock.advanceOneTick();
    expect(tick?.index).toBe(1);
    expect(tick?.gameTimeUtc.toISOString()).toBe('2025-01-01T00:15:00.000Z');
    expect(tick?.hours).toBe(0.25);
  });

  it('does not advance while paused', () => {
    const clock = new SimulationClock(new Date('2025-01-01T00:00:00Z'), 15);
    clock.isPaused = true;
    expect(clock.advanceOneTick()).toBeNull();
    expect(clock.tickIndex).toBe(0);
  });

  it('closes every period boundary at once at new year', () => {
    const cadence = cadenceFor(new Date('2026-01-01T00:00:00Z'), new Date('2025-12-31T23:45:00Z'));
    expect(cadence).toMatchObject({ hour: true, day: true, month: true, quarter: true, year: true });
  });

  it('marks exactly one hour boundary per simulated hour', () => {
    const clock = new SimulationClock(new Date('2025-03-01T00:00:00Z'), 15);
    let hours = 0;
    let days = 0;
    for (let i = 0; i < 96 * 10; i += 1) {
      const tick = clock.advanceOneTick();
      if (tick?.cadence.hour) hours += 1;
      if (tick?.cadence.day) days += 1;
    }
    expect(hours).toBe(240);
    expect(days).toBe(10);
  });

  it('counts day of year from 1', () => {
    expect(dayOfYear(new Date('2025-01-01T12:00:00Z'))).toBe(1);
    expect(dayOfYear(new Date('2025-12-31T12:00:00Z'))).toBe(365);
  });
});

describe('math helpers', () => {
  it('returns the fallback instead of Infinity or NaN', () => {
    expect(safeDivide(5, 0, 0)).toBe(0);
    expect(safeDivide(5, 0, null)).toBeNull();
    expect(safeDivide(Number.NaN, 2, 0)).toBe(0);
    expect(safeDivide(10, 4, 0)).toBe(2.5);
  });

  it('wraps monthly and hourly curves', () => {
    const monthly = Array.from({ length: 12 }, (_, i) => i);
    expect(sampleMonthlyCurve(monthly, 1)).toBeCloseTo(0, 1);
    expect(() => sampleMonthlyCurve([1, 2, 3], 1)).toThrow();

    const hourly = Array.from({ length: 24 }, (_, i) => i);
    expect(sampleHourlyCurve(hourly, 0)).toBe(0);
    expect(sampleHourlyCurve(hourly, 23.5)).toBeCloseTo(11.5, 5);
    expect(() => sampleHourlyCurve([1], 0)).toThrow();
  });

  it('clamps remapped values at both ends', () => {
    expect(remap(-5, 0, 10, 0, 100)).toBe(0);
    expect(remap(50, 0, 10, 0, 100)).toBe(100);
    expect(remap(5, 0, 10, 0, 100)).toBe(50);
    expect(clamp01(1.7)).toBe(1);
  });
});
