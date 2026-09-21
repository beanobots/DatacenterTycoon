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
 */

import type { SimulationTick } from '../../core/clock.js';
import { clamp01 } from '../../core/math.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';
import type { HallState, RackGroupState } from '../../state/types.js';

interface CapacitySlot {
  readonly groupId: string;
  readonly hall: HallState;
  readonly group: RackGroupState;
  readonly hardwareId: string;
  /** Compute units this group can deliver this tick, after throttle and failures. */
  remaining: number;
  readonly capacity: number;
  /** Units reserved on this group that are actually running work. */
  activeUnits: number;
}

export class AllocationSystem implements ISimulationSystem {
  readonly name = 'allocation';
  readonly order = 40;

  tick(_tick: SimulationTick, context: SimulationContext): void {
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

      const eligible = slots
        .filter((slot) => {
          const hardware = context.registry.hardware(slot.hardwareId, slot.groupId);
          return workload.compatibleFamilies.includes(hardware.family) && slot.remaining > 0;
        })
        .map((slot) => {
          const hardware = context.registry.hardware(slot.hardwareId, slot.groupId);
          return { slot, affinity: hardware.workloadAffinity[workload.id] ?? 0 };
        })
        .filter((entry) => entry.affinity > 0)
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
    }

    for (const slot of slots) {
      const reserved = slot.capacity > 0 ? clamp01((slot.capacity - slot.remaining) / slot.capacity) : 0;
      const active = slot.capacity > 0 ? clamp01(slot.activeUnits / slot.capacity) : 0;
      context.scratch.utilizationByGroup.set(slot.groupId, reserved);
      context.scratch.activeUtilizationByGroup.set(slot.groupId, active);
    }
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
          const capacity = workingRacks
            * balance.baseRackComputeUnits
            * hardware.computeFactor
            * computeModifier
            // A degraded rack still runs, just not at full throughput.
            * (0.6 + 0.4 * clamp01(group.condition01))
            * available;
          if (capacity <= 0) continue;
          slots.push({
            groupId: group.instanceId, hall, group, hardwareId: group.hardwareId,
            remaining: capacity, capacity, activeUnits: 0,
          });
        }
      }
    }
    return slots;
  }
}
