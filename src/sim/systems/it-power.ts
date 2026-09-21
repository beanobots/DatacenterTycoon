/**
 * Pipeline step 5: calculate IT power and heat.
 *
 * ITPowerMWh = ServerEnergy + StorageEnergy + NetworkITEnergy (spec chapter 9).
 * Storage and network draw are carried inside the rack groups' own power
 * factors and the network overhead below, so the boundary stays where the PUE
 * definition puts it: everything inside the IT envelope, nothing outside it.
 */

import type { SimulationTick } from '../../core/clock.js';
import { assertFinite, clamp01 } from '../../core/math.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';

/**
 * Share of full power a rack draws at zero utilisation. Real servers are far
 * from power-proportional; this is what makes an underused fleet expensive.
 */
const IDLE_POWER_SHARE = 0.45;
/** Network and control gear inside the IT boundary, as a share of server draw. */
const NETWORK_IT_SHARE = 0.06;

export class ItPowerSystem implements ISimulationSystem {
  readonly name = 'it-power';
  readonly order = 50;

  tick(_tick: SimulationTick, context: SimulationContext): void {
    const balance = context.balance;
    const powerModifier = context.modifiers.value('hardware.powerDraw', 1);
    const heatModifier = context.modifiers.value('hardware.heatOutput', 1);

    let serverKw = 0;
    let heatKw = 0;

    for (const facility of context.state.facilities) {
      for (const hall of facility.halls) {
        if (hall.constructionProgress01 < 1) continue;
        for (const group of hall.rackGroups) {
          const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
          const workingRacks = Math.max(0, group.count - group.failedCount);
          if (workingRacks <= 0) continue;

          // Power follows the work actually running, not the capacity reserved:
          // an idle disaster-recovery rack still draws its idle share, and that
          // is the whole reason reserved capacity is cheap to host.
          const utilization = clamp01(context.scratch.activeUtilizationByGroup.get(group.instanceId) ?? 0);
          const loadShare = IDLE_POWER_SHARE + (1 - IDLE_POWER_SHARE) * utilization;
          const ratedKw = workingRacks * balance.baseRackPowerKw * hardware.powerFactor * powerModifier;
          const groupKw = ratedKw * loadShare;

          serverKw += groupKw;
          // heatFactor over powerFactor is the thermal difficulty of the
          // hardware: how concentrated the same kilowatt of heat is.
          heatKw += groupKw * (hardware.heatFactor / hardware.powerFactor) * heatModifier;
        }
      }
    }

    const networkKw = serverKw * NETWORK_IT_SHARE;
    context.scratch.itPowerKw = assertFinite(serverKw + networkKw, 'IT power');
    context.scratch.heatLoadKw = assertFinite(heatKw + networkKw, 'heat load');
  }
}
