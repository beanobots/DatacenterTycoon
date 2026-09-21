/**
 * Pipeline step 4: allocate workloads to compatible hardware.
 *
 * Capacity is built per rack group and offered to each contract in priority
 * order: the tightest SLA is served first, because that is the capacity the
 * penalties are written against. Within a contract, hardware is chosen by
 * affinity, so accelerators serve AI work before they serve streaming and a
 * tape library never serves finance at all.
 *
 * Throttling from the previous tick's thermal state is applied here. See the
 * note on TickScratch for why that lag exists.
 *
 * This step is also the only place that can say WHY a contract went unserved,
 * because it is the only place that sees the difference between the capacity
 * the fleet is rated for and the capacity it actually delivered. That
 * difference is attributed to a cause here and carried to the SLA step, which
 * otherwise reports a breach it cannot explain.
 */

import type { SimulationTick } from '../../core/clock.js';
import { clamp01 } from '../../core/math.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';
import type { HallState, RackGroupState, ShortfallCause } from '../../state/types.js';

interface CapacitySlot {
  readonly groupId: string;
  readonly hall: HallState;
  readonly group: RackGroupState;
  readonly hardwareId: string;
  /** Compute units this group can deliver this tick, after throttle and failures. */
  remaining: number;
  readonly capacity: number;
  /** What this group would deliver with every rack working, healthy and cool. */
  readonly nominal: number;
  /** Capacity lost to racks out of service awaiting repair. */
  readonly lostToFailures: number;
  /** Capacity lost to racks running below rating because they are worn. */
  readonly lostToDegradation: number;
  /** Capacity lost to thermal throttling shedding load. */
  readonly lostToThrottle: number;
  /** Units reserved on this group that are actually running work. */
  activeUnits: number;
}

export class AllocationSystem implements ISimulationSystem {
  readonly name = 'allocation';
  readonly order = 40;

  tick(tick: SimulationTick, context: SimulationContext): void {
    const slots = this.buildCapacity(context);

    // Serve the strictest availability commitment first.
    const ordered = [...context.state.contracts]
      .filter((c) => (context.scratch.demandByContract.get(c.instanceId) ?? 0) > 0)
      .sort((a, b) => {
        const defA = context.registry.contract(a.definitionId, a.instanceId);
        const defB = context.registry.contract(b.definitionId, b.instanceId);
        return defB.slaUptime01 - defA.slaUptime01 || a.instanceId.localeCompare(b.instanceId);
      });

    for (const contract of ordered) {
      const demand = context.scratch.demandByContract.get(contract.instanceId) ?? 0;
      const definition = context.registry.contract(contract.definitionId, contract.instanceId);
      const workload = context.registry.workload(definition.workloadId, definition.id);

      // Every slot this workload could run on, whether or not anything is left
      // on it. A hall throttled to a standstill still counts as compatible
      // hardware - reporting it as "nothing can run this" would send the player
      // shopping when the fix is cooling.
      const compatible = slots
        .map((slot) => {
          const hardware = context.registry.hardware(slot.hardwareId, slot.groupId);
          const affinity = workload.compatibleFamilies.includes(hardware.family)
            ? hardware.workloadAffinity[workload.id] ?? 0
            : 0;
          return { slot, affinity };
        })
        .filter((entry) => entry.affinity > 0);

      const eligible = compatible
        .filter((entry) => entry.slot.remaining > 0)
        // Best fit first; ties broken by ID so allocation is deterministic.
        .sort((a, b) => b.affinity - a.affinity || a.slot.groupId.localeCompare(b.slot.groupId));

      let outstanding = demand;
      let served = 0;
      for (const { slot, affinity } of eligible) {
        if (outstanding <= 0) break;
        // Affinity scales what a rack delivers for THIS workload: an ASIC gives
        // more AI throughput per rack and far less general-purpose throughput.
        const effectiveCapacity = slot.remaining * affinity;
        const take = Math.min(outstanding, effectiveCapacity);
        const racksConsumed = take / affinity;
        slot.remaining -= racksConsumed;
        slot.activeUnits += racksConsumed * workload.meanUtilization01;
        outstanding -= take;
        served += take;
      }
      context.scratch.servedByContract.set(contract.instanceId, served);

      if (outstanding > 1e-9) {
        this.attributeShortfall(contract.shortfall, compatible, outstanding, tick.hours);
      }
    }

    for (const slot of slots) {
      const reserved = slot.capacity > 0 ? clamp01((slot.capacity - slot.remaining) / slot.capacity) : 0;
      const active = slot.capacity > 0 ? clamp01(slot.activeUnits / slot.capacity) : 0;
      context.scratch.utilizationByGroup.set(slot.groupId, reserved);
      context.scratch.activeUtilizationByGroup.set(slot.groupId, active);
    }
  }

  /**
   * Books unserved compute-unit-hours against the reason the capacity was not
   * there.
   *
   * The rule is counterfactual: of the units this contract did not get, the
   * share a healthy, cool, fully working fleet would have covered is charged to
   * whichever of those three took it away, in proportion. Whatever is left over
   * is capacity the operator never had - it was sold to someone else, or never
   * built. That is the honest split, because restoring health is exactly what
   * would have closed that part of the gap and nothing else would.
   */
  private attributeShortfall(
    record: Record<ShortfallCause, number>,
    compatible: ReadonlyArray<{ slot: CapacitySlot; affinity: number }>,
    unservedUnits: number,
    hours: number,
  ): void {
    let nominal = 0;
    let failures = 0;
    let degradation = 0;
    let throttle = 0;
    for (const { slot, affinity } of compatible) {
      nominal += slot.nominal * affinity;
      failures += slot.lostToFailures * affinity;
      degradation += slot.lostToDegradation * affinity;
      throttle += slot.lostToThrottle * affinity;
    }

    if (nominal <= 0) {
      record.noCompatibleHardware += unservedUnits * hours;
      return;
    }

    const recoverable = failures + degradation + throttle;
    if (recoverable <= 0) {
      record.oversold += unservedUnits * hours;
      return;
    }

    // Everything here is compute units per tick until the last step, where the
    // whole split is converted to the unit-hours the SLA period is measured in.
    const explained = Math.min(unservedUnits, recoverable);
    record.failedRacks += explained * (failures / recoverable) * hours;
    record.degraded += explained * (degradation / recoverable) * hours;
    record.throttled += explained * (throttle / recoverable) * hours;
    record.oversold += (unservedUnits - explained) * hours;
  }

  /** Compute units each rack group can deliver this tick. */
  private buildCapacity(context: SimulationContext): CapacitySlot[] {
    const slots: CapacitySlot[] = [];
    const balance = context.balance;
    const computeModifier = context.modifiers.value('hardware.computePerRack', 1);

    for (const facility of context.state.facilities) {
      for (const hall of facility.halls) {
        if (hall.constructionProgress01 < 1) continue;
        const available = 1 - clamp01(hall.throttle01);
        for (const group of hall.rackGroups) {
          const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
          const workingRacks = Math.max(0, group.count - group.failedCount);
          const perRack = balance.baseRackComputeUnits * hardware.computeFactor * computeModifier;
          const nominal = group.count * perRack;
          const afterFailures = workingRacks * perRack;
          // A degraded rack still runs, just not at full throughput.
          const afterDegradation = afterFailures * (0.6 + 0.4 * clamp01(group.condition01));
          const capacity = afterDegradation * available;
          // Kept even at zero capacity: a slot that exists but delivers nothing
          // is the difference between "buy different hardware" and "fix what
          // you own", and the shortfall attribution needs to tell them apart.
          if (nominal <= 0) continue;
          slots.push({
            groupId: group.instanceId, hall, group, hardwareId: group.hardwareId,
            remaining: capacity, capacity, activeUnits: 0,
            nominal,
            lostToFailures: nominal - afterFailures,
            lostToDegradation: afterFailures - afterDegradation,
            lostToThrottle: afterDegradation - capacity,
          });
        }
      }
    }
    return slots;
  }
}
