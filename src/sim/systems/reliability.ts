/**
 * Pipeline step 8: apply throttling, shutdowns and failure hazards.
 *
 * Spec chapter 9:
 *   AdjustedFailureHazard = BaseHazard * Age * Condition * ThermalStress
 *                           * LoadStress * Maintenance * EventEffects
 *
 * Hazards are evaluated hourly against an annual base rate. Condition decays
 * continuously and is restored by maintenance, so an under-maintained fleet
 * fails more the longer it is neglected rather than all at once.
 */

import type { SimulationTick } from '../../core/clock.js';
import { clamp, clamp01 } from '../../core/math.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';
import type { RandomStream } from '../../core/rng.js';

const HOURS_PER_YEAR = 8766;
/** Condition lost per year of operation at reference conditions. */
const ANNUAL_CONDITION_DECAY = 0.06;
/** Design life of a cooling plant, years. Past it, hazard climbs steeply. */
const COOLING_PLANT_LIFE_YEARS = 20;

export class ReliabilitySystem implements ISimulationSystem {
  readonly name = 'reliability';
  readonly order = 80;

  tick(tick: SimulationTick, context: SimulationContext): void {
    if (!tick.cadence.hour) return;
    const stream = context.streams.get('failure');
    const balance = context.balance;

    const maintenanceQuality = clamp01(
      1 / Math.max(0.5, context.modifiers.value('facility.maintenanceComplexity', 1)),
    );

    for (const facility of context.state.facilities) {
      const backlogPenalty = 1 + facility.maintenanceBacklog * 0.05;

      for (const hall of facility.halls) {
        if (hall.constructionProgress01 < 1) continue;
        const cooling = context.registry.cooling(hall.coolingId, hall.instanceId);
        const thermalStress = 1 + clamp(
          (hall.inletTempC - balance.referenceInletTempC) / 10, 0, 3,
        );

        // --- Cooling plant ---
        if (!hall.coolingFailed) {
          const hazard = this.hourlyHazard(
            cooling.baseAnnualFailureRate
            * this.ageFactor(
              (tick.index - hall.installedTick) * tick.minutes / (60 * HOURS_PER_YEAR),
              COOLING_PLANT_LIFE_YEARS,
            )
            * this.conditionFactor(hall.condition01)
            * thermalStress
            * backlogPenalty
            * context.modifiers.value('cooling.failureRate', 1)
            / Math.max(0.2, maintenanceQuality),
          );
          if (stream.chance(hazard)) {
            hall.coolingFailed = true;
            facility.maintenanceBacklog += 1;
            context.state.hour.incidents += 1;
            if (facility.maintenanceBacklog > 3) context.state.hour.preventableIncidents += 1;
            context.diagnostic('failure.cooling',
              `Cooling plant failure in hall ${hall.instanceId}`,
              {
                tick: tick.index,
                inletC: Number(hall.inletTempC.toFixed(2)),
                condition01: Number(hall.condition01.toFixed(3)),
                backlog: facility.maintenanceBacklog,
              });
          }
        }

        hall.condition01 = clamp01(hall.condition01 - (ANNUAL_CONDITION_DECAY / HOURS_PER_YEAR) * thermalStress);

        // --- Racks ---
        for (const group of hall.rackGroups) {
          const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
          const ageYears = (tick.index - group.installedTick) * tick.minutes / (60 * HOURS_PER_YEAR);
          // Wear follows the work running through the rack, not the paperwork
          // reserving it.
          const utilization = clamp01(context.scratch.activeUtilizationByGroup.get(group.instanceId) ?? 0);
          const workingRacks = Math.max(0, group.count - group.failedCount);
          if (workingRacks <= 0) continue;

          const hazardPerRack = this.hourlyHazard(
            hardware.baseAnnualFailureRate
            * this.ageFactor(ageYears, hardware.lifeYears)
            * this.conditionFactor(group.condition01)
            * thermalStress
            * (0.8 + 0.4 * utilization)
            * backlogPenalty
            * context.modifiers.value('hardware.failureRate', 1)
            / Math.max(0.2, maintenanceQuality),
          );

          // Racks fail independently, so the count is binomial. Drawing it
          // directly keeps the cost of a tick independent of fleet size - a
          // per-rack loop turns a 20,000-rack campaign into an hourly walk over
          // 20,000 coin flips.
          const failures = sampleBinomial(stream, workingRacks, hazardPerRack);

          if (failures > 0) {
            group.failedCount = Math.min(group.count, group.failedCount + failures);
            facility.maintenanceBacklog += failures;
            context.state.hour.incidents += failures;
            context.diagnostic('failure.hardware',
              `${failures} rack(s) failed in group ${group.instanceId}`,
              {
                tick: tick.index, hardwareId: group.hardwareId,
                ageYears: Number(ageYears.toFixed(2)),
                inletC: Number(hall.inletTempC.toFixed(2)),
                failedTotal: group.failedCount,
              });
          }
          group.condition01 = clamp01(
            group.condition01 - (ANNUAL_CONDITION_DECAY / HOURS_PER_YEAR) * thermalStress * (0.8 + 0.4 * utilization),
          );
        }
      }

      // --- Power assets ---
      for (const asset of facility.powerAssets) {
        if (!asset.available || asset.constructionProgress01 < 1) continue;
        const def = context.registry.power(asset.definitionId, asset.instanceId);
        const ageYears = (tick.index - asset.installedTick) * tick.minutes / (60 * HOURS_PER_YEAR);
        const hazard = this.hourlyHazard(
          def.baseAnnualFailureRate
          * this.ageFactor(ageYears, def.lifeYears)
          * this.conditionFactor(asset.condition01)
          * backlogPenalty
          * context.modifiers.value('power.failureRate', 1)
          / Math.max(0.2, maintenanceQuality),
        );
        if (stream.chance(hazard)) {
          asset.available = false;
          facility.maintenanceBacklog += 1;
          context.state.hour.incidents += 1;
          context.diagnostic('failure.power', `Power asset ${asset.definitionId} failed`, {
            tick: tick.index, ageYears: Number(ageYears.toFixed(2)),
            condition01: Number(asset.condition01.toFixed(3)),
          });
        }
        asset.condition01 = clamp01(asset.condition01 - ANNUAL_CONDITION_DECAY / HOURS_PER_YEAR);
      }
    }
  }

  /** Converts an annual rate to an hourly probability. */
  private hourlyHazard(annualRate: number): number {
    return clamp01(1 - Math.exp(-Math.max(0, annualRate) / HOURS_PER_YEAR));
  }

  /**
   * Bathtub curve: elevated while new, flat through service life, rising
   * sharply past the design life.
   */
  private ageFactor(ageYears: number, lifeYears: number): number {
    if (ageYears < 0.25) return 1.6;
    if (lifeYears <= 0) return 1;
    const wear = ageYears / lifeYears;
    if (wear <= 0.8) return 1;
    return 1 + (wear - 0.8) * 4;
  }

  /** Poor condition multiplies hazard; perfect condition leaves it unchanged. */
  private conditionFactor(condition01: number): number {
    return 1 + (1 - clamp01(condition01)) * 3;
  }

}

/**
 * Binomial draw, B(trials, probability).
 *
 * Below the threshold the expected count is tiny and inversion over the
 * geometric gaps is both exact and cheap: it consumes one draw per FAILURE
 * rather than one per rack. Above it, the normal approximation is accurate and
 * consumes a fixed two draws.
 */
function sampleBinomial(stream: RandomStream, trials: number, probability: number): number {
  if (probability <= 0 || trials <= 0) return 0;
  if (probability >= 1) return trials;
  const expected = trials * probability;

  if (expected > 12) {
    const drawn = Math.round(stream.normal(expected, Math.sqrt(expected * (1 - probability))));
    return Math.min(trials, Math.max(0, drawn));
  }

  // Skip ahead by geometrically distributed gaps between failures.
  const logQ = Math.log(1 - probability);
  let index = -1;
  let failures = 0;
  for (;;) {
    const gap = Math.floor(Math.log(Math.max(stream.float01(), Number.MIN_VALUE)) / logQ) + 1;
    index += gap;
    if (index >= trials) return failures;
    failures += 1;
  }
}
