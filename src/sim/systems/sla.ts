/**
 * Pipeline step 10: resolve SLA performance and emit diagnostic events.
 *
 * Availability is measured as served compute-unit-hours over demanded
 * compute-unit-hours across the SLA period, which is how a customer would
 * experience it: capacity they asked for and did not get. Penalties settle
 * monthly against the contract's own penalty rate.
 */

import type { SimulationTick } from '../../core/clock.js';
import { clamp01, safeDivide } from '../../core/math.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';
import { emptyShortfall } from '../../state/types.js';
import type { ActiveContractState, ShortfallCause } from '../../state/types.js';

/** Reputation a contract can cost in one month, however badly it was missed. */
const MAX_MONTHLY_REPUTATION_LOSS = 1.5;
/** Reputation a contract earns for a month delivered in full. */
const MONTHLY_REPUTATION_GAIN = 0.35;

/**
 * What the player should do about each cause, in the order the allocation step
 * can distinguish them. A breach the player cannot act on is just noise, so
 * every cause carries the lever that closes it.
 */
export const SHORTFALL_REMEDY: Record<ShortfallCause, string> = {
  noCompatibleHardware:
    'nothing in the fleet can run this workload. Buying more of what you own will not help - '
    + 'this needs racks of a compatible hardware family.',
  oversold:
    'you have sold more of this workload than the fleet can serve. Add racks, or drop a contract.',
  throttled:
    'the halls running it are shedding load because they are too hot. Retrofit denser cooling, '
    + 'or stop adding racks until they recover.',
  failedRacks:
    'racks are out of service waiting on repair. The maintenance backlog is the constraint, not capacity.',
  degraded:
    'the racks serving it are worn and running below rating. They are near replacement.',
};

/** Human label for each cause, for the log and the alert. */
export const SHORTFALL_LABEL: Record<ShortfallCause, string> = {
  noCompatibleHardware: 'no compatible hardware',
  oversold: 'oversold capacity',
  throttled: 'thermal throttling',
  failedRacks: 'failed racks',
  degraded: 'worn racks',
};

/** The cause carrying most of the unserved hours, with its share. */
export function dominantCause(
  contract: ActiveContractState,
): { cause: ShortfallCause; share01: number; total: number } | null {
  let total = 0;
  let best: ShortfallCause | null = null;
  let bestValue = 0;
  for (const key of Object.keys(contract.shortfall) as ShortfallCause[]) {
    const value = contract.shortfall[key];
    total += value;
    // Ties break on the fixed key order, so the same state always reports the
    // same cause.
    if (value > bestValue) { bestValue = value; best = key; }
  }
  if (!best || total <= 0) return null;
  return { cause: best, share01: bestValue / total, total };
}

/** Penalty multiplier by the workload's penalty class. */
const PENALTY_CLASS_MULTIPLIER: Record<string, number> = {
  low: 0.5, medium: 1.0, high: 1.6, extreme: 2.6,
};

export class SlaSystem implements ISimulationSystem {
  readonly name = 'sla';
  readonly order = 100;

  tick(tick: SimulationTick, context: SimulationContext): void {
    if (!tick.cadence.month) return;

    for (const contract of context.state.contracts) {
      if (contract.demandedUnitHours <= 0) continue;
      const definition = context.registry.contract(contract.definitionId, contract.instanceId);
      const workload = context.registry.workload(definition.workloadId, definition.id);

      const availability = clamp01(
        safeDivide(contract.servedUnitHours, contract.demandedUnitHours, 1),
      );
      // What THIS contract promised, not what its archetype asks for today.
      const required01 = contract.slaUptime01;
      const shortfall = Math.max(0, required01 - availability);

      if (shortfall > 0) {
        const multiplier = PENALTY_CLASS_MULTIPLIER[workload.penaltyClass] ?? 1;
        // The penalty rate is charged per point of missed availability, so a
        // 0.5% miss on a 99.9% contract is a real but survivable charge and a
        // 20% miss is not.
        // Charged against the contract's full value: a month served at zero is
        // the worst outcome and has to carry the largest credit, which charging
        // against delivered revenue got exactly backwards.
        const basis = contract.contractedRevenueThisPeriod > 0
          ? contract.contractedRevenueThisPeriod
          : contract.revenueThisPeriod;
        const penalty = basis * definition.penaltyRate * multiplier * (shortfall * 100) / 100;
        contract.penaltiesThisPeriod += penalty;
        context.state.hour.penalties += penalty;

        const dominant = dominantCause(contract);
        const because = dominant
          ? ` Mostly ${SHORTFALL_LABEL[dominant.cause]} `
            + `(${Math.round(dominant.share01 * 100)}% of the unserved hours): `
            + SHORTFALL_REMEDY[dominant.cause]
          : '';

        context.diagnostic('sla.breach',
          `${definition.name} served ${(availability * 100).toFixed(1)}% against a `
          + `${(required01 * 100).toFixed(2)}% commitment.${because}`,
          {
            tick: tick.index,
            contract: definition.id,
            required: required01,
            achieved: Number(availability.toFixed(5)),
            penalty: Math.round(penalty),
            cause: dominant ? dominant.cause : 'unattributed',
            causeShare: dominant ? Number(dominant.share01.toFixed(3)) : 0,
            unservedUnitHours: Math.round(dominant ? dominant.total : 0),
          });

        contract.lastPeriod = {
          endedTick: tick.index,
          required01,
          availability01: availability,
          penalty,
          ...(dominant
            ? {
              cause: dominant.cause,
              causeShare01: dominant.share01,
              unservedUnitHours: dominant.total,
            }
            : {}),
        };

        // Reputation reacts to the severity of the miss, not merely to its
        // existence: a brief degradation is not the same as a lost month.
        // The loss is capped per contract per month so a bad summer damages
        // standing without destroying it - an operator has to be able to
        // recover from one, or the interest-rate premium on a low reputation
        // becomes an inescapable spiral.
        const loss = Math.min(MAX_MONTHLY_REPUTATION_LOSS, shortfall * 100 * multiplier * 0.5);
        context.state.company.reputation = Math.max(0, context.state.company.reputation - loss);
      } else {
        contract.lastPeriod = {
          endedTick: tick.index,
          required01,
          availability01: availability,
          penalty: 0,
        };
        // Recovery has to be able to outrun a run of small misses, or every
        // operator converges on zero standing.
        context.state.company.reputation = Math.min(100,
          context.state.company.reputation
          + MONTHLY_REPUTATION_GAIN * context.modifiers.value('company.reputationGain', 1));
      }

      contract.servedUnitHours = 0;
      contract.demandedUnitHours = 0;
      contract.revenueThisPeriod = 0;
      contract.contractedRevenueThisPeriod = 0;
      contract.penaltiesThisPeriod = 0;
      contract.shortfall = emptyShortfall();
    }
  }
}
