/**
 * Pipeline step 9: account for water, carbon, waste, revenue and cost.
 *
 * Spec chapter 9 determinism rule: "Use accumulated energy and water for
 * reports rather than averaging ratios." Everything here adds to accumulators;
 * PUE, CUE and WUE are divided once, at report time, from the totals.
 *
 * Spec chapter 6 metric discipline: carbon, water, waste and energy stay
 * separate quantities. Nothing in this system collapses them into a score.
 */

import type { SimulationTick } from '../../core/clock.js';
import { assertFinite, clamp01 } from '../../core/math.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';

export class AccountingSystem implements ISimulationSystem {
  readonly name = 'accounting';
  readonly order = 90;

  tick(tick: SimulationTick, context: SimulationContext): void {
    const scratch = context.scratch;
    const period = context.state.hour;
    const market = context.state.world.market;
    const world = context.state.world;

    period.totalTicks += 1;

    // --- Energy -------------------------------------------------------------
    const itMwh = (scratch.itPowerKw / 1000) * tick.hours;
    period.itMwh += itMwh;
    period.coolingMwh += (scratch.coolingPowerKw / 1000) * tick.hours;
    period.electricalLossMwh += (scratch.electricalLossKw / 1000) * tick.hours;
    period.auxiliaryMwh += (scratch.auxiliaryKw / 1000) * tick.hours;
    period.facilityMwh += (scratch.facilityPowerKw / 1000) * tick.hours;

    // --- Carbon and energy cost by source ------------------------------------
    let cleanThisTick = 0;
    let consumedThisTick = 0;
    let tickCarbonKg = 0;
    for (const [sourceId, mwh] of scratch.energyBySource) {
      if (mwh <= 0) continue;
      const source = context.registry.power(sourceId);
      period.energyBySource[sourceId] = (period.energyBySource[sourceId] ?? 0) + mwh;
      consumedThisTick += mwh;

      const intensity = source.carbonMode === 'regional'
        ? market.gridCarbonKgPerMwh
        : source.carbonFactor * context.balance.baseCarbonKgPerMwh;
      period.operationalCarbonKg += mwh * intensity;
      tickCarbonKg += mwh * intensity;

      const price = source.priceMode === 'regional'
        ? market.energyPricePerMwh
        : source.variableCostFactor * context.balance.basePricePerMwh;
      period.energyCost += mwh * price;

      if (source.fuelPerMwh > 0) {
        // Fuel is metered separately from the energy price so a diesel run is
        // visible in the report as fuel, not as electricity.
        period.fuelCost += mwh * source.fuelPerMwh * 0.85;
      }
      if (source.renewable) period.renewableMwh += mwh;
      if (source.clean) {
        period.cleanMwh += mwh;
        cleanThisTick += mwh;
      }
    }
    // Hourly matching: clean supply counts only against consumption in the same
    // simulated hour (spec chapter 6), so banked annual certificates cannot
    // stand in for it.
    period.hourlyMatchedCleanMwh += Math.min(cleanThisTick, consumedThisTick);

    // --- Carbon price --------------------------------------------------------
    // Priced on this tick's own emissions, not on the period total, which
    // would re-charge every earlier tick in the period.
    const carbonPrice = context.region.policy.carbonPricePerTonne
      * context.modifiers.value('policy.carbonPrice', 1);
    period.carbonCost += (tickCarbonKg / 1000) * carbonPrice;

    // --- Water ---------------------------------------------------------------
    const reclaimedShare = clamp01(
      context.state.research.capabilities.includes('water_reuse')
        ? context.region.water.reclaimedAvailability01
        : 0,
    );
    const waterM3 = scratch.coolingWaterM3 * tick.hours;
    const reclaimedM3 = waterM3 * reclaimedShare;
    const freshM3 = waterM3 - reclaimedM3;

    period.waterWithdrawnM3 += freshM3;
    period.waterReclaimedM3 += reclaimedM3;
    // Evaporative cooling consumes most of what it draws; the rest returns.
    period.waterConsumedM3 += waterM3 * 0.85;
    world.waterWithdrawnYearM3 += freshM3;

    const waterPrice = context.region.water.pricePerM3 * world.waterPriceFactor
      * context.modifiers.value('water.priceMultiplier', 1);
    period.waterCost += freshM3 * waterPrice + reclaimedM3 * context.region.water.reclaimedPricePerM3;

    const permittedM3 = context.region.water.annualWithdrawalLimitM3
      * world.waterLimitFactor * context.modifiers.value('water.withdrawalLimit', 1);
    if (world.waterWithdrawnYearM3 > permittedM3 && !context.state.gateFlags.includes('gate.permit_violation')) {
      context.state.gateFlags.push('gate.permit_violation');
      context.diagnostic('permit.water_exceeded',
        'Annual water withdrawal exceeded the regional permit',
        {
          tick: tick.index,
          withdrawnM3: Math.round(world.waterWithdrawnYearM3),
          permittedM3: Math.round(permittedM3),
        });
    }

    // --- Revenue --------------------------------------------------------------
    for (const contract of context.state.contracts) {
      const served = scratch.servedByContract.get(contract.instanceId) ?? 0;
      const demanded = scratch.demandByContract.get(contract.instanceId) ?? 0;
      if (demanded <= 0 && served <= 0) continue;
      const definition = context.registry.contract(contract.definitionId, contract.instanceId);

      const servedUnitHours = served * tick.hours;
      const demandedUnitHours = demanded * tick.hours;
      contract.servedUnitHours += servedUnitHours;
      contract.demandedUnitHours += demandedUnitHours;
      contract.lifetimeServedUnitHours += servedUnitHours;
      contract.lifetimeDemandedUnitHours += demandedUnitHours;

      // Contracts bill for RESERVED capacity, not for utilisation: the customer
      // pays for the units they committed to, reduced by the share the operator
      // failed to deliver. That is what makes a low-utilisation tenant like
      // disaster recovery worth having, and what makes an outage cost revenue
      // rather than merely cost goodwill.
      const deliveryRatio = demandedUnitHours > 0 ? servedUnitHours / demandedUnitHours : 1;
      const billedUnitHours = contract.computeUnits * tick.hours * deliveryRatio;
      const revenue = billedUnitHours * contract.pricePerComputeUnitHour * market.contractPriceFactor;
      contract.revenueThisPeriod += revenue;
      period.revenue += revenue;
      period.servedUnitHours += servedUnitHours;
      period.demandedUnitHours += demandedUnitHours;
    }
    if (period.demandedUnitHours > 0 && scratch.servedByContract.size > 0) {
      const shortfall = [...scratch.demandByContract.entries()].some(([id, demand]) =>
        demand - (scratch.servedByContract.get(id) ?? 0) > demand * 0.001);
      if (shortfall) period.degradedTicks += 1;
    }

    // --- Heat reuse -----------------------------------------------------------
    const heatMwh = (scratch.recoverableHeatKw / 1000) * tick.hours;
    period.exportedHeatMwh += heatMwh;
    period.heatRevenue += heatMwh * context.balance.heatSaleRevenuePerMwh
      * context.modifiers.value('heat.reuseRevenue', 1);

    // --- Grid services ---------------------------------------------------------
    const demandResponse = context.modifiers.value('grid.demandResponseRevenue', 0);
    if (demandResponse > 0) {
      // Paid on available flexible capacity, not on energy delivered.
      const flexibleMw = scratch.facilityPowerKw / 1000 * 0.15;
      period.gridServiceRevenue += flexibleMw * demandResponse * 14 * tick.hours;
    }

    assertFinite(period.energyCost, 'energy cost');
    assertFinite(period.revenue, 'revenue');
  }
}
