/**
 * Pipeline step 1: advance clock and sample weather.
 *
 * Daily means are drawn once per simulated day and held, so the diurnal curve
 * moves smoothly through the day instead of flickering every 15 minutes. That
 * matters for cooling: a hall's thermal state responds to the shape of the day,
 * not to per-tick noise.
 */

import type { SimulationTick } from '../../core/clock.js';
import { clamp, clamp01, sampleMonthlyCurve } from '../../core/math.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';

/** Hour of day at which dry-bulb temperature peaks. */
const PEAK_HOUR = 15;

/**
 * Stull's single-equation wet-bulb approximation. Accurate to a few tenths of
 * a degree over the range data centres actually operate in, and it needs only
 * dry bulb and relative humidity, which is all the climate profile carries.
 */
export function wetBulbC(dryBulbC: number, relativeHumidity01: number): number {
  const rh = clamp(relativeHumidity01 * 100, 5, 99);
  const t = dryBulbC;
  return (
    t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(t + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * rh ** 1.5 * Math.atan(0.023101 * rh) -
    4.686035
  );
}

/** Clear-sky irradiance factor, 0-1, from a simple solar-elevation model. */
export function solarElevationFactor(dayOfYear: number, hourOfDay: number, latitudeProxy: number): number {
  const declination = 23.45 * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365);
  const hourAngle = 15 * (hourOfDay - 12);
  const toRad = Math.PI / 180;
  const sinElevation =
    Math.sin(latitudeProxy * toRad) * Math.sin(declination * toRad) +
    Math.cos(latitudeProxy * toRad) * Math.cos(declination * toRad) * Math.cos(hourAngle * toRad);
  return clamp01(sinElevation);
}

export class WeatherSystem implements ISimulationSystem {
  readonly name = 'weather';
  readonly order = 10;

  initialize(context: SimulationContext): void {
    this.rollDailyMean(context, context.clock.describeTick(context.state.meta.tickIndex + 1));
    this.sample(context, context.clock.describeTick(context.state.meta.tickIndex + 1));
  }

  tick(tick: SimulationTick, context: SimulationContext): void {
    if (tick.cadence.day) this.rollDailyMean(context, tick);
    this.sample(context, tick);
  }

  private rollDailyMean(context: SimulationContext, tick: SimulationTick): void {
    const { climate } = context.region;
    const stream = context.streams.get('weather');
    const seasonal = sampleMonthlyCurve(climate.monthlyMeanTempC, tick.dayOfYear);
    context.state.world.weather.dailyMeanC = seasonal + stream.normal(0, climate.dailyVariabilityC);
  }

  private sample(context: SimulationContext, tick: SimulationTick): void {
    const { climate } = context.region;
    const weather = context.state.world.weather;
    const stream = context.streams.get('weather');

    const swing = sampleMonthlyCurve(climate.monthlySwingC, tick.dayOfYear);
    const hourFraction = tick.hourOfDay + tick.gameTimeUtc.getUTCMinutes() / 60;
    const diurnal = -Math.cos(((hourFraction - PEAK_HOUR + 12) / 24) * 2 * Math.PI);
    weather.dryBulbC = weather.dailyMeanC + (swing / 2) * diurnal;

    // Relative humidity moves against temperature within the day: the same
    // absolute moisture is a smaller fraction of saturation when it is hotter.
    const seasonalHumidity = sampleMonthlyCurve(climate.monthlyHumidity01, tick.dayOfYear);
    weather.humidity01 = clamp01(seasonalHumidity - diurnal * 0.12 * seasonalHumidity);
    weather.wetBulbC = wetBulbC(weather.dryBulbC, weather.humidity01);

    // Latitude proxy from the archetype: enough to give solar a credible
    // seasonal and daily shape without a full geographic model.
    const latitude = context.region.archetype === 'cold' ? 62
      : context.region.archetype === 'desert' ? 33
      : context.region.archetype === 'tropical' ? 12 : 45;
    const clearSky = solarElevationFactor(tick.dayOfYear, hourFraction, latitude);
    // Cloud cover tracks humidity; drier regions lose less output to cloud.
    const cloudLoss = clamp01(weather.humidity01 * 0.55 + stream.normal(0, 0.10));
    weather.solarFactor01 = clamp01(clearSky * (1 - cloudLoss * 0.6));

    // Wind as a slow random walk so storage and dispatch see persistence rather
    // than white noise; mean-reverting toward 0.5.
    const drift = stream.normal(0, 0.06);
    weather.windFactor01 = clamp01(weather.windFactor01 * 0.94 + 0.5 * 0.06 + drift);
  }
}
