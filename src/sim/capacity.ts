/**
 * What the fleet can still take on, computed the way allocation actually
 * allocates.
 *
 * The fit advice on a contract offer used to be built from two numbers that
 * did not describe the same thing: every rack compatible with the workload,
 * minus the contracts already signed FOR THAT WORKLOAD. A CPU rack serves
 * archive, disaster recovery, finance, government, streaming and batch
 * science, so capacity sold to one of them was reported as free to all the
 * others. An operator could sell the same rack six times and be told each time
 * that it fitted.
 *
 * The second omission was the daily curve. Demand is the contracted units
 * shaped by the workload's own hourly profile, which peaks at up to 1.45x the
 * mean. A contract sized to the fleet's average capacity breaches every
 * evening. Capacity has to be judged against the peak hour, because that is
 * the hour the SLA is measured in.
 *
 * So this module builds the same capacity slots the allocation step builds,
 * runs the same priority allocation against every contract already signed at
 * ITS peak hour, and reports what is left. One pass serves every workload,
 * because the existing book is allocated identically whatever is being
 * considered next.
 */

import { clamp, clamp01, inverseNormal } from '../core/math.js';
import type { SimulationContext } from './context.js';
import { ARRIVAL_SIGMA } from './systems/workload.js';
import { groupRackOutput } from './era.js';

/**
 * Spare capacity a contract needs to hold its availability, as a multiplier on
 * its peak-hour demand.
 *
 * Arrivals are the contracted units times the daily shape times lognormal
 * noise. To serve a share `sla` of unit-hours, capacity has to cover the
 * `sla`-th percentile of that noise, which is exp(z(sla) * sigma). This is not
 * a tunable margin: it falls straight out of the distribution the arrivals are
 * drawn from, and it is why a flat margin could not work. A 95% contract needs
 * 16% spare; a 99.9% contract needs 32%, and selling it at a flat 85% of
 * capacity breached every month.
 */
export function requiredHeadroom(sla01: number): number {
  const target = clamp(sla01, 0.5, 0.99999);
  return Math.exp(inverseNormal(target) * ARRIVAL_SIGMA);
}

/**
 * The availability assumed when a figure is reported for a workload rather
 * than for a specific offer, such as the planning headroom table. Contracts
 * range from 98% to 99.99%, so this is deliberately near the strict end: it is
 * better for the headline number to under-promise than for a player to size
 * against it and breach.
 */
export const REPORTING_SLA = 0.995;

export interface WorkloadCapacity {
  /** Effective units at the peak hour if nothing at all were sold. */
  readonly totalUnits: number;
  /** Effective units still unallocated at the peak hour. */
  readonly freeUnits: number;
  /**
   * Contracted compute units that would still fit at REPORTING_SLA. Compare an
   * actual offer against `fittingUnits(offer's SLA)` instead: what fits depends
   * on the availability being bought.
   */
  readonly freeContractUnits: number;
  /** Contracted units already claimed on racks this workload could have used. */
  readonly claimedContractUnits: number;
  /** The workload's peak multiplier against its mean. */
  readonly peakShape: number;
  /** Contracted units that still fit while holding a given availability. */
  fittingUnits(sla01: number): number;
}

interface Slot {
  readonly groupId: string;
  readonly hardwareId: string;
  readonly capacity: number;
  remaining: number;
}

/** A rack group offered to the probe, with the compute it can actually deliver. */
export interface CapacityGroup {
  readonly groupId: string;
  readonly hardwareId: string;
  /** Compute units per tick, already derated for failures, wear and throttle. */
  readonly units: number;
}

/** A contract the probe should place before reporting what is left. */
export interface BookedDemand {
  readonly workloadId: string;
  readonly contractedUnits: number;
  readonly sla01: number;
  /** Tie-break, so a given fleet and book always allocate the same way. */
  readonly id: string;
}

export interface CapacityProbe {
  /** What a workload can still be sold, after everything already on the book. */
  forWorkload(workloadId: string): WorkloadCapacity;
}

/** The highest point of a workload's daily curve, which is what must be served. */
export function peakShape(shape: readonly number[]): number {
  let peak = 0;
  for (const value of shape) peak = Math.max(peak, value);
  return peak > 0 ? peak : 1;
}

/**
 * Allocates the current book against the current fleet once, then answers for
 * any workload.
 *
 * Capacity is measured as allocation measures it, throttling and failures
 * included: a hall shedding load right now genuinely cannot carry what its
 * nameplate says, and advice that ignores that is the advice that produced
 * "it fits" followed by a breach.
 */
export function probeCapacity(context: SimulationContext): CapacityProbe {
  return probeFleet(context, liveGroups(context), liveBook(context));
}

/**
 * The fleet as it stands, derated as the allocation step derates it - except
 * that a hall is judged on the worst throttling it has reached recently rather
 * than on this instant.
 *
 * Contracts run for years. Capacity that exists in February and not in August
 * is not capacity you can sell against a yearly availability commitment, and
 * advising on today's reading is what produced "it fits" in winter followed by
 * breaches all summer.
 */
export function liveGroups(context: SimulationContext): CapacityGroup[] {
  const groups: CapacityGroup[] = [];

  for (const facility of context.state.facilities) {
    for (const hall of facility.halls) {
      if (hall.constructionProgress01 < 1) continue;
      // What the hall is doing now, or the worst it has done lately - whichever
      // is worse. Deliberately NOT the design-day figure: that is the shed on
      // the hottest afternoon of the year, and derating a whole year by its
      // worst hour makes every offer impossible rather than merely cautious.
      // Summer risk is reported against the offer instead, where the player can
      // weigh it, rather than hidden inside a number that silently refuses.
      const available = 1 - clamp01(Math.max(hall.throttle01, hall.peakThrottle01 ?? 0));
      for (const group of hall.rackGroups) {
        const working = Math.max(0, group.count - group.failedCount);
        const units = working
          * groupRackOutput(context, group).computeUnits
          * (0.6 + 0.4 * clamp01(group.condition01))
          * available;
        if (units <= 0) continue;
        groups.push({ groupId: group.instanceId, hardwareId: group.hardwareId, units });
      }
    }
  }
  return groups;
}

/** Everything currently sold, in the form the probe places it. */
export function liveBook(context: SimulationContext): BookedDemand[] {
  return context.state.contracts.map((contract) => {
    const definition = context.registry.contract(contract.definitionId, contract.instanceId);
    return {
      workloadId: definition.workloadId,
      contractedUnits: contract.computeUnits,
      sla01: definition.slaUptime01,
      id: contract.instanceId,
    };
  });
}

/**
 * Places a book on a fleet and reports what each workload has left.
 *
 * Taking the fleet and the book as arguments is what lets the forecast use it:
 * a projection six months out is the same question asked of a different fleet,
 * and answering it any other way is how the forecast and the outcome drift.
 */
export function probeFleet(
  context: SimulationContext, groups: readonly CapacityGroup[], book: readonly BookedDemand[],
): CapacityProbe {
  const slots: Slot[] = groups.map((group) => ({
    groupId: group.groupId, hardwareId: group.hardwareId,
    capacity: group.units, remaining: group.units,
  }));

  // Existing contracts take their capacity first, strictest SLA first - the
  // same order the allocation step serves them in.
  const ordered = [...book].sort((a, b) => b.sla01 - a.sla01 || a.id.localeCompare(b.id));
  for (const entry of ordered) {
    const workload = context.registry.workload(entry.workloadId, 'capacity-probe');
    // Booked demand is placed at its own peak and with the headroom its
    // availability needs, because that is the moment it has to be served.
    const demand = entry.contractedUnits
      * peakShape(workload.hourlyDemandShape)
      * requiredHeadroom(entry.sla01);
    consume(context, slots, workload.id, workload.compatibleFamilies, demand);
  }

  return {
    forWorkload(workloadId: string): WorkloadCapacity {
      const workload = context.registry.workload(workloadId, 'capacity-probe');
      const peak = peakShape(workload.hourlyDemandShape);
      let total = 0;
      let free = 0;
      for (const slot of slots) {
        const affinity = affinityOf(context, slot, workload.id, workload.compatibleFamilies);
        if (affinity <= 0) continue;
        total += slot.capacity * affinity;
        free += slot.remaining * affinity;
      }
      // Effective units at the peak hour convert back to a contract size by
      // dividing out the peak and the headroom the availability needs: a
      // streaming contract of 1,000 units needs 1,450 units of capacity at
      // 19:00, and more again to absorb the noise around that.
      const fittingUnits = (sla01: number): number =>
        Math.max(0, free / (peak * requiredHeadroom(sla01)));

      return {
        totalUnits: total,
        freeUnits: free,
        freeContractUnits: fittingUnits(REPORTING_SLA),
        claimedContractUnits: Math.max(0, (total - free) / peak),
        peakShape: peak,
        fittingUnits,
      };
    },
  };
}

function affinityOf(
  context: SimulationContext, slot: Slot, workloadId: string,
  families: readonly string[],
): number {
  const hardware = context.registry.hardware(slot.hardwareId, slot.groupId);
  if (!families.includes(hardware.family)) return 0;
  return hardware.workloadAffinity[workloadId] ?? 0;
}

/** Takes capacity off the slots the way the allocation step takes it. */
function consume(
  context: SimulationContext, slots: Slot[], workloadId: string,
  families: readonly string[], demand: number,
): void {
  const eligible = slots
    .map((slot) => ({ slot, affinity: affinityOf(context, slot, workloadId, families) }))
    .filter((entry) => entry.affinity > 0 && entry.slot.remaining > 0)
    .sort((a, b) => b.affinity - a.affinity || a.slot.groupId.localeCompare(b.slot.groupId));

  let outstanding = demand;
  for (const { slot, affinity } of eligible) {
    if (outstanding <= 0) break;
    const take = Math.min(outstanding, slot.remaining * affinity);
    slot.remaining -= take / affinity;
    outstanding -= take;
  }
}

