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

/** Reputation a contract can cost in one month, however badly it was missed. */
const MAX_MONTHLY_REPUTATION_LOSS = 1.5;
/** Reputation a contract earns for a month delivered in full. */
const MONTHLY_REPUTATION_GAIN = 0.35;

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
      const shortfall = Math.max(0, definition.slaUptime01 - availability);

      if (shortfall > 0) {
        const multiplier = PENALTY_CLASS_MULTIPLIER[workload.penaltyClass] ?? 1;
        // The penalty rate is charged per point of missed availability, so a
        // 0.5% miss on a 99.9% contract is a real but survivable charge and a
        // 20% miss is not.
        const penalty = contract.revenueThisPeriod * definition.penaltyRate * multiplier * (shortfall * 100) / 100;
        contract.penaltiesThisPeriod += penalty;
        context.state.hour.penalties += penalty;

        context.diagnostic('sla.breach',
          `${definition.name} missed its availability commitment`,
          {
            tick: tick.index,
            contract: definition.id,
            required: definition.slaUptime01,
            achieved: Number(availability.toFixed(5)),
            penalty: Math.round(penalty),
          });

        // Reputation reacts to the severity of the miss, not merely to its
        // existence: a brief degradation is not the same as a lost month.
        // The loss is capped per contract per month so a bad summer damages
        // standing without destroying it - an operator has to be able to
        // recover from one, or the interest-rate premium on a low reputation
        // becomes an inescapable spiral.
        const loss = Math.min(MAX_MONTHLY_REPUTATION_LOSS, shortfall * 100 * multiplier * 0.5);
        context.state.company.reputation = Math.max(0, context.state.company.reputation - loss);
      } else {
        // Recovery has to be able to outrun a run of small misses, or every
        // operator converges on zero standing.
        context.state.company.reputation = Math.min(100,
          context.state.company.reputation
          + MONTHLY_REPUTATION_GAIN * context.modifiers.value('company.reputationGain', 1));
      }

      contract.servedUnitHours = 0;
      contract.demandedUnitHours = 0;
      contract.revenueThisPeriod = 0;
      contract.penaltiesThisPeriod = 0;
    }
  }
}
