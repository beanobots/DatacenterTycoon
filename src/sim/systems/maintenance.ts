/**
 * Maintenance: weekly scheduling of repairs against cash and staff capacity.
 *
 * Spec chapter 6 reliability layer: reactive, preventive and predictive
 * maintenance each change cost, downtime, staffing and the failure
 * distribution. Predictive monitoring lowers the hazard directly (its modifier
 * is read by the reliability system); what this system decides is how fast the
 * backlog clears, which is what turns a failure into an outage or a ticket.
 */

import type { SimulationTick } from '../../core/clock.js';
import { clamp01 } from '../../core/math.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';

/** Repairs one technician can complete per week. */
const REPAIRS_PER_STAFF_WEEK = 1.6;
/** Cost of one repair, as a share of the base rack price. */
const REPAIR_COST_SHARE = 0.06;
/** Credit available for essential repairs when the balance is exhausted. */
const ESSENTIAL_REPAIR_CREDIT = 5_000_000;

export class MaintenanceSystem implements ISimulationSystem {
  readonly name = 'maintenance';
  readonly order = 105;

  tick(tick: SimulationTick, context: SimulationContext): void {
    if (!tick.cadence.week) return;

    const company = context.state.company;
    const complexity = context.modifiers.value('facility.maintenanceComplexity', 1);
    // Maintenance is not discretionary. An operator that stops repairing plant
    // because the balance is thin loses condition, then capacity, then the
    // revenue that would have paid for the repairs - an unrecoverable spiral
    // from a temporary cash problem. Essential repairs draw on the revolving
    // facility instead, which the finance system turns into debt and an
    // insolvency flag: expensive and visible, but survivable.
    const essentialCredit = company.cash + ESSENTIAL_REPAIR_CREDIT;
    const costModifier = context.modifiers.value('facility.maintenanceCost', 1);
    const repairCapacity = Math.floor(
      (company.staffCount * REPAIRS_PER_STAFF_WEEK) / Math.max(1, complexity),
    );
    let repairsLeft = Math.max(0, repairCapacity);
    const repairCost = context.balance.baseRackPurchaseCost * REPAIR_COST_SHARE * costModifier * complexity;

    for (const facility of context.state.facilities) {
      // Cooling plant first: a hall without cooling is losing capacity now.
      for (const hall of facility.halls) {
        if (!hall.coolingFailed || repairsLeft <= 0) continue;
        if (essentialCredit < repairCost * 3) break;
        hall.coolingFailed = false;
        hall.condition01 = clamp01(hall.condition01 + 0.10);
        company.cash -= repairCost * 3;
        context.state.hour.maintenanceCost += repairCost * 3;
        facility.maintenanceBacklog = Math.max(0, facility.maintenanceBacklog - 1);
        repairsLeft -= 1;
      }

      for (const asset of facility.powerAssets) {
        if (asset.available || repairsLeft <= 0) continue;
        if (essentialCredit < repairCost * 2) break;
        asset.available = true;
        asset.condition01 = clamp01(asset.condition01 + 0.08);
        company.cash -= repairCost * 2;
        context.state.hour.maintenanceCost += repairCost * 2;
        facility.maintenanceBacklog = Math.max(0, facility.maintenanceBacklog - 1);
        repairsLeft -= 1;
      }

      for (const hall of facility.halls) {
        for (const group of hall.rackGroups) {
          if (group.failedCount <= 0 || repairsLeft <= 0) continue;
          const affordable = Math.floor(essentialCredit / Math.max(1, repairCost));
          const repaired = Math.min(group.failedCount, repairsLeft, Math.max(0, affordable));
          if (repaired <= 0) continue;
          group.failedCount -= repaired;
          group.condition01 = clamp01(group.condition01 + 0.02 * repaired / Math.max(1, group.count));
          company.cash -= repaired * repairCost;
          context.state.hour.maintenanceCost += repaired * repairCost;
          facility.maintenanceBacklog = Math.max(0, facility.maintenanceBacklog - repaired);
          repairsLeft -= repaired;
        }
      }

      // Preventive work with whatever capacity is left restores condition and
      // is what keeps the hazard multipliers near 1.0.
      if (repairsLeft > 0 && company.cash > repairCost * 10) {
        const preventive = Math.min(repairsLeft, 4);
        const spend = preventive * repairCost * 0.5;
        company.cash -= spend;
        context.state.hour.maintenanceCost += spend;
        for (const hall of facility.halls) {
          hall.condition01 = clamp01(hall.condition01 + 0.004 * preventive);
          for (const group of hall.rackGroups) {
            group.condition01 = clamp01(group.condition01 + 0.003 * preventive);
          }
        }
        repairsLeft -= preventive;
      }
    }
  }
}
