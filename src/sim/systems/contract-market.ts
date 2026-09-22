/**
 * The contract market (spec chapter 3: monthly cadence).
 *
 * Contract definitions are archetypes. This system instantiates them as offers
 * with a negotiated size, price and term, so the market keeps producing work as
 * the operator grows instead of running out after ten signatures.
 *
 * What the operator is offered depends on what it has earned: reputation opens
 * larger and better-priced work, a poor carbon record closes the contracts that
 * carry an intensity ceiling, and commercial events move the whole price level.
 */

import type { SimulationTick } from '../../core/clock.js';
import { clamp, clamp01 } from '../../core/math.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';
import { eraFactors } from '../era.js';

/** How long an offer stays on the table. */
/** Smallest offer worth making, in 2025 compute units; scaled by the era. */
const MINIMUM_OFFER_UNITS = 200;

const OFFER_LIFETIME_MONTHS = 3;
/** Offers generated per month at maximum reputation. */
const MAX_OFFERS_PER_MONTH = 4;

export class ContractMarketSystem implements ISimulationSystem {
  readonly name = 'contract-market';
  readonly order = 128;
  private nextOffer = 0;

  initialize(context: SimulationContext): void {
    // A campaign starts with work already on the table; otherwise the first
    // month is spent with an empty facility and no reason to build one.
    this.generateOffers(context, 0, MAX_OFFERS_PER_MONTH);
  }

  tick(tick: SimulationTick, context: SimulationContext): void {
    if (!tick.cadence.month) return;
    context.state.contractOffers = context.state.contractOffers.filter((o) => o.expiresTick > tick.index);

    const reputation = clamp01(context.state.company.reputation / 100);
    // More customers exist in 2030 than in 2006, so standing is not the only
    // thing that decides how much reaches the table.
    const reach = eraFactors(context).offerCountIndex;
    const count = Math.max(1, Math.round((1 + reputation * (MAX_OFFERS_PER_MONTH - 1)) * reach));
    this.generateOffers(context, tick.index, count);
  }

  private generateOffers(context: SimulationContext, tick: number, count: number): void {
    const stream = context.streams.get('market');
    const state = context.state;
    const year = state.meta.campaignYear;

    const eligible = [...context.registry.all('contracts').values()].filter((definition) => {
      if (definition.availableFromYear > year) return false;
      const workload = context.registry.workload(definition.workloadId, definition.id);
      if (workload.availableFromYear > year) return false;
      // Reputation opens the market gradually; a near-miss still gets offered,
      // because a customer may take a chance on a cheaper operator.
      if (definition.minimumReputation > state.company.reputation + 5) return false;
      if (!definition.requiredTechnologies.every((id) => state.research.completed.includes(id))) return false;
      // A carbon ceiling is a hard gate: the operator's most recent reported
      // intensity has to clear it.
      if (definition.maxCarbonIntensity > 0) {
        const lastReport = state.annualScores.at(-1);
        const cue = this.lastReportedCue(context);
        if (lastReport === undefined || cue === null || cue > definition.maxCarbonIntensity) return false;
      }
      return true;
    });
    if (eligible.length === 0) return;

    for (let i = 0; i < count; i += 1) {
      const definition = stream.pick(eligible);
      // Size varies around the archetype and grows with the operator's
      // standing: a known operator is asked to bid on bigger work.
      const sizeFactor = Math.exp(stream.normal(0, 0.35))
        * (0.6 + clamp01(state.company.reputation / 100) * 0.9);
      // Contract sizes move with the decade for the same reason rack output
      // does. An archetype written for 2025 asks for capacity a 2006 fleet
      // could not reach in thirty years, and would be pocket change in 2036.
      // Scaling size by the same curve as the hardware keeps "how many racks
      // does this contract need" roughly era-independent, which is the only
      // way one set of balance numbers can hold across the whole window.
      const era = eraFactors(context);
      // Two curves, doing different jobs. computePerRack converts the
      // archetype into this decade's units so the number means the same
      // thing; demandIndex is the real growth on top, in racks, which is what
      // turns one hall into a campus over thirty years.
      const scale = era.computePerRack * era.demandIndex;
      const computeUnits = Math.max(
        Math.round(MINIMUM_OFFER_UNITS * scale),
        Math.round(definition.computeUnits * sizeFactor * scale),
      );

      // Price moves with the market and with how much the customer needs this
      // particular operator: a price-sensitive workload bargains harder.
      const workload = context.registry.workload(definition.workloadId, definition.id);
      const negotiation = 1
        + (clamp01(state.company.reputation / 100) - 0.5) * 0.25 * (1 - workload.priceSensitivity01)
        + stream.normal(0, 0.05);
      // Price per unit falls as fast as performance rises, so the money a
      // contract is worth tracks the era's revenue-per-rack rather than
      // multiplying out with it.
      const price = definition.pricePerComputeUnitHour
        * clamp(negotiation, 0.75, 1.35)
        * state.world.market.contractPriceFactor
        * era.revenuePerComputeUnit
        * context.balance.contractPriceScale;

      const termMonths = Math.max(6, Math.round(definition.termMonths * (0.75 + stream.float01() * 0.5)));

      state.contractOffers.push({
        instanceId: `offer.${definition.id}.${tick}.${this.nextOffer++}`,
        definitionId: definition.id,
        computeUnits,
        pricePerComputeUnitHour: price,
        termMonths,
        offeredTick: tick,
        expiresTick: tick + context.clock.ticksForDays(OFFER_LIFETIME_MONTHS * 30.44),
      });
    }
  }

  /** Carbon intensity from the most recent closed year, or null before one exists. */
  private lastReportedCue(context: SimulationContext): number | null {
    const year = context.state.year;
    if (year.itMwh > 0) return year.operationalCarbonKg / year.itMwh;
    return null;
  }
}
