/**
 * Cross-reference validation.
 *
 * Spec chapter 10 lists the import failures that must block a campaign and the
 * warnings that must be reported. The left column becomes an error here, the
 * right column a warning:
 *
 *   Missing required field          | Suspiciously large cost
 *   Duplicate permanent ID          | Near-zero failure rate
 *   Unknown prerequisite/reference  | Unreachable research content
 *   Technology dependency cycle     | Dominated technology
 *   Unit incompatibility            | Unprofitable contract in every baseline region
 *   Score weights not summing to 1  | Event lacking an apparent mitigation path
 *   Missing asset address           | Content unused by any scenario
 *
 * The first two errors and the missing-field error are caught during import;
 * everything that needs the whole content set is checked here.
 */

import type { ContentRegistry } from './registry.js';
import type { ImportIssue } from './importer.js';
import type { TechnologyDefinition } from '../definitions/types.js';

const WEIGHT_TOLERANCE = 1e-6;
/** Above this, a cost is flagged as suspicious rather than rejected. */
const SUSPICIOUS_COST_FACTOR = 25;
const NEAR_ZERO_FAILURE_RATE = 1e-4;

export interface ValidationReport {
  readonly errors: readonly ImportIssue[];
  readonly warnings: readonly ImportIssue[];
  readonly ok: boolean;
}

export function validateContent(registry: ContentRegistry, existing: {
  errors: readonly ImportIssue[];
  warnings: readonly ImportIssue[];
}): ValidationReport {
  const errors: ImportIssue[] = [...existing.errors];
  const warnings: ImportIssue[] = [...existing.warnings];

  const error = (code: string, id: string, message: string, field?: string): void => {
    errors.push({ severity: 'error', code, file: registry.sourceFile(id), field, message });
  };
  const warn = (code: string, id: string, message: string, field?: string): void => {
    warnings.push({ severity: 'warning', code, file: registry.sourceFile(id), field, message });
  };

  // --- Unknown references -------------------------------------------------
  const technologies = registry.all('technologies');
  const cooling = registry.all('cooling');
  const power = registry.all('power');
  const hardware = registry.all('hardware');
  const workloads = registry.all('workloads');
  const contracts = registry.all('contracts');
  const regions = registry.all('regions');
  const events = registry.all('events');
  const scenarios = registry.all('scenarios');

  const requireRef = (
    present: boolean, code: string, holderId: string, field: string, targetId: string, kind: string,
  ): void => {
    if (!present) error(code, holderId, `References unknown ${kind} "${targetId}"`, field);
  };

  for (const [id, tech] of technologies) {
    for (const prereq of tech.prerequisites) {
      requireRef(technologies.has(prereq), 'unknown_reference', id, 'prerequisites', prereq, 'technology');
    }
    for (const unlocked of tech.unlocks.cooling ?? []) {
      requireRef(cooling.has(unlocked), 'unknown_reference', id, 'unlocks.cooling', unlocked, 'cooling technology');
    }
    for (const unlocked of tech.unlocks.power ?? []) {
      requireRef(power.has(unlocked), 'unknown_reference', id, 'unlocks.power', unlocked, 'power source');
    }
    for (const unlocked of tech.unlocks.hardware ?? []) {
      requireRef(hardware.has(unlocked), 'unknown_reference', id, 'unlocks.hardware', unlocked, 'hardware');
    }
    for (const unlocked of tech.unlocks.contracts ?? []) {
      requireRef(contracts.has(unlocked), 'unknown_reference', id, 'unlocks.contracts', unlocked, 'contract');
    }
  }
  for (const [id, def] of cooling) {
    if (def.researchId) requireRef(technologies.has(def.researchId), 'unknown_reference', id, 'researchId', def.researchId, 'technology');
  }
  for (const [id, def] of power) {
    if (def.researchId) requireRef(technologies.has(def.researchId), 'unknown_reference', id, 'researchId', def.researchId, 'technology');
  }
  for (const [id, def] of hardware) {
    if (def.researchId) requireRef(technologies.has(def.researchId), 'unknown_reference', id, 'researchId', def.researchId, 'technology');
    for (const workloadId of Object.keys(def.workloadAffinity)) {
      requireRef(workloads.has(workloadId), 'unknown_reference', id, 'workloadAffinity', workloadId, 'workload');
    }
  }
  for (const [id, def] of contracts) {
    requireRef(workloads.has(def.workloadId), 'unknown_reference', id, 'workloadId', def.workloadId, 'workload');
    for (const techId of def.requiredTechnologies) {
      requireRef(technologies.has(techId), 'unknown_reference', id, 'requiredTechnologies', techId, 'technology');
    }
  }
  for (const [id, def] of regions) {
    for (const powerId of Object.keys(def.resourceQuality)) {
      requireRef(power.has(powerId), 'unknown_reference', id, 'resourceQuality', powerId, 'power source');
    }
  }
  for (const [id, def] of scenarios) {
    requireRef(regions.has(def.regionId), 'unknown_reference', id, 'regionId', def.regionId, 'region');
    requireRef(registry.all('scoreProfiles').has(def.scoreProfileId), 'unknown_reference', id, 'scoreProfileId', def.scoreProfileId, 'score profile');
    requireRef(registry.all('balanceProfiles').has(def.balanceProfileId), 'unknown_reference', id, 'balanceProfileId', def.balanceProfileId, 'balance profile');
    for (const techId of def.startingTechnologies) {
      requireRef(technologies.has(techId), 'unknown_reference', id, 'startingTechnologies', techId, 'technology');
    }
    for (const eventId of def.eventIds) {
      requireRef(events.has(eventId), 'unknown_reference', id, 'eventIds', eventId, 'event');
    }
  }

  // --- Technology dependency cycles ---------------------------------------
  for (const cycle of findDependencyCycles(technologies)) {
    error('dependency_cycle', cycle[0] ?? '', `Technology dependency cycle: ${cycle.join(' -> ')}`, 'prerequisites');
  }

  // --- Unit incompatibility ------------------------------------------------
  for (const [id, def] of cooling) {
    if (def.energyFactorBest > def.energyFactor || def.energyFactorWorst < def.energyFactor) {
      error('unit_incompatibility', id,
        `energyFactorBest (${def.energyFactorBest}) must be <= energyFactor (${def.energyFactor}) <= energyFactorWorst (${def.energyFactorWorst})`,
        'energyFactor');
    }
    if (def.deratingEndC <= def.deratingStartC) {
      error('unit_incompatibility', id, `deratingEndC (${def.deratingEndC}) must exceed deratingStartC (${def.deratingStartC})`, 'deratingEndC');
    }
  }
  for (const [id, def] of power) {
    if (def.kind === 'storage' && (def.storageDurationHours <= 0 || def.roundTripEfficiency01 <= 0)) {
      error('unit_incompatibility', id, 'Storage sources need a positive storageDurationHours and roundTripEfficiency01', 'storageDurationHours');
    }
    if (def.kind !== 'storage' && def.storageDurationHours > 0) {
      error('unit_incompatibility', id, `Only storage sources may set storageDurationHours (kind is "${def.kind}")`, 'storageDurationHours');
    }
    if (def.renewable && !def.clean) {
      error('unit_incompatibility', id, 'A renewable source must also be clean', 'clean');
    }
  }
  for (const [id, def] of hardware) {
    if (def.heatFactor < def.powerFactor * 0.5) {
      error('unit_incompatibility', id,
        `heatFactor (${def.heatFactor}) is implausibly low against powerFactor (${def.powerFactor}); almost all drawn power becomes heat`, 'heatFactor');
    }
  }
  for (const [id, def] of workloads) {
    const shapeMean = def.hourlyDemandShape.reduce((a, b) => a + b, 0) / 24;
    if (Math.abs(shapeMean - 1) > 0.15) {
      error('unit_incompatibility', id,
        `hourlyDemandShape must average about 1.0 so meanUtilization01 stays meaningful (got ${shapeMean.toFixed(3)})`, 'hourlyDemandShape');
    }
  }

  // --- Score weights -------------------------------------------------------
  for (const [id, profile] of registry.all('scoreProfiles')) {
    const total = profile.weights.financial + profile.weights.reliability
      + profile.weights.environmental + profile.weights.customer + profile.weights.social;
    if (Math.abs(total - 1) > WEIGHT_TOLERANCE) {
      error('weights_not_normalised', id, `Score weights sum to ${total.toFixed(6)}, expected 1.0`, 'weights');
    }
    const sorted = [...profile.ratingBands].sort((a, b) => a.minScore - b.minScore);
    if (sorted[0]?.minScore !== 0) {
      error('rating_bands_incomplete', id, 'The lowest rating band must start at 0', 'ratingBands');
    }
  }

  // --- Missing asset address ----------------------------------------------
  // Every definition needs a stable human-readable name to address its art and
  // UI copy; an ID alone is not an asset address.
  for (const kind of ['regions', 'cooling', 'power', 'hardware', 'workloads', 'technologies', 'events'] as const) {
    for (const [id, def] of registry.all(kind) as ReadonlyMap<string, { name?: string }>) {
      if (!def.name || def.name.trim().length === 0) {
        error('missing_asset_address', id, `Definition has no display name to address assets and UI copy with`, 'name');
      }
    }
  }

  // --- Warnings ------------------------------------------------------------
  for (const [id, def] of cooling) {
    if (def.capexFactor > SUSPICIOUS_COST_FACTOR) warn('suspicious_cost', id, `capexFactor ${def.capexFactor} is far outside the balance table's range`, 'capexFactor');
    if (def.baseAnnualFailureRate < NEAR_ZERO_FAILURE_RATE) warn('near_zero_failure_rate', id, 'Near-zero failure rate removes this technology from the reliability system', 'baseAnnualFailureRate');
  }
  for (const [id, def] of power) {
    if (def.capexFactor > SUSPICIOUS_COST_FACTOR) warn('suspicious_cost', id, `capexFactor ${def.capexFactor} is far outside the balance table's range`, 'capexFactor');
    if (def.baseAnnualFailureRate < NEAR_ZERO_FAILURE_RATE) warn('near_zero_failure_rate', id, 'Near-zero failure rate removes this source from the reliability system', 'baseAnnualFailureRate');
  }
  for (const [id, def] of hardware) {
    if (def.purchaseFactor > SUSPICIOUS_COST_FACTOR) warn('suspicious_cost', id, `purchaseFactor ${def.purchaseFactor} is far outside the balance table's range`, 'purchaseFactor');
    if (def.baseAnnualFailureRate < NEAR_ZERO_FAILURE_RATE) warn('near_zero_failure_rate', id, 'Near-zero failure rate removes this hardware from the reliability system', 'baseAnnualFailureRate');
  }

  // Unreachable research: not a starting technology and not reachable from one.
  const startingTechs = new Set<string>();
  for (const scenario of scenarios.values()) for (const t of scenario.startingTechnologies) startingTechs.add(t);
  const reachable = computeReachable(technologies, startingTechs);
  for (const id of technologies.keys()) {
    if (!reachable.has(id)) warn('unreachable_research', id, 'No scenario can reach this technology from its starting set', 'prerequisites');
  }

  // Dominated technology: same branch and tier, costs at least as much, and
  // every effect target is matched or beaten by the other.
  for (const [id, tech] of technologies) {
    for (const [otherId, other] of technologies) {
      if (id === otherId) continue;
      if (other.branch !== tech.branch || other.tier !== tech.tier) continue;
      if (other.research.costUsd > tech.research.costUsd) continue;
      if (tech.effects.length === 0 || other.effects.length === 0) continue;
      // A technology whose value is the content it unlocks cannot be judged
      // dominated by comparing modifiers: two-phase immersion carries only cost
      // modifiers, and everything it is bought for lives in the cooling
      // definition it unlocks.
      if (unlocksContent(tech)) continue;
      if (dominates(other, tech)) {
        warn('dominated_technology', id, `Dominated by "${otherId}", which costs no more and is at least as good on every shared effect`, 'effects');
        break;
      }
    }
  }

  // Unprofitable contract in every baseline region: the contract's revenue can
  // never cover the energy alone at the region's own price and the best PUE
  // any cooling technology offers.
  const bestOverhead = Math.min(...[...cooling.values()].map((c) => c.energyFactorBest));
  for (const [id, contract] of contracts) {
    const workload = workloads.get(contract.workloadId);
    if (!workload) continue;
    let profitableSomewhere = false;
    for (const region of regions.values()) {
      const revenuePerHour = contract.computeUnits * contract.pricePerComputeUnitHour * workload.meanUtilization01;
      // A generous floor: the most efficient rack in the catalogue serving this
      // contract, at the region's mean energy price.
      const mwhPerHour = (contract.computeUnits / 100) * 0.006 * (1 + bestOverhead * 0.42);
      const energyCost = mwhPerHour * region.grid.basePricePerMwh;
      if (revenuePerHour > energyCost) { profitableSomewhere = true; break; }
    }
    if (!profitableSomewhere) {
      warn('unprofitable_contract', id, 'Revenue cannot cover energy cost in any baseline region, even at best-case efficiency', 'pricePerComputeUnitHour');
    }
  }

  for (const [id, event] of events) {
    if (!event.mitigation || event.mitigation.trim().length < 10) {
      warn('no_mitigation_path', id, 'Event has no player-readable mitigation path', 'mitigation');
    }
  }

  // Content unused by any scenario.
  const usedEvents = new Set<string>();
  const usedRegions = new Set<string>();
  for (const scenario of scenarios.values()) {
    usedRegions.add(scenario.regionId);
    for (const e of scenario.eventIds) usedEvents.add(e);
  }
  for (const id of events.keys()) if (!usedEvents.has(id)) warn('unused_content', id, 'Event is not referenced by any scenario', 'id');
  for (const id of regions.keys()) if (!usedRegions.has(id)) warn('unused_content', id, 'Region is not used by any scenario', 'id');

  // Content no reachable technology unlocks can never be built, however well
  // formed its own definition is. A cooling technology or hardware family with
  // no route into the game is dead content.
  const unlocked = { cooling: new Set<string>(), power: new Set<string>(), hardware: new Set<string>() };
  for (const id of reachable) {
    const tech = technologies.get(id);
    if (!tech) continue;
    for (const target of tech.unlocks.cooling ?? []) unlocked.cooling.add(target);
    for (const target of tech.unlocks.power ?? []) unlocked.power.add(target);
    for (const target of tech.unlocks.hardware ?? []) unlocked.hardware.add(target);
  }
  for (const id of cooling.keys()) {
    if (!unlocked.cooling.has(id)) warn('unreachable_content', id, 'No reachable technology unlocks this cooling technology', 'id');
  }
  for (const id of power.keys()) {
    if (!unlocked.power.has(id)) warn('unreachable_content', id, 'No reachable technology unlocks this power source', 'id');
  }
  for (const id of hardware.keys()) {
    if (!unlocked.hardware.has(id)) warn('unreachable_content', id, 'No reachable technology unlocks this hardware', 'id');
  }

  return { errors, warnings, ok: errors.length === 0 };
}

/** Depth-first cycle detection over technology prerequisites. */
function findDependencyCycles(technologies: ReadonlyMap<string, TechnologyDefinition>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id]);
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const prereq of technologies.get(id)?.prerequisites ?? []) {
      if (technologies.has(prereq)) visit(prereq);
    }
    stack.pop();
    state.set(id, 'done');
  };

  for (const id of [...technologies.keys()].sort()) visit(id);
  return cycles;
}

/** Technologies reachable by repeatedly satisfying prerequisites from `seed`. */
function computeReachable(
  technologies: ReadonlyMap<string, TechnologyDefinition>,
  seed: ReadonlySet<string>,
): Set<string> {
  const reachable = new Set(seed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, tech] of technologies) {
      if (reachable.has(id)) continue;
      if (tech.prerequisites.every((p) => reachable.has(p))) {
        reachable.add(id);
        grew = true;
      }
    }
  }
  return reachable;
}

/**
 * True when `candidate` is at least as good as `other` on every effect target
 * they share, and strictly better on at least one. "Better" means a larger
 * multiplier on a benefit target and a smaller one on a cost target, so the
 * comparison needs to know which way each target points.
 */
const COST_TARGETS = new Set([
  'cooling.energyFactor', 'cooling.failureRate', 'hardware.powerDraw', 'hardware.heatOutput',
  'hardware.purchaseCost', 'hardware.failureRate', 'power.failureRate', 'facility.electricalLoss',
  'facility.maintenanceCost', 'facility.maintenanceComplexity', 'facility.hallCapex',
  'water.freshwaterDemand', 'waste.ewasteGeneration', 'network.transitCost', 'network.latency',
  'security.incidentRate', 'finance.operatingCost', 'power.capex',
]);

/** True when the technology's real payoff is the content it makes available. */
function unlocksContent(tech: TechnologyDefinition): boolean {
  const { buildings, cooling, power, hardware, contracts } = tech.unlocks;
  return [buildings, cooling, power, hardware, contracts].some((list) => (list?.length ?? 0) > 0);
}

function dominates(candidate: TechnologyDefinition, other: TechnologyDefinition): boolean {
  const effectsOf = (tech: TechnologyDefinition): Map<string, number> => {
    const map = new Map<string, number>();
    for (const effect of tech.effects) {
      if (effect.operation !== 'multiply' && effect.operation !== 'add') continue;
      map.set(effect.target, effect.value);
    }
    return map;
  };
  const a = effectsOf(candidate);
  const b = effectsOf(other);
  const shared = [...b.keys()].filter((target) => a.has(target));
  if (shared.length === 0 || shared.length !== b.size) return false;

  let strictlyBetter = false;
  for (const target of shared) {
    const candidateValue = a.get(target) ?? 0;
    const otherValue = b.get(target) ?? 0;
    const lowerIsBetter = COST_TARGETS.has(target);
    const better = lowerIsBetter ? candidateValue < otherValue : candidateValue > otherValue;
    const worse = lowerIsBetter ? candidateValue > otherValue : candidateValue < otherValue;
    if (worse) return false;
    if (better) strictlyBetter = true;
  }
  return strictlyBetter;
}
