/**
 * The annual report.
 *
 * Built from accumulated energy, water, carbon and cash - never from averaged
 * ratios (spec chapter 9). PUE, CUE and WUE are divided once, here, from the
 * year's totals, and are null when IT energy is zero rather than infinite
 * (chapter 14: "PUE not calculated when IT energy is zero").
 */

import { round, safeDivide } from '../core/math.js';
import type { PeriodAccumulator } from '../state/types.js';
import { totalCost, totalRevenue } from '../state/types.js';
import type { SimulationContext } from './context.js';

export interface AnnualReport {
  readonly year: number;
  readonly financial: {
    readonly revenue: number;
    readonly cost: number;
    readonly operatingProfit: number;
    readonly operatingMargin01: number;
    readonly cash: number;
    readonly debt: number;
    /** Months of operating cost the cash balance covers. */
    readonly runwayMonths: number;
    /** Operating profit over debt service. */
    readonly debtCoverage: number;
    /** 0-1 Herfindahl-based diversity of the contract book. */
    readonly revenueDiversity01: number;
    readonly capex: number;
  };
  readonly reliability: {
    readonly availability01: number;
    readonly slaCompliance01: number;
    readonly incidents: number;
    readonly preventableIncidents: number;
    readonly degradedTickShare01: number;
    /** Installed power capacity over peak demand. */
    readonly reserveMargin01: number;
  };
  readonly environment: {
    readonly itMwh: number;
    readonly facilityMwh: number;
    readonly pue: number | null;
    readonly cue: number | null;
    readonly wue: number | null;
    readonly ref01: number;
    readonly erf01: number;
    readonly hourlyMatch01: number;
    readonly operationalCarbonTonnes: number;
    readonly embodiedCarbonTonnes: number;
    readonly offsetTonnes: number;
    readonly netCarbonTonnes: number;
    readonly waterWithdrawnM3: number;
    readonly waterConsumedM3: number;
    readonly reclaimedShare01: number;
    readonly wasteDiversion01: number;
    readonly biodiversity: number;
  };
  readonly customer: {
    readonly contractsActive: number;
    readonly completion01: number;
    readonly latencyMs: number;
    readonly latencySatisfaction01: number;
    readonly reputation: number;
  };
  readonly social: {
    readonly trust: number;
    readonly jobs: number;
    readonly heatExportedMwh: number;
    readonly gridServiceRevenue: number;
    readonly transparent: boolean;
  };
  readonly capacity: {
    readonly itCapacityMw: number;
    readonly rackCount: number;
    readonly hallCount: number;
    readonly powerCapacityMw: number;
  };
  readonly research: {
    readonly completed: number;
    readonly points: number;
  };
}

export function buildAnnualReport(context: SimulationContext, year: number, period: PeriodAccumulator): AnnualReport {
  const state = context.state;
  const revenue = totalRevenue(period);
  const cost = totalCost(period);
  const profit = revenue - cost;

  const availability01 = period.demandedUnitHours > 0
    ? safeDivide(period.servedUnitHours, period.demandedUnitHours, 1)
    : 1;

  const itCapacityMw = installedItMw(context);
  const powerCapacityMw = state.facilities
    .flatMap((f) => f.powerAssets)
    .filter((a) => a.constructionProgress01 >= 1)
    .reduce((total, a) => total + a.capacityMw, 0);

  const wasteTotal = period.wasteGeneratedTonnes;
  const biodiversity = state.facilities.length > 0
    ? state.facilities.reduce((t, f) => t + f.biodiversity, 0) / state.facilities.length
    : 50;

  const totalWater = period.waterWithdrawnM3 + period.waterReclaimedM3;

  return {
    year,
    financial: {
      revenue: round(revenue, 2),
      cost: round(cost, 2),
      operatingProfit: round(profit, 2),
      operatingMargin01: round(safeDivide(profit, revenue, 0), 5),
      cash: round(state.company.cash, 2),
      debt: round(state.company.debt, 2),
      runwayMonths: round(safeDivide(state.company.cash, cost / 12, 999), 2),
      debtCoverage: round(safeDivide(profit, state.company.debt * context.balance.annualInterestRate01, 99), 3),
      revenueDiversity01: round(revenueDiversity(context), 4),
      capex: round(period.capex, 2),
    },
    reliability: {
      availability01: round(availability01, 6),
      slaCompliance01: round(slaCompliance(context), 4),
      incidents: period.incidents,
      preventableIncidents: period.preventableIncidents,
      degradedTickShare01: round(safeDivide(period.degradedTicks, period.totalTicks, 0), 5),
      reserveMargin01: round(safeDivide(powerCapacityMw, Math.max(itCapacityMw, 0.001), 0) - 1, 4),
    },
    environment: {
      itMwh: round(period.itMwh, 3),
      facilityMwh: round(period.facilityMwh, 3),
      pue: period.itMwh > 0 ? round(period.facilityMwh / period.itMwh, 4) : null,
      cue: period.itMwh > 0 ? round(period.operationalCarbonKg / period.itMwh, 3) : null,
      wue: period.itMwh > 0 ? round((period.waterWithdrawnM3 + period.waterReclaimedM3) / period.itMwh, 4) : null,
      ref01: round(safeDivide(period.renewableMwh, period.facilityMwh, 0), 4),
      erf01: round(safeDivide(period.exportedHeatMwh, period.facilityMwh, 0), 4),
      hourlyMatch01: round(safeDivide(period.hourlyMatchedCleanMwh, period.facilityMwh, 0), 4),
      operationalCarbonTonnes: round(period.operationalCarbonKg / 1000, 3),
      embodiedCarbonTonnes: round(period.embodiedCarbonKg / 1000, 3),
      offsetTonnes: round(period.offsetCarbonKg / 1000, 3),
      netCarbonTonnes: round((period.operationalCarbonKg + period.embodiedCarbonKg - period.offsetCarbonKg) / 1000, 3),
      waterWithdrawnM3: round(period.waterWithdrawnM3, 2),
      waterConsumedM3: round(period.waterConsumedM3, 2),
      reclaimedShare01: round(safeDivide(period.waterReclaimedM3, totalWater, 0), 4),
      wasteDiversion01: round(safeDivide(period.wasteDivertedTonnes, wasteTotal, 1), 4),
      biodiversity: round(biodiversity, 2),
    },
    customer: {
      contractsActive: state.contracts.length,
      completion01: round(availability01, 5),
      latencyMs: context.region.connectivity.latencyMsToDemandCentre
        * context.modifiers.value('network.latency', 1),
      latencySatisfaction01: round(latencySatisfaction(context), 4),
      reputation: round(state.company.reputation, 2),
    },
    social: {
      trust: round(state.company.communityTrust, 2),
      jobs: Math.round(state.company.staffCount),
      heatExportedMwh: round(period.exportedHeatMwh, 3),
      gridServiceRevenue: round(period.gridServiceRevenue, 2),
      transparent: state.research.capabilities.includes('carbon_ledger'),
    },
    capacity: {
      itCapacityMw: round(itCapacityMw, 4),
      rackCount: state.facilities.flatMap((f) => f.halls).flatMap((h) => h.rackGroups)
        .reduce((total, g) => total + g.count, 0),
      hallCount: state.facilities.reduce((total, f) => total + f.halls.length, 0),
      powerCapacityMw: round(powerCapacityMw, 3),
    },
    research: {
      completed: state.research.completed.length,
      points: round(state.company.researchPoints, 1),
    },
  };
}

/** Installed IT capacity, MW, at full rated draw. */
export function installedItMw(context: SimulationContext): number {
  let kw = 0;
  for (const facility of context.state.facilities) {
    for (const hall of facility.halls) {
      if (hall.constructionProgress01 < 1) continue;
      for (const group of hall.rackGroups) {
        const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
        kw += group.count * context.balance.baseRackPowerKw * hardware.powerFactor;
      }
    }
  }
  return kw / 1000;
}

/** 1 - Herfindahl index over contract revenue shares. One tenant scores 0. */
function revenueDiversity(context: SimulationContext): number {
  const contracts = context.state.contracts;
  if (contracts.length === 0) return 0;
  const values = contracts.map((c) => c.computeUnits * c.pricePerComputeUnitHour);
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  const herfindahl = values.reduce((sum, value) => sum + (value / total) ** 2, 0);
  return Math.max(0, (1 - herfindahl) / (1 - 1 / contracts.length || 1));
}

/** Share of contracts whose lifetime availability meets their commitment. */
function slaCompliance(context: SimulationContext): number {
  const contracts = context.state.contracts;
  if (contracts.length === 0) return 1;
  let met = 0;
  for (const contract of contracts) {
    const definition = context.registry.contract(contract.definitionId, contract.instanceId);
    const availability = contract.lifetimeDemandedUnitHours > 0
      ? contract.lifetimeServedUnitHours / contract.lifetimeDemandedUnitHours
      : 1;
    if (availability >= definition.slaUptime01) met += 1;
  }
  return met / contracts.length;
}

/** How well regional latency serves the contract book's tolerance. */
function latencySatisfaction(context: SimulationContext): number {
  const contracts = context.state.contracts;
  if (contracts.length === 0) return 1;
  const latency = context.region.connectivity.latencyMsToDemandCentre
    * context.modifiers.value('network.latency', 1);
  let total = 0;
  for (const contract of contracts) {
    const definition = context.registry.contract(contract.definitionId, contract.instanceId);
    const workload = context.registry.workload(definition.workloadId, definition.id);
    const satisfied = latency <= workload.latencyToleranceMs
      ? 1
      : Math.max(0, 1 - (latency - workload.latencyToleranceMs) / workload.latencyToleranceMs);
    // Latency-insensitive workloads barely notice; finance notices everything.
    total += 1 - (1 - satisfied) * workload.latencySensitivity01;
  }
  return total / contracts.length;
}
