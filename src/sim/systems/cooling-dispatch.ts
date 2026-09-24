/**
 * Pipeline step 7: dispatch cooling and evaluate thermal limits.
 *
 * Power dispatch has already run the cooling model, so this system's job is the
 * thermal consequence: where the inlet temperature settles, and how much load
 * has to come off to keep the hall inside its envelope.
 */

import type { SimulationTick } from '../../core/clock.js';
import { clamp, clamp01, lerp, remap } from '../../core/math.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';

/** How fast inlet temperature moves toward its target per tick, 0-1. */
const THERMAL_RESPONSE = 0.55;

/**
 * Per-tick decay on a hall's remembered worst throttle: a one-year half-life
 * at 15 simulated minutes per tick. A year is the right window because that is
 * one full turn of the season that caused it.
 */
const PEAK_THROTTLE_DECAY_PER_TICK = Math.pow(0.5, 1 / (4 * 8766));

export class CoolingDispatchSystem implements ISimulationSystem {
  readonly name = 'cooling-dispatch';
  readonly order = 70;

  tick(tick: SimulationTick, context: SimulationContext): void {
    const balance = context.balance;
    const shortfall = context.scratch.coolingShortfall01;
    const weather = context.state.world.weather;

    for (const facility of context.state.facilities) {
      for (const hall of facility.halls) {
        if (hall.constructionProgress01 < 1) continue;

        // With cooling keeping up the hall sits at its setpoint. As capacity
        // runs out the inlet climbs toward the shutdown limit.
        const targetC = lerp(
          balance.referenceInletTempC + clamp(weather.dryBulbC - 30, 0, 12) * 0.25,
          balance.thermalShutdownC + 4,
          shortfall,
        );
        hall.inletTempC += (targetC - hall.inletTempC) * THERMAL_RESPONSE;

        // Throttling starts at the throttle point and reaches full shed at the
        // shutdown point. It applies to the NEXT tick's allocation.
        const previous = hall.throttle01;
        hall.throttle01 = clamp01(
          remap(hall.inletTempC, balance.thermalThrottleStartC, balance.thermalShutdownC, 0, 1),
        );

        // Decayed rather than reset, so one fixed summer does not immediately
        // make the hall look like it never struggled.
        hall.peakThrottle01 = Math.max(
          hall.throttle01,
          (hall.peakThrottle01 ?? 0) * PEAK_THROTTLE_DECAY_PER_TICK,
        );

        if (hall.throttle01 > 0.05 && previous <= 0.05) {
          context.diagnostic('thermal.throttle_start',
            `Hall ${hall.instanceId} began throttling at ${hall.inletTempC.toFixed(1)}C inlet`,
            {
              tick: tick.index,
              inletC: Number(hall.inletTempC.toFixed(2)),
              ambientC: Number(weather.dryBulbC.toFixed(2)),
              coolingShortfall01: Number(shortfall.toFixed(3)),
            });
        } else if (hall.throttle01 <= 0.05 && previous > 0.05) {
          context.diagnostic('thermal.throttle_end',
            `Hall ${hall.instanceId} returned inside its thermal envelope`,
            { tick: tick.index, inletC: Number(hall.inletTempC.toFixed(2)) });
        }
      }
    }
  }
}
