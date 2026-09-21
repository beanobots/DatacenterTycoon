/**
 * Pipeline step 2: update price, grid carbon and grid availability.
 *
 * Price and carbon both come from the region's shape curves times a drift that
 * compounds annually, so a 35-year campaign sees the grid decarbonise (or not)
 * around the player. Outages are sampled hourly and persist for a sampled
 * number of ticks, so a grid loss is an event with a duration rather than a
 * single bad tick.
 */

import type { SimulationTick } from '../../core/clock.js';
import { clamp, sampleHourlyCurve, sampleMonthlyCurve } from '../../core/math.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';

export class MarketSystem implements ISimulationSystem {
  readonly name = 'market';
  readonly order = 20;

  tick(tick: SimulationTick, context: SimulationContext): void {
    const market = context.state.world.market;
    const { grid } = context.region;
    const stream = context.streams.get('market');

    if (tick.cadence.year) {
      market.priceDriftFactor *= 1 + grid.annualPriceDrift;
      market.carbonDriftFactor *= 1 + grid.annualCarbonDrift;
    }

    const hourFraction = tick.hourOfDay + tick.gameTimeUtc.getUTCMinutes() / 60;
    const priceShape = sampleHourlyCurve(grid.hourlyPriceShape, hourFraction)
      * sampleMonthlyCurve(grid.monthlyPriceShape, tick.dayOfYear);
    // Scarcity in heat: when it is hot the whole region is cooling, and the
    // marginal generator is the expensive one.
    const heatPremium = 1 + clamp((context.state.world.weather.dryBulbC - 30) / 20, 0, 1) * 0.55;
    const noise = tick.cadence.hour ? Math.exp(stream.normal(0, 0.12)) : 1;

    market.energyPricePerMwh = Math.max(1,
      grid.basePricePerMwh * priceShape * market.priceDriftFactor * heatPremium * noise);

    const carbonShape = sampleHourlyCurve(grid.hourlyCarbonShape, hourFraction);
    // Carbon intensity rises in the evening peak as the cleanest supply runs out.
    market.gridCarbonKgPerMwh = Math.max(0,
      grid.baseCarbonKgPerMwh * carbonShape * market.carbonDriftFactor);

    // The contract price factor is driven by commercial events; read it back
    // from the modifier stack each tick so an expiring event releases it.
    market.contractPriceFactor = context.modifiers.value('market.contractPrice', 1);

    this.updateAvailability(tick, context);
  }

  private updateAvailability(tick: SimulationTick, context: SimulationContext): void {
    const market = context.state.world.market;
    // An event may force the grid down for its whole duration.
    if (context.modifiers.has('grid.available') && context.modifiers.value('grid.available', 1) <= 0) {
      market.gridAvailable = false;
      market.outageTicksRemaining = Math.max(market.outageTicksRemaining, 1);
      return;
    }

    if (market.outageTicksRemaining > 0) {
      market.outageTicksRemaining -= 1;
      market.gridAvailable = market.outageTicksRemaining <= 0;
      if (market.gridAvailable) {
        context.diagnostic('grid.restored', 'Grid import restored', { tick: tick.index });
      }
      return;
    }

    if (!tick.cadence.hour) return;
    const stream = context.streams.get('failure');
    if (stream.chance(context.region.grid.hourlyOutageProbability)) {
      const hours = Math.max(0.25, context.region.grid.meanOutageHours * (0.4 + stream.float01() * 1.6));
      market.outageTicksRemaining = Math.ceil((hours * 60) / tick.minutes);
      market.gridAvailable = false;
      context.diagnostic('grid.outage', `Grid import lost for about ${hours.toFixed(1)} hours`, {
        tick: tick.index, hours: Number(hours.toFixed(2)),
      });
    }
  }
}
