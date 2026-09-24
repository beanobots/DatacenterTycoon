/**
 * The cooling model, as a pure function.
 *
 * Power dispatch (step 6) needs the cooling load to know what to dispatch, and
 * cooling dispatch (step 7) needs the same numbers to evaluate thermal limits.
 * Rather than compute it twice or reorder the spec's pipeline, both call this.
 *
 * Spec chapter 9: EffectiveCoolingCapacity = RatedCapacity * Condition *
 * Maintenance * Environment.
 */

import type { CoolingTechnologyDefinition } from '../definitions/types.js';
import { clamp01, lerp, remap } from '../core/math.js';
import type { ModifierStack } from './modifiers.js';

export interface CoolingInput {
  readonly cooling: CoolingTechnologyDefinition;
  readonly heatLoadKw: number;
  readonly itPowerKw: number;
  readonly ratedCoolingKw: number;
  readonly condition01: number;
  /** 0-1 maintenance quality; falls as the backlog grows. */
  readonly maintenance01: number;
  readonly dryBulbC: number;
  readonly wetBulbC: number;
  readonly contamination01: number;
  /** Site elevation derates air-side heat rejection. */
  readonly elevationM: number;
  readonly baseCoolingOverhead01: number;
  readonly modifiers: ModifierStack;
  /** Set when the operator holds a heat-export connection. */
  readonly heatExportAvailable: boolean;
}

export interface CoolingOutput {
  readonly coolingPowerKw: number;
  /** Water drawn this hour at this load, m3. */
  readonly waterM3PerHour: number;
  /** Effective capacity after condition, maintenance and environment, kW. */
  readonly effectiveCapacityKw: number;
  /** 0 when cooling keeps up, 1 when it has no capacity at all. */
  readonly shortfall01: number;
  readonly recoverableHeatKw: number;
  /** 0-1 how hostile current conditions are for this technology. */
  readonly severity01: number;
}

export function evaluateCooling(input: CoolingInput): CoolingOutput {
  const { cooling, modifiers } = input;

  // The temperature this technology actually cares about: an evaporative plant
  // is limited by wet bulb, a dry cooler by dry bulb.
  const effectiveAmbientC = lerp(input.dryBulbC, input.wetBulbC, cooling.wetBulbSensitivity01);

  // Severity runs from "comfortably below the derating point" to "at the limit".
  const comfortableC = cooling.deratingStartC - 15;
  const severity01 = clamp01(
    remap(effectiveAmbientC, comfortableC, cooling.deratingEndC, 0, 1)
    + input.contamination01 * cooling.contaminationSensitivity01 * 0.35,
  );

  const energyFactor = lerp(cooling.energyFactorBest, cooling.energyFactorWorst, severity01)
    * modifiers.value('cooling.energyFactor', 1)
    / Math.max(0.5, modifiers.value('cooling.pumpEfficiency', 1));

  // Environment term of the chapter 9 capacity formula: full capacity below the
  // derating start, nothing above the derating end, plus a thin-air penalty.
  const environment01 = clamp01(
    remap(effectiveAmbientC, cooling.deratingStartC, cooling.deratingEndC, 1, 0),
  ) * (1 - clamp01(input.elevationM / 12000) * 0.25);

  const ratedKw = input.ratedCoolingKw * modifiers.value('cooling.capacity', 1);
  const effectiveCapacityKw = Math.max(0,
    ratedKw * clamp01(input.condition01) * clamp01(input.maintenance01) * environment01);

  const shortfall01 = input.heatLoadKw <= 0
    ? 0
    : clamp01((input.heatLoadKw - effectiveCapacityKw) / input.heatLoadKw);

  // Only the heat actually removed costs energy to remove.
  const removedHeatKw = input.heatLoadKw * (1 - shortfall01);
  const coolingPowerKw = removedHeatKw * input.baseCoolingOverhead01 * energyFactor;

  // WUE is defined against IT energy, so water scales with IT load, not with
  // heat: that keeps the reported number comparable to the industry metric.
  const evaporationBoost = 1 + clamp01((input.dryBulbC - 25) / 25) * 0.45;
  const waterM3PerHour = (input.itPowerKw / 1000)
    * cooling.waterFactor
    * evaporationBoost
    * modifiers.value('water.freshwaterDemand', 1);

  const recoverableHeatKw = input.heatExportAvailable
    ? removedHeatKw * clamp01(cooling.heatReuse01 * modifiers.value('cooling.heatReuse', 1))
    : 0;

  return {
    coolingPowerKw, waterM3PerHour, effectiveCapacityKw, shortfall01, recoverableHeatKw, severity01,
  };
}
