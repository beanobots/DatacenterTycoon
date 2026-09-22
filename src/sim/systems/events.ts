/**
 * Events: trigger, sustain and expire the chapter 13 event catalog.
 *
 * Triggers are evaluated daily. An event's probability is scaled by the
 * region's matching hazard, so a heat wave is a desert problem and a flood is a
 * coastal one, and gated by a condition when it has one, so the heat wave fires
 * during hot weather rather than at random.
 */

import type { SimulationTick } from '../../core/clock.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';
import { rebuildModifiers } from '../context.js';
import type { EventDefinition } from '../../definitions/types.js';
import { clamp } from '../../core/math.js';

export class EventSystem implements ISimulationSystem {
  readonly name = 'events';
  readonly order = 110;

  tick(tick: SimulationTick, context: SimulationContext): void {
    let changed = this.expire(tick, context);
    if (tick.cadence.day) changed = this.evaluateTriggers(tick, context) || changed;
    if (changed) rebuildModifiers(context);
  }

  private expire(tick: SimulationTick, context: SimulationContext): boolean {
    const before = context.state.activeEvents.length;
    context.state.activeEvents = context.state.activeEvents.filter((active) => {
      if (tick.index < active.endTick) return true;
      context.diagnostic('event.ended', `Event ${active.definitionId} ended`, { tick: tick.index });
      return false;
    });
    return context.state.activeEvents.length !== before;
  }

  private evaluateTriggers(tick: SimulationTick, context: SimulationContext): boolean {
    const stream = context.streams.get('events');
    const scenario = context.scenario;
    const eligibleIds = scenario.eventIds.length > 0
      ? scenario.eventIds
      : [...context.registry.all('events').keys()];

    let started = false;
    // Sorted so the draw order never depends on Map iteration order.
    for (const eventId of [...eligibleIds].sort()) {
      const definition = context.registry.event(eventId, scenario.id);
      if (tick.year < definition.trigger.minimumYear) continue;
      if ((context.state.eventCooldowns[eventId] ?? 0) > tick.index) continue;
      if (context.state.activeEvents.some((a) => a.definitionId === eventId)) continue;
      if (!this.conditionHolds(definition, context)) continue;

      // History does not roll dice. A dated event fires the first day the
      // campaign passes it and then never again; the cooldown set below is
      // what remembers that, so this needs no extra state or migration.
      const scheduled = definition.trigger.scheduledDate;
      if (scheduled !== undefined) {
        if (tick.gameTimeUtc.getTime() < Date.parse(scheduled)) continue;
      } else {
        const hazardScale = definition.trigger.hazardKey
          ? context.region.hazards[definition.trigger.hazardKey]
          : 1;
        const probability = definition.trigger.dailyProbability * hazardScale;
        if (probability <= 0 || !stream.chance(probability)) continue;
      }

      const varianceDays = definition.durationVarianceDays > 0
        ? stream.int(-definition.durationVarianceDays, definition.durationVarianceDays)
        : 0;
      const durationDays = Math.max(1, definition.durationDays + varianceDays);
      const instanceId = `event.${eventId}.${tick.index}`;

      context.state.activeEvents.push({
        instanceId,
        definitionId: eventId,
        startTick: tick.index,
        endTick: tick.index + context.clock.ticksForDays(durationDays),
      });
      // A dated shock happened once, so its cooldown is the rest of time.
      context.state.eventCooldowns[eventId] = scheduled !== undefined
        ? Number.MAX_SAFE_INTEGER
        : tick.index + context.clock.ticksForDays(
          definition.trigger.cooldownDays + durationDays,
        );

      context.state.company.cash += definition.immediateCash;
      context.state.company.communityTrust = clamp(
        context.state.company.communityTrust + definition.immediateTrust, -100, 100);
      context.state.company.reputation = clamp(
        context.state.company.reputation + definition.immediateReputation, 0, 100);
      if (definition.immediateCash !== 0) context.state.hour.otherCost -= definition.immediateCash;

      context.diagnostic('event.started', `${definition.name}: ${definition.description ?? ''}`.trim(), {
        tick: tick.index, eventId, durationDays, mitigation: definition.mitigation,
      });
      started = true;
    }
    return started;
  }

  /** Resolves a trigger condition against the live world snapshot. */
  private conditionHolds(definition: EventDefinition, context: SimulationContext): boolean {
    const condition = definition.trigger.requiresCondition;
    if (!condition) return true;
    const value = this.readMetric(condition.metric, context);
    if (value === null) return false;
    switch (condition.comparison) {
      case 'gt': return value > condition.value;
      case 'gte': return value >= condition.value;
      case 'lt': return value < condition.value;
      case 'lte': return value <= condition.value;
    }
  }

  private readMetric(metric: string, context: SimulationContext): number | null {
    const world = context.state.world;
    switch (metric) {
      case 'weather.dryBulbC': return world.weather.dryBulbC;
      case 'weather.wetBulbC': return world.weather.wetBulbC;
      case 'weather.humidity01': return world.weather.humidity01;
      case 'market.energyPricePerMwh': return world.market.energyPricePerMwh;
      case 'market.gridCarbonKgPerMwh': return world.market.gridCarbonKgPerMwh;
      case 'company.cash': return context.state.company.cash;
      case 'company.reputation': return context.state.company.reputation;
      case 'company.communityTrust': return context.state.company.communityTrust;
      case 'water.withdrawnYearM3': return world.waterWithdrawnYearM3;
      default: return null;
    }
  }
}
