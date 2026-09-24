/**
 * Research: fund projects daily and complete them.
 *
 * Projects are paid for in cash, drawn a day at a time over their duration,
 * rather than from a separate points currency. That puts R&D in direct
 * competition with racks, plant and debt service for the same money, which is
 * the trade-off the design pillar asks for: a technology that improves two
 * outcomes has to be paid for out of something else.
 *
 * Several projects may run at once. What limits them is specialists - staff who
 * cannot be in two places - and the cash to keep them all funded. A project
 * that cannot be funded this month stalls rather than failing: it holds its
 * specialists and resumes when there is money.
 */

import type { SimulationTick } from '../../core/clock.js';
import { clamp01 } from '../../core/math.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';
import { rebuildModifiers } from '../context.js';
import { eraFactors } from '../era.js';
import type { TechnologyDefinition } from '../../definitions/types.js';

export class ResearchSystem implements ISimulationSystem {
  readonly name = 'research';
  readonly order = 115;

  tick(tick: SimulationTick, context: SimulationContext): void {
    if (!tick.cadence.day) return;
    const state = context.state;
    if (state.research.active.length === 0) return;

    const speed = Math.max(0.1, context.modifiers.value('research.speed', 1));
    const completed: string[] = [];

    for (const project of state.research.active) {
      const technology = context.registry.technology(project.technologyId, 'research');
      const days = Math.max(1, technology.research.durationDays / speed);
      const dailyCost = project.budgetUsd / days;
      const outstanding = project.budgetUsd - project.fundedUsd;
      if (outstanding <= 0) {
        completed.push(project.technologyId);
        continue;
      }

      // Fund what the balance allows. A stalled project keeps its specialists
      // and its progress; it simply does not advance today.
      const spend = Math.min(dailyCost, outstanding, Math.max(0, state.company.cash));
      if (spend <= 0) continue;

      state.company.cash -= spend;
      state.hour.otherCost += spend;
      project.fundedUsd += spend;

      if (project.fundedUsd >= project.budgetUsd - 1e-6) {
        completed.push(project.technologyId);
      }
    }

    if (completed.length === 0) return;
    state.research.active = state.research.active
      .filter((project) => !completed.includes(project.technologyId));
    for (const technologyId of completed) this.complete(context, tick, technologyId);
    rebuildModifiers(context);
  }

  private complete(context: SimulationContext, tick: SimulationTick, technologyId: string): void {
    const state = context.state;
    const technology = context.registry.technology(technologyId, 'research');
    if (state.research.completed.includes(technologyId)) return;
    state.research.completed.push(technologyId);

    for (const id of technology.unlocks.cooling ?? []) {
      if (!state.research.unlockedCooling.includes(id)) state.research.unlockedCooling.push(id);
    }
    for (const id of technology.unlocks.power ?? []) {
      if (!state.research.unlockedPower.includes(id)) state.research.unlockedPower.push(id);
    }
    for (const id of technology.unlocks.hardware ?? []) {
      if (!state.research.unlockedHardware.includes(id)) state.research.unlockedHardware.push(id);
    }
    for (const id of technology.unlocks.contracts ?? []) {
      if (!state.research.unlockedContracts.includes(id)) state.research.unlockedContracts.push(id);
    }
    for (const capability of technology.unlocks.capabilities ?? []) {
      if (!state.research.capabilities.includes(capability)) state.research.capabilities.push(capability);
    }

    context.diagnostic('research.completed', `Researched ${technology.name}`, {
      tick: tick.index, technologyId: technology.id, tier: technology.tier,
      costUsd: technology.research.costUsd, tradeOff: technology.tradeOff,
    });
  }
}

/** Specialists the operator employs, from its staff. */
export function totalSpecialists(context: SimulationContext): number {
  return Math.floor(context.state.company.staffCount * context.balance.researchStaffShare01);
}

/** Specialists already occupied by projects under way. */
export function committedSpecialists(context: SimulationContext): number {
  return context.state.research.active.reduce((total, project) => total + project.specialists, 0);
}

export function freeSpecialists(context: SimulationContext): number {
  return Math.max(0, totalSpecialists(context) - committedSpecialists(context));
}

/** Why a technology cannot be started, or null when it can. */
/**
 * What a project costs in the year it is run.
 *
 * Technology costs are written in 2025 dollars like everything else in the
 * balance profile; a 2006 operator pays 2006 prices for the same engineers.
 */
export function researchCostUsd(context: SimulationContext, technology: TechnologyDefinition): number {
  return technology.research.costUsd * eraFactors(context).costIndex;
}

export function researchBlocker(context: SimulationContext, technologyId: string): string | null {
  const state = context.state;
  if (state.research.completed.includes(technologyId)) return 'Already researched.';
  if (state.research.active.some((project) => project.technologyId === technologyId)) {
    return 'Already under way.';
  }
  const technology = context.registry.all('technologies').get(technologyId);
  if (!technology) return 'Unknown technology.';

  // A campaign that opens in 2006 cannot research immersion cooling, because
  // nobody could. This is checked before prerequisites so the player is told
  // the real reason - waiting for the decade - rather than being sent to
  // research a chain that is itself unavailable.
  if (technology.availableFromYear > state.meta.campaignYear) {
    return `Not invented yet. ${technology.name} arrives in `
      + `${technology.availableFromYear}; it is ${state.meta.campaignYear}.`;
  }

  const missing = technology.prerequisites
    .filter((id) => !state.research.completed.includes(id))
    .map((id) => context.registry.technology(id, technologyId).name);
  if (missing.length > 0) return `Requires ${missing.join(', ')}.`;

  if (technology.research.minimumCompanyLevel > state.company.companyLevel) {
    return `Needs company level ${technology.research.minimumCompanyLevel}; you are at `
      + `${state.company.companyLevel}. Level rises with installed capacity and standing.`;
  }

  const free = freeSpecialists(context);
  if (technology.research.requiredSpecialists > free) {
    return `Needs ${technology.research.requiredSpecialists} specialists; `
      + `${free} of ${totalSpecialists(context)} are free. More staff come with more racks.`;
  }
  return null;
}

/** True when every prerequisite and staffing condition is met. */
export function canStartResearch(context: SimulationContext, technologyId: string): boolean {
  return researchBlocker(context, technologyId) === null;
}

/** Starts a project. Returns false when it cannot be started. */
export function startResearch(context: SimulationContext, technologyId: string): boolean {
  if (!canStartResearch(context, technologyId)) return false;
  const technology = context.registry.technology(technologyId, 'research');
  const budgetUsd = researchCostUsd(context, technology);
  context.state.research.active.push({
    technologyId,
    budgetUsd,
    fundedUsd: 0,
    specialists: technology.research.requiredSpecialists,
    startedTick: context.state.meta.tickIndex,
  });
  context.diagnostic('research.started', `Started ${technology.name}`, {
    tick: context.state.meta.tickIndex,
    technologyId,
    costUsd: Math.round(budgetUsd),
    specialists: technology.research.requiredSpecialists,
  });
  return true;
}

/** 0-1 funding progress of a project. */
export function researchProgress(context: SimulationContext, technologyId: string): number {
  const project = context.state.research.active
    .find((candidate) => candidate.technologyId === technologyId);
  if (!project) return 0;
  const technology = context.registry.technology(technologyId, 'research');
  return clamp01(project.fundedUsd / Math.max(1, project.budgetUsd));
}
