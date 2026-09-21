/**
 * Construction: advances halls and power assets toward commissioning.
 *
 * Spec chapter 3 puts construction progress on a weekly cadence. Advanced
 * construction speeds it up; a transformer shortage slows it down, which is how
 * a supply-chain event turns into a schedule problem rather than a cost line.
 */

import type { SimulationTick } from '../../core/clock.js';
import { clamp01 } from '../../core/math.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';

/** Weeks to build a hall shell at speed factor 1.0. */
const HALL_BUILD_WEEKS = 26;

export class ConstructionSystem implements ISimulationSystem {
  readonly name = 'construction';
  readonly order = 108;

  tick(tick: SimulationTick, context: SimulationContext): void {
    if (!tick.cadence.week) return;
    const speed = context.modifiers.value('facility.constructionSpeed', 1);

    for (const facility of context.state.facilities) {
      for (const hall of facility.halls) {
        if (hall.constructionProgress01 >= 1) continue;
        hall.constructionProgress01 = clamp01(hall.constructionProgress01 + speed / HALL_BUILD_WEEKS);
        if (hall.constructionProgress01 >= 1) {
          hall.installedTick = tick.index;
          context.diagnostic('construction.hall_commissioned',
            `Hall ${hall.instanceId} commissioned with ${hall.coolingId}`,
            { tick: tick.index, rackCapacity: hall.rackCapacity, ratedCoolingKw: Math.round(hall.ratedCoolingKw) });
        }
      }
      for (const asset of facility.powerAssets) {
        if (asset.constructionProgress01 >= 1) continue;
        const definition = context.registry.power(asset.definitionId, asset.instanceId);
        const weeks = Math.max(1, definition.leadTimeDays / 7);
        asset.constructionProgress01 = clamp01(asset.constructionProgress01 + speed / weeks);
        if (asset.constructionProgress01 >= 1) {
          asset.installedTick = tick.index;
          context.state.company.communityTrust = Math.max(-100, Math.min(100,
            context.state.company.communityTrust + definition.communityDelta));
          context.diagnostic('construction.power_commissioned',
            `${definition.name} commissioned at ${asset.capacityMw.toFixed(1)} MW`,
            { tick: tick.index, definitionId: definition.id, capacityMw: Number(asset.capacityMw.toFixed(2)) });
        }
      }
    }
  }
}
