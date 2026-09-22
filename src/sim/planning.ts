/**
 * Forward planning.
 *
 * Two questions the player has to answer constantly and the simulation makes
 * them derive by hand: how much work can this fleet actually take on, and what
 * will it look like in six months when the hall under construction lands and
 * the first CPU cohort ages out.
 *
 * Both are computable from committed state - construction progress, lead times,
 * hardware ages, contract terms - without simulating anything. This projects
 * them with the same constants the systems advance by, so the forecast and the
 * outcome cannot drift apart.
 *
 * It deliberately assumes the player does NOTHING more: no new orders, no
 * renewals. That is what makes it a baseline to plan against rather than a
 * prediction that flatters whatever is already planned.
 */

import type { SimulationContext } from './context.js';
import { HALL_BUILD_WEEKS } from './systems/construction.js';
import { probeCapacity, probeFleet, type BookedDemand } from './capacity.js';
import { currentRackOutput, groupRackOutput } from './era.js';
import { RETIREMENT_SHARE_PER_MONTH } from './operator.js';
import type { HallState, RackGroupState } from '../state/types.js';

/** Worst-case wait for the first Monday after work starts. */
const WEEK_ALIGNMENT_SLACK_DAYS = 6;
const HOURS_PER_YEAR = 8766;

export interface WorkloadHeadroom {
  readonly workloadId: string;
  readonly name: string;
  /** Compute units the installed fleet can deliver for this workload. */
  readonly servableUnits: number;
  /** Units already sold against it. */
  readonly reservedUnits: number;
  /** Units still safely sellable, at the commit margin. */
  readonly freeUnits: number;
  /** 0-1 share of servable capacity already committed. */
  readonly utilisation01: number;
  /** Racks that can serve this workload at all. */
  readonly capableRacks: number;
  /** Hardware serving it best, for a procurement hint. */
  readonly bestHardware: string | null;
  /** Compute units one more rack of that hardware would add. */
  readonly unitsPerAddedRack: number;
  /**
   * When nothing unlocked can serve this workload, the technology that would
   * change that. "Servable: 0" is a dead end; "research GPU Clusters" is a plan.
   */
  readonly unlockedBy: string | null;
}

export interface ProjectedWorkload {
  readonly workloadId: string;
  readonly name: string;
  readonly servableUnits: number;
  readonly reservedUnits: number;
  readonly freeUnits: number;
}

export interface ProjectedMonth {
  readonly monthsAhead: number;
  readonly dateIso: string;
  readonly label: string;
  readonly itCapacityMw: number;
  readonly rackCount: number;
  /** Rack slots in commissioned halls. */
  readonly rackSlots: number;
  /**
   * Headroom per workload.
   *
   * Never summed into one figure: the same rack appears in the servable
   * capacity of every workload it can serve, so a total would count it several
   * times and promise capacity that does not exist.
   */
  readonly perWorkload: readonly ProjectedWorkload[];
  /** What lands or lapses this month. */
  readonly events: readonly string[];
}

export type ScheduleKind = 'hall' | 'power' | 'contract' | 'retirement';

export interface ScheduleEntry {
  readonly kind: ScheduleKind;
  readonly monthsAhead: number;
  readonly label: string;
  readonly detail: string;
}


/** Racks in commissioned halls, flattened. */
function installedGroups(context: SimulationContext): RackGroupState[] {
  const groups: RackGroupState[] = [];
  for (const facility of context.state.facilities) {
    for (const hall of facility.halls) {
      if (hall.constructionProgress01 < 1) continue;
      for (const group of hall.rackGroups) groups.push(group);
    }
  }
  return groups;
}

/**
 * How much more work the fleet can take on, workload by workload.
 *
 * Reported per workload rather than as one number because capacity is not
 * fungible: a hall full of accelerators has enormous headroom for inference and
 * almost none for archive, and a single total would say neither.
 */
export function workloadHeadroom(context: SimulationContext): WorkloadHeadroom[] {
  const groups = installedGroups(context);
  const probe = probeCapacity(context);
  const rows: WorkloadHeadroom[] = [];

  for (const workload of context.registry.all('workloads').values()) {
    if (workload.availableFromYear > context.state.meta.campaignYear) continue;

    // Capacity is shared: a CPU rack serves six workloads, so what is free for
    // this one depends on everything already sold, not only on contracts for
    // this workload. The probe answers that the way allocation would.
    const capacity = probe.forWorkload(workload.id);
    const servable = capacity.totalUnits;
    const reserved = capacity.claimedContractUnits;

    let capableRacks = 0;
    for (const group of groups) {
      const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
      if (workload.compatibleFamilies.includes(hardware.family)
        && (hardware.workloadAffinity[workload.id] ?? 0) > 0) capableRacks += group.count;
    }

    // The best rack the operator could buy today for this workload, so the
    // headroom figure comes with a way to raise it.
    let bestHardware: string | null = null;
    let unitsPerAddedRack = 0;
    const unlocked = ['hardware.cpu.gen1', ...context.state.research.unlockedHardware];
    for (const hardwareId of [...new Set(unlocked)]) {
      const hardware = context.registry.hardware(hardwareId, 'planning');
      if (!workload.compatibleFamilies.includes(hardware.family)) continue;
      const units = currentRackOutput(context, hardware).computeUnits
        * (hardware.workloadAffinity[workload.id] ?? 0);
      if (units > unitsPerAddedRack) {
        unitsPerAddedRack = units;
        bestHardware = hardware.name;
      }
    }

    rows.push({
      workloadId: workload.id,
      name: workload.name,
      unlockedBy: unitsPerAddedRack > 0 ? null : unlockingTechnology(context, workload.id),
      servableUnits: servable,
      reservedUnits: reserved,
      freeUnits: capacity.freeContractUnits,
      utilisation01: servable > 0 ? reserved / servable : 0,
      capableRacks,
      bestHardware,
      unitsPerAddedRack,
    });
  }

  return rows.sort((a, b) => b.servableUnits - a.servableUnits || a.name.localeCompare(b.name));
}

/**
 * The cheapest reachable technology that unlocks hardware able to serve a
 * workload, or null when the operator can already serve it.
 */
function unlockingTechnology(context: SimulationContext, workloadId: string): string | null {
  const workload = context.registry.workload(workloadId, 'planning');
  let best: { name: string; costUsd: number } | null = null;

  for (const technology of context.registry.all('technologies').values()) {
    if (context.state.research.completed.includes(technology.id)) continue;
    for (const hardwareId of technology.unlocks.hardware ?? []) {
      const hardware = context.registry.all('hardware').get(hardwareId);
      if (!hardware) continue;
      if (!workload.compatibleFamilies.includes(hardware.family)) continue;
      if ((hardware.workloadAffinity[workloadId] ?? 0) <= 0) continue;
      if (!best || technology.research.costUsd < best.costUsd) {
        best = { name: technology.name, costUsd: technology.research.costUsd };
      }
    }
  }
  return best ? best.name : null;
}

/**
 * Months for `weeks` of construction work to finish.
 *
 * Construction advances on week boundaries, which fall on Mondays, so a project
 * started mid-week waits up to six days for its first tick of progress.
 * Ignoring that alignment puts every commissioning date a month early, which is
 * the one direction a schedule must not be wrong in.
 */
function monthsForWeeks(weeks: number): number {
  return Math.max(1, Math.ceil((weeks * 7 + WEEK_ALIGNMENT_SLACK_DAYS) / 30.44));
}

/** Months until a hall under construction is commissioned. */
function monthsToHall(context: SimulationContext, hall: HallState): number {
  if (hall.constructionProgress01 >= 1) return 0;
  const speed = Math.max(0.01, context.modifiers.value('facility.constructionSpeed', 1));
  return monthsForWeeks((1 - hall.constructionProgress01) * HALL_BUILD_WEEKS / speed);
}

/** Months until a power asset under construction is commissioned. */
function monthsToPower(context: SimulationContext, definitionId: string, progress01: number): number {
  if (progress01 >= 1) return 0;
  const definition = context.registry.power(definitionId, 'planning');
  const speed = Math.max(0.01, context.modifiers.value('facility.constructionSpeed', 1));
  const totalWeeks = Math.max(1, definition.leadTimeDays / 7);
  return monthsForWeeks((1 - progress01) * totalWeeks / speed);
}

/**
 * Capacity month by month if nothing further is ordered.
 *
 * Halls under construction add SLOTS, not capacity: a commissioned hall with no
 * racks in it serves nothing. Keeping the two apart is the whole point - an
 * operator who reads a hall's completion as capacity arriving will sell against
 * it and breach.
 */
export function projectCapacity(context: SimulationContext, horizonMonths: number): ProjectedMonth[] {
  const ticksPerMonth = context.clock.ticksForDays(30.44);
  const ticksPerYear = context.clock.ticksForDays(365.25);
  const nowTick = context.state.meta.tickIndex;
  const startDate = new Date(context.state.meta.gameTimeIso);

  // Work on copies: projecting must not age the real fleet.
  const groups = installedGroups(context).map((group) => ({
    instanceId: group.instanceId,
    hardwareId: group.hardwareId,
    count: group.count,
    installedTick: group.installedTick,
  }));

  const pendingHalls = context.state.facilities.flatMap((facility) => facility.halls)
    .filter((hall) => hall.constructionProgress01 < 1)
    .map((hall) => ({ hall, months: monthsToHall(context, hall) }));

  const pendingPower = context.state.facilities.flatMap((facility) => facility.powerAssets)
    .filter((asset) => asset.constructionProgress01 < 1)
    .map((asset) => ({
      asset,
      months: monthsToPower(context, asset.definitionId, asset.constructionProgress01),
    }));

  let rackSlots = context.state.facilities.flatMap((facility) => facility.halls)
    .filter((hall) => hall.constructionProgress01 >= 1)
    .reduce((total, hall) => total + hall.rackCapacity, 0);

  const months: ProjectedMonth[] = [];

  for (let m = 0; m <= horizonMonths; m += 1) {
    const tick = nowTick + m * ticksPerMonth;
    const events: string[] = [];

    if (m > 0) {
      // Retirement, on the same rule the operator applies each month.
      for (const group of groups) {
        if (group.count <= 0) continue;
        const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
        const ageYears = (tick - group.installedTick) / ticksPerYear;
        if (ageYears < hardware.lifeYears) continue;
        const retiring = Math.min(group.count, Math.max(1, Math.ceil(group.count * RETIREMENT_SHARE_PER_MONTH)));
        group.count -= retiring;
        events.push(`${retiring} ${hardware.name} rack${retiring > 1 ? 's' : ''} retire`);
      }

      for (const pending of pendingHalls) {
        if (pending.months !== m) continue;
        rackSlots += pending.hall.rackCapacity;
        const cooling = context.registry.cooling(pending.hall.coolingId, pending.hall.instanceId);
        events.push(`Hall commissions: ${pending.hall.rackCapacity} slots, ${cooling.name}`);
      }

      for (const pending of pendingPower) {
        if (pending.months !== m) continue;
        const definition = context.registry.power(pending.asset.definitionId, pending.asset.instanceId);
        events.push(`${pending.asset.capacityMw.toFixed(1)} MW ${definition.name} commissions`);
      }
    }

    // Contracts still running at this point, on their contracted terms.
    const book: BookedDemand[] = [];
    for (const contract of context.state.contracts) {
      const definition = context.registry.contract(contract.definitionId, contract.instanceId);
      if (contract.endTick < tick) {
        if (m > 0 && contract.endTick >= tick - ticksPerMonth) {
          events.push(`${definition.name} reaches term`);
        }
        continue;
      }
      book.push({
        workloadId: definition.workloadId,
        contractedUnits: contract.computeUnits,
        sla01: definition.slaUptime01,
        id: contract.instanceId,
      });
    }

    const live = groups.filter((group) => group.count > 0);
    const rackCount = live.reduce((total, group) => total + group.count, 0);

    let kw = 0;
    for (const group of live) {
      kw += group.count * groupRackOutput(context, group).powerKw;
    }

    // The forecast places this projected book on this projected fleet with the
    // same allocation the live advice uses, so a month predicted to have room
    // and a month that turns out to have room are the same calculation.
    const probe = probeFleet(context, live.map((group) => {
      return {
        groupId: group.instanceId,
        hardwareId: group.hardwareId,
        units: group.count * groupRackOutput(context, group).computeUnits,
      };
    }), book);

    const perWorkload: ProjectedWorkload[] = [];
    for (const workload of context.registry.all('workloads').values()) {
      if (workload.availableFromYear > context.state.meta.campaignYear) continue;
      const capacity = probe.forWorkload(workload.id);
      if (capacity.totalUnits <= 0 && capacity.claimedContractUnits <= 0) continue;
      perWorkload.push({
        workloadId: workload.id,
        name: workload.name,
        servableUnits: capacity.totalUnits,
        reservedUnits: capacity.claimedContractUnits,
        freeUnits: capacity.freeContractUnits,
      });
    }
    perWorkload.sort((a, b) => b.servableUnits - a.servableUnits);

    const date = new Date(startDate.getTime());
    date.setUTCMonth(date.getUTCMonth() + m);

    months.push({
      monthsAhead: m,
      dateIso: date.toISOString(),
      label: date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
      itCapacityMw: kw / 1000,
      rackCount,
      rackSlots,
      perWorkload,
      events,
    });
  }

  return months;
}

/** Everything already committed that lands, lapses or ages out, in date order. */
export function commissioningSchedule(
  context: SimulationContext,
  horizonMonths: number = Number.POSITIVE_INFINITY,
): ScheduleEntry[] {
  // Unlimited by default. Contract terms run to eight years and hardware lives
  // to twelve; clipping the schedule to a browsing horizon would report
  // "nothing committed" to an operator holding years of contracted revenue.
  // The caller decides what to show, not what exists.
  const horizon = horizonMonths;
  const entries: ScheduleEntry[] = [];
  const ticksPerMonth = context.clock.ticksForDays(30.44);
  const ticksPerYear = context.clock.ticksForDays(365.25);
  const nowTick = context.state.meta.tickIndex;

  for (const facility of context.state.facilities) {
    for (const hall of facility.halls) {
      if (hall.constructionProgress01 >= 1) continue;
      const cooling = context.registry.cooling(hall.coolingId, hall.instanceId);
      entries.push({
        kind: 'hall',
        monthsAhead: monthsToHall(context, hall),
        label: `Hall commissions`,
        detail: `${hall.rackCapacity} rack slots cooled by ${cooling.name}. `
          + 'Slots, not capacity: it serves nothing until racks go in.',
      });
    }
    for (const asset of facility.powerAssets) {
      if (asset.constructionProgress01 >= 1) continue;
      const definition = context.registry.power(asset.definitionId, asset.instanceId);
      entries.push({
        kind: 'power',
        monthsAhead: monthsToPower(context, asset.definitionId, asset.constructionProgress01),
        label: `${asset.capacityMw.toFixed(1)} MW ${definition.name}`,
        detail: definition.clean ? 'Low-carbon supply comes online.' : 'Supply comes online.',
      });
    }
  }

  for (const contract of context.state.contracts) {
    const definition = context.registry.contract(contract.definitionId, contract.instanceId);
    const months = Math.round((contract.endTick - nowTick) / ticksPerMonth);
    if (months > horizon) continue;
    entries.push({
      kind: 'contract',
      monthsAhead: Math.max(0, months),
      label: `${definition.name} reaches term`,
      detail: `${contract.computeUnits.toLocaleString()} units come free. `
        + `Renewal is likely if you have held the SLA (${(definition.renewalProbability01 * 100).toFixed(0)}% base chance).`,
    });
  }

  for (const facility of context.state.facilities) {
    for (const hall of facility.halls) {
      for (const group of hall.rackGroups) {
        const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
        const ageYears = (nowTick - group.installedTick) / ticksPerYear;
        const monthsLeft = Math.round((hardware.lifeYears - ageYears) * 12);
        if (monthsLeft > horizon) continue;
        entries.push({
          kind: 'retirement',
          monthsAhead: Math.max(0, monthsLeft),
          label: `${group.count} ${hardware.name} racks reach end of life`,
          detail: `A quarter of the group retires each month from then. `
            + `Replacing them costs about `
            + `$${Math.round(group.count * context.balance.baseRackPurchaseCost * hardware.purchaseFactor / 1e6)}M.`,
        });
      }
    }
  }

  return entries
    .filter((entry) => entry.monthsAhead <= horizon)
    .sort((a, b) => a.monthsAhead - b.monthsAhead || a.label.localeCompare(b.label));
}

/** Seconds of arithmetic the player would otherwise do: hours in a year. */
export const ANNUAL_HOURS = HOURS_PER_YEAR;
