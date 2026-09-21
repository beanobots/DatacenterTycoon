/**
 * Pipeline step 3: generate workload arrivals and deadlines.
 *
 * Each active contract presents demand shaped by its workload's daily curve and
 * mean utilisation. Flexible workloads carry a backlog: work deferred by
 * carbon-aware scheduling is added back when conditions improve, so deferral
 * moves energy in time rather than making it disappear.
 */

import type { SimulationTick } from '../../core/clock.js';
import { clamp01, sampleHourlyCurve } from '../../core/math.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';

/** Share of a deferred backlog that can be caught up in any one tick. */
const BACKLOG_CATCHUP_RATE = 0.12;

export class WorkloadArrivalSystem implements ISimulationSystem {
  readonly name = 'workload-arrival';
  readonly order = 30;

  tick(tick: SimulationTick, context: SimulationContext): void {
    const stream = context.streams.get('workload');
    const hourFraction = tick.hourOfDay + tick.gameTimeUtc.getUTCMinutes() / 60;

    for (const contract of context.state.contracts) {
      if (tick.index < contract.startTick || tick.index > contract.endTick) continue;
      const definition = context.registry.contract(contract.definitionId, contract.instanceId);
      const workload = context.registry.workload(definition.workloadId, definition.id);

      const shape = sampleHourlyCurve(workload.hourlyDemandShape, hourFraction);
      // Arrival noise is lognormal so demand never goes negative and spikes
      // are possible without the mean drifting.
      const noise = Math.exp(stream.normal(0, 0.09));
      // Demand is the capacity the customer RESERVED, shaped by their daily
      // curve - not the share of it they happen to be using. A tenant holding
      // 2,000 units occupies 2,000 units of the fleet whether or not their jobs
      // are running; `meanUtilization01` decides how much power those units
      // draw, which the IT power system applies. Sizing the reservation by
      // utilisation instead would let an operator sell the same rack three
      // times over to low-utilisation tenants and be paid in full for it.
      const baseUnits = contract.computeUnits * shape * noise;

      const catchUp = contract.backlogUnitHours * BACKLOG_CATCHUP_RATE;
      contract.backlogUnitHours = Math.max(0, contract.backlogUnitHours - catchUp);

      const unitsThisTick = Math.max(0, baseUnits + catchUp / tick.hours);
      context.scratch.demandByContract.set(contract.instanceId, unitsThisTick);
    }

    this.applyCarbonAwareDeferral(tick, context);
  }

  /**
   * Carbon-aware scheduling and load migration defer part of the flexible
   * demand when this hour is dirty or expensive relative to the day's typical
   * conditions. The deferred work lands in the contract's backlog and is served
   * later; the deadline pressure that creates is the trade-off the spec calls
   * out for this technology.
   */
  private applyCarbonAwareDeferral(tick: SimulationTick, context: SimulationContext): void {
    const shiftShare = clamp01(
      context.modifiers.value('scheduling.carbonAwareShift01', 0)
      + context.modifiers.value('scheduling.loadMigration01', 0)
      + context.modifiers.value('scheduling.flexibleShift01', 0),
    );
    if (shiftShare <= 0) return;

    const market = context.state.world.market;
    const region = context.region;
    // "Dirty hour" means carbon intensity above the regional annual mean, and
    // the size of the exceedance decides how much is worth moving.
    const carbonRatio = region.grid.baseCarbonKgPerMwh > 0
      ? market.gridCarbonKgPerMwh / (region.grid.baseCarbonKgPerMwh * market.carbonDriftFactor)
      : 1;
    const priceRatio = market.energyPricePerMwh / (region.grid.basePricePerMwh * market.priceDriftFactor);
    const pressure = clamp01(Math.max(carbonRatio, priceRatio) - 1);
    if (pressure <= 0) return;

    for (const contract of context.state.contracts) {
      const demand = context.scratch.demandByContract.get(contract.instanceId);
      if (demand === undefined || demand <= 0) continue;
      const definition = context.registry.contract(contract.definitionId, contract.instanceId);
      const workload = context.registry.workload(definition.workloadId, definition.id);
      if (workload.flexibility01 <= 0) continue;

      const deferrable = demand * workload.flexibility01 * shiftShare * pressure;
      if (deferrable <= 0) continue;
      context.scratch.demandByContract.set(contract.instanceId, demand - deferrable);
      contract.backlogUnitHours += deferrable * tick.hours;
    }
  }
}
