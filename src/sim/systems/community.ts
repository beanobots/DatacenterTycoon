/**
 * Community: daily movement of local trust.
 *
 * Spec chapter 6: jobs, tax, water competition, traffic, air quality, grid
 * congestion, heat benefit and transparency all move trust. Trust gates
 * permits and expansion (chapter 7's community gate), so it is a constraint on
 * the build plan, not a cosmetic score.
 */

import type { SimulationTick } from '../../core/clock.js';
import { clamp, clamp01 } from '../../core/math.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';

/** Trust below this blocks expansion (chapter 7 anti-exploit gate). */
export const CRITICAL_TRUST = -60;

export class CommunitySystem implements ISimulationSystem {
  readonly name = 'community';
  readonly order = 125;

  tick(tick: SimulationTick, context: SimulationContext): void {
    if (!tick.cadence.day) return;
    const state = context.state;
    const region = context.region;
    const sensitivity = region.people.communitySensitivity01;

    let delta = 0;

    // Jobs and local spend, against the size of the local labour market.
    delta += clamp01(state.company.staffCount / Math.max(40, region.people.populationDensity * 0.4)) * 0.10;

    // Water competition, the dominant term in a stressed watershed.
    const permitted = region.water.annualWithdrawalLimitM3 * state.world.waterLimitFactor;
    const waterShare = permitted > 0 ? state.world.waterWithdrawnYearM3 / permitted : 0;
    delta -= waterShare * region.water.stress01 * sensitivity * 0.35;

    // Noise and air quality from generator run hours over the last day.
    for (const facility of state.facilities) {
      for (const asset of facility.powerAssets) {
        if (!asset.available) continue;
        const definition = context.registry.power(asset.definitionId, asset.instanceId);
        if (definition.communityDeltaPerRunHour === 0) continue;
        delta += definition.communityDeltaPerRunHour * Math.min(24, asset.runHoursThisYear) * sensitivity * 0.05;
      }
    }

    // Heat exported to a neighbour is the clearest local benefit available.
    if (state.year.exportedHeatMwh > 0) delta += 0.06;

    // Habitat and transparency.
    const biodiversity = state.facilities.reduce((total, f) => total + f.biodiversity, 0)
      / Math.max(1, state.facilities.length);
    delta += (biodiversity - 50) / 50 * 0.04;
    if (region.policy.reportingMandatory && state.research.capabilities.includes('carbon_ledger')) delta += 0.03;

    delta += context.modifiers.value('community.trustGain', 0) * 0.05;

    // Trust decays toward the regional baseline: goodwill is not permanent and
    // neither is anger.
    const baseline = region.people.startingTrust;
    delta += (baseline - state.company.communityTrust) * 0.002;

    state.company.communityTrust = clamp(state.company.communityTrust + delta, -100, 100);

    const blocked = state.gateFlags.includes('gate.community_trust');
    if (state.company.communityTrust <= CRITICAL_TRUST && !blocked) {
      state.gateFlags.push('gate.community_trust');
      context.diagnostic('community.expansion_blocked',
        'Community trust is critical; expansion is blocked',
        { tick: tick.index, trust: Number(state.company.communityTrust.toFixed(1)) });
    } else if (state.company.communityTrust > CRITICAL_TRUST + 10 && blocked) {
      state.gateFlags = state.gateFlags.filter((gate) => gate !== 'gate.community_trust');
      context.diagnostic('community.expansion_unblocked', 'Community trust recovered; expansion is possible again',
        { tick: tick.index, trust: Number(state.company.communityTrust.toFixed(1)) });
    }
  }
}
