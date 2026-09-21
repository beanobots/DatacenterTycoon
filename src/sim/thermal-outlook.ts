/**
 * What a hall will do on the hottest day of its year.
 *
 * Capacity advice reads the fleet as it is now. In a hot region that is a trap:
 * a hall commissioned in November has never throttled, so a contract signed
 * against it fits perfectly - and then the site hits 42 degrees in July and the
 * hall sheds a fifth of its load for a quarter, breaching every month of it.
 *
 * The region's climate is known from the start and the cooling model is a pure
 * function, so this is not a forecast in any risky sense: it runs the same
 * model the simulation runs, at the design-day conditions the region's own
 * profile implies, and reports the throttling that comes out. An operator who
 * has looked at the climate table knows this; the game should not require them
 * to have done that arithmetic by hand.
 */

import { clamp, clamp01, normalCdf, remap } from '../core/math.js';
import { evaluateCooling } from './cooling-model.js';
import { PEAK_HOUR, wetBulbC } from './systems/weather.js';
import type { SimulationContext } from './context.js';
import type { HallState } from '../state/types.js';

/**
 * Warm-day allowance on the hottest month's mean, in standard deviations of
 * daily variability.
 *
 * Zero: an ordinary afternoon in the hottest month, not a record one. A
 * 99.5th-percentile day was tried and it reported the desert hall shedding
 * 100% of its load, which is true of that day and useless as guidance - the
 * player needs to know what a normal July does to this hall, and that hotter
 * days are worse, not to be shown the worst hour of the decade as if it were
 * the forecast.
 */
const DESIGN_DAY_SIGMA = 0;

/** Cooling capacity is not eliminated by poor maintenance, only degraded. */
const MIN_MAINTENANCE_QUALITY = 0.45;

export interface ThermalOutlook {
  /** Ambient dry bulb at which this hall starts shedding load, degrees C. */
  readonly ceilingC: number;
  /** Hours a year this site is expected to sit above that, from the climate. */
  readonly hoursAbovePerYear: number;
  /** The same as a share of the year, directly comparable to an SLA. */
  readonly share01: number;
  /** Load shed on an ordinary afternoon in the hottest month, 0-1. */
  readonly shedOnHotAfternoon01: number;
  /** That afternoon's temperature. */
  readonly hotAfternoonC: number;
}

interface DesignDay {
  readonly dryBulbC: number;
  readonly wetBulbC: number;
  /** 1-12, the month the conditions come from. */
  readonly month: number;
}

/** The conditions this region's hottest afternoon presents. */
function designDay(context: SimulationContext): DesignDay {
  const { climate } = context.region;
  let month = 0;
  let hottest = -Infinity;
  for (let index = 0; index < climate.monthlyMeanTempC.length; index += 1) {
    const value = climate.monthlyMeanTempC[index] ?? -Infinity;
    if (value > hottest) { hottest = value; month = index; }
  }

  const swing = climate.monthlySwingC[month] ?? 0;
  const humidity = climate.monthlyHumidity01[month] ?? 0.5;
  // The diurnal term peaks at +1, so the afternoon sits half a swing above the
  // daily mean; humidity moves the other way within the day, as in the weather
  // system.
  const dryBulb = hottest + DESIGN_DAY_SIGMA * climate.dailyVariabilityC + swing / 2;
  const relativeHumidity = clamp01(humidity - 0.12 * humidity);

  return {
    dryBulbC: dryBulb,
    wetBulbC: wetBulbC(dryBulb, relativeHumidity),
    month: month + 1,
  };
}

/**
 * The share of its load this hall would shed on the design day, 0-1.
 *
 * Runs the real cooling model against the hall's own installed density, so a
 * hall that has been retrofitted stops being penalised the moment the plant can
 * carry the heat.
 */
function designDayThrottle(context: SimulationContext, hall: HallState): number {
  if (hall.constructionProgress01 < 1) return 0;

  const powerModifier = context.modifiers.value('hardware.powerDraw', 1);
  let itKw = 0;
  for (const group of hall.rackGroups) {
    const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
    itKw += group.count * context.balance.baseRackPowerKw * hardware.powerFactor * powerModifier;
  }
  if (itKw <= 0) return 0;

  const facility = context.state.facilities
    .find((candidate) => candidate.halls.some((h) => h.instanceId === hall.instanceId));
  const complexity = Math.max(1, context.modifiers.value('facility.maintenanceComplexity', 1));
  const maintenance01 = clamp(
    clamp01(1 - (facility?.maintenanceBacklog ?? 0) * 0.02) / complexity,
    MIN_MAINTENANCE_QUALITY, 1,
  );

  const conditions = designDay(context);
  return throttleFor(context, hall, conditions.dryBulbC, conditions.wetBulbC);
}

/** Load a hall sheds at given conditions, through the real cooling model. */
function throttleFor(
  context: SimulationContext, hall: HallState, dryBulbC: number, wetBulbC_: number,
): number {
  const powerModifier = context.modifiers.value('hardware.powerDraw', 1);
  let itKw = 0;
  for (const group of hall.rackGroups) {
    const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
    itKw += group.count * context.balance.baseRackPowerKw * hardware.powerFactor * powerModifier;
  }
  if (itKw <= 0) return 0;

  const facility = context.state.facilities
    .find((candidate) => candidate.halls.some((h) => h.instanceId === hall.instanceId));
  const complexity = Math.max(1, context.modifiers.value('facility.maintenanceComplexity', 1));
  const maintenance01 = clamp(
    clamp01(1 - (facility?.maintenanceBacklog ?? 0) * 0.02) / complexity,
    MIN_MAINTENANCE_QUALITY, 1,
  );

  const result = evaluateCooling({
    cooling: context.registry.cooling(hall.coolingId, hall.instanceId),
    heatLoadKw: itKw,
    itPowerKw: itKw,
    ratedCoolingKw: hall.ratedCoolingKw,
    condition01: hall.condition01,
    maintenance01,
    dryBulbC,
    wetBulbC: wetBulbC_,
    contamination01: context.region.climate.contamination01,
    elevationM: context.region.climate.elevationM,
    baseCoolingOverhead01: context.balance.baseCoolingOverhead01,
    modifiers: context.modifiers,
    heatExportAvailable: context.state.research.capabilities.includes('heat_export'),
  });
  if (result.shortfall01 <= 0) return 0;

  // The same mapping the cooling dispatch step uses from inlet temperature to
  // shed load, so the estimate and the outcome cannot describe different games.
  const balance = context.balance;
  const floorC = balance.referenceInletTempC + clamp(dryBulbC - 30, 0, 12) * 0.25;
  const targetC = floorC + (balance.thermalShutdownC + 4 - floorC) * result.shortfall01;

  return clamp01(remap(targetC, balance.thermalThrottleStartC, balance.thermalShutdownC, 0, 1));
}

/** Above this, a hall is shedding enough to matter to an availability figure. */
const SHED_THRESHOLD = 0.02;

/**
 * The temperature a hall starts shedding at, and how much of the year is above
 * it.
 *
 * This is the shape of the answer a player actually needs. "Your hall sheds
 * 100% at 50 degrees" is true and useless; "your hall sheds above 44 degrees,
 * and this site is above 44 for about 180 hours a year - 2% of it, against a
 * 99.9% commitment" is the same physics stated so the decision is obvious.
 *
 * The ceiling is found by bisection on the real cooling model, so a retrofit
 * moves it the moment the plant can carry the heat.
 */
export function thermalOutlook(context: SimulationContext, hall: HallState): ThermalOutlook {
  const hot = designDay(context);
  const shedAtHot = shedAt(context, hall, hot.dryBulbC);

  let low = 0;
  let high = 70;
  if (shedAt(context, hall, high) <= SHED_THRESHOLD) {
    // Nothing in this climate troubles it.
    return {
      ceilingC: Infinity, hoursAbovePerYear: 0, share01: 0,
      shedOnHotAfternoon01: shedAtHot, hotAfternoonC: hot.dryBulbC,
    };
  }
  // 24 halvings takes a 70-degree bracket below a thousandth of a degree.
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2;
    if (shedAt(context, hall, mid) > SHED_THRESHOLD) high = mid;
    else low = mid;
  }

  const share = shareOfYearAbove(context, high);
  return {
    ceilingC: high,
    hoursAbovePerYear: share * 8766,
    share01: share,
    shedOnHotAfternoon01: shedAtHot,
    hotAfternoonC: hot.dryBulbC,
  };
}

/** Load this hall sheds at a given ambient dry bulb. */
function shedAt(context: SimulationContext, hall: HallState, dryBulbC: number): number {
  const humidity = ambientHumidity(context);
  return throttleFor(context, hall, dryBulbC, wetBulbC(dryBulbC, humidity));
}

/** Hottest-month humidity at the afternoon low point, as the weather system has it. */
function ambientHumidity(context: SimulationContext): number {
  const { climate } = context.region;
  let month = 0;
  let hottest = -Infinity;
  for (let index = 0; index < climate.monthlyMeanTempC.length; index += 1) {
    const value = climate.monthlyMeanTempC[index] ?? -Infinity;
    if (value > hottest) { hottest = value; month = index; }
  }
  return clamp01((climate.monthlyHumidity01[month] ?? 0.5) * 0.88);
}

/**
 * Share of the year this site sits above a temperature.
 *
 * Daily means are drawn normal around each month's seasonal value and the
 * diurnal curve rides on top, so the probability an hour exceeds a threshold
 * is a normal tail, evaluated for every hour of a representative day in every
 * month and weighted by the length of that month.
 */
function shareOfYearAbove(context: SimulationContext, thresholdC: number): number {
  const { climate } = context.region;
  const sigma = Math.max(0.01, climate.dailyVariabilityC);
  const monthDays = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  let hoursAbove = 0;
  let hoursTotal = 0;
  for (let month = 0; month < 12; month += 1) {
    const seasonal = climate.monthlyMeanTempC[month] ?? 0;
    const swing = climate.monthlySwingC[month] ?? 0;
    const days = monthDays[month] ?? 30;
    for (let hour = 0; hour < 24; hour += 1) {
      // The same diurnal term the weather system samples.
      const diurnal = -Math.cos(((hour - PEAK_HOUR + 12) / 24) * 2 * Math.PI);
      const meanNeeded = thresholdC - (swing / 2) * diurnal;
      hoursAbove += days * (1 - normalCdf((meanNeeded - seasonal) / sigma));
      hoursTotal += days;
    }
  }
  return hoursTotal > 0 ? hoursAbove / hoursTotal : 0;
}
