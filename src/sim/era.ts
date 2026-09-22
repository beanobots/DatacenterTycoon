/**
 * The campaign's place in history.
 *
 * A thirty-year campaign that runs 2006 to 2036 is not one year repeated. A
 * 2006 rack holds a handful of dual-core machines and earns accordingly; a
 * 2036 rack does a couple of hundred times the work for a fraction of the
 * price per unit. Modelling neither of those makes the early game absurd and
 * the late game meaningless, and makes the contract balance impossible to hold
 * at both ends - anything priced for 2006 is free money in 2030.
 *
 * Four curves carry it, all anchored at named years and interpolated between
 * them, flat outside the range:
 *
 *   computePerRack        what a rack delivers, rising steeply then slowing
 *   revenuePerComputeUnit what that work sells for, falling nearly as fast
 *   rackPowerKw           density, which is why cooling keeps getting harder
 *   rackCost              capital per rack, roughly flat in nominal terms
 *
 * The first two are deliberately near-reciprocal. Performance rose faster than
 * price fell, so revenue per rack grows - about 2.7x across the window - but
 * it grows at a rate an operator can plan around rather than exploding. A
 * contract's size is scaled by the same compute curve as the hardware, so
 * "how many racks does this contract need" stays roughly era-independent and
 * the balance holds in 2006 and 2036 alike.
 */

import type { SimulationContext } from './context.js';
import type { BalanceProfileDefinition, RegionDefinition } from '../definitions/types.js';

/** A curve value at a named year. */
export interface EraPoint {
  readonly year: number;
  readonly value: number;
}

/**
 * Value of an anchored curve at a year, linear between anchors and flat
 * outside them. Flat rather than extrapolated on purpose: a campaign that
 * somehow runs past 2036 should not be handed an extrapolated Moore's law.
 */
export function interpolate(points: readonly EraPoint[], year: number): number {
  if (points.length === 0) return 1;
  const first = points[0];
  if (!first) return 1;
  if (year <= first.year) return first.value;

  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const next = points[i];
    if (!previous || !next) continue;
    if (year <= next.year) {
      const span = next.year - previous.year;
      if (span <= 0) return next.value;
      const t = (year - previous.year) / span;
      return previous.value + (next.value - previous.value) * t;
    }
  }
  return points[points.length - 1]?.value ?? 1;
}

/** Fractional year, so a curve moves through a campaign rather than in steps. */
export function fractionalYear(context: SimulationContext): number {
  const date = new Date(context.state.meta.gameTimeIso);
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const end = Date.UTC(date.getUTCFullYear() + 1, 0, 1);
  return date.getUTCFullYear() + (date.getTime() - start) / (end - start);
}

export interface EraFactors {
  /** Multiplier on a rack's compute output against the 2006 baseline. */
  readonly computePerRack: number;
  /** Multiplier on revenue per compute-unit-hour. */
  readonly revenuePerComputeUnit: number;
  /** Multiplier on a rack's power draw: density rises through the window. */
  readonly rackPowerKw: number;
  /** Multiplier on what a rack costs to buy. */
  readonly rackCost: number;
  /**
   * Real growth in the work one contract represents, measured in racks.
   *
   * Scaling contract size by the compute curve alone holds racks-per-contract
   * constant, so an operator's fleet SHRINKS as hardware improves - the same
   * customers fit on fewer machines every year. This curve is the industry
   * getting bigger, which is what makes a campus out of a single hall.
   */
  readonly demandIndex: number;
  /** Multiplier on how many offers reach the market each month. */
  readonly offerCountIndex: number;
  /**
   * General price level for labour and services, against 2025.
   *
   * Everything a data centre buys that is not the hardware itself - staff,
   * insurance, transit, maintenance, construction, land, research - cost less
   * in 2006 and will cost more in 2036. Leaving this out is what made an
   * early campaign unwinnable: 2025-scale interest and research bills against
   * revenue the era had already scaled down.
   */
  readonly costIndex: number;
}

/** Where the campaign currently sits on each curve. */
export function eraFactors(context: SimulationContext): EraFactors {
  return eraFactorsAt(context.balance, fractionalYear(context));
}

export function eraFactorsAt(balance: BalanceProfileDefinition, year: number): EraFactors {
  const era = balance.era;
  return {
    computePerRack: interpolate(era.computePerRack, year),
    revenuePerComputeUnit: interpolate(era.revenuePerComputeUnit, year),
    rackPowerKw: interpolate(era.rackPowerKw, year),
    rackCost: interpolate(era.rackCost, year),
    demandIndex: interpolate(era.demandIndex, year),
    offerCountIndex: interpolate(era.offerCountIndex, year),
    costIndex: interpolate(era.costIndex, year),
  };
}

/** Grid carbon intensity this region has in this year, kg CO2e/MWh. */
export function regionalCarbonAt(region: RegionDefinition, year: number): number {
  return interpolate(region.trajectory.gridCarbonKgPerMwh, year);
}

/** Wholesale energy price this region has in this year, $/MWh. */
export function regionalPriceAt(region: RegionDefinition, year: number): number {
  return interpolate(region.trajectory.energyPricePerMwh, year);
}

/** What a rack of this hardware delivers and draws, for a given vintage. */
export interface RackOutput {
  /** Compute units per tick before affinity, condition or throttle. */
  readonly computeUnits: number;
  /** Power draw at full load, kW. */
  readonly powerKw: number;
}

/**
 * Output of a rack bought in `vintageYear`.
 *
 * Research modifiers still apply on top and still apply to the whole fleet:
 * virtualization or a power-capping technology genuinely improves machines
 * already on the floor. What does not apply retroactively is the passage of
 * time, which is exactly the distinction the vintage draws.
 */
export function rackOutputAt(
  context: SimulationContext,
  hardware: { readonly computeFactor: number; readonly powerFactor: number },
  vintageYear: number,
): RackOutput {
  const era = eraFactorsAt(context.balance, vintageYear);
  return {
    computeUnits: context.balance.baseRackComputeUnits * hardware.computeFactor
      * era.computePerRack * context.modifiers.value('hardware.computePerRack', 1),
    powerKw: context.balance.baseRackPowerKw * hardware.powerFactor
      * era.rackPowerKw * context.modifiers.value('hardware.powerDraw', 1),
  };
}

/** Output of a rack group already on the floor, at its own vintage. */
export function groupRackOutput(
  context: SimulationContext,
  group: { readonly hardwareId: string; readonly instanceId: string; readonly vintageYear?: number },
): RackOutput {
  const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
  return rackOutputAt(context, hardware, group.vintageYear ?? fractionalYear(context));
}

/** Output of a rack bought today, for a purchase the player is considering. */
export function currentRackOutput(
  context: SimulationContext,
  hardware: { readonly computeFactor: number; readonly powerFactor: number },
): RackOutput {
  return rackOutputAt(context, hardware, fractionalYear(context));
}
