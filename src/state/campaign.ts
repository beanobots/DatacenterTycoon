/**
 * Campaign initialisation: scenario definition plus seed to starting GameState.
 *
 * Everything random about a campaign derives from the seed, and everything
 * else derives from the scenario, so two runs with the same pair produce the
 * same campaign (acceptance criterion 3).
 */

import { RandomStreams } from '../core/rng.js';
import type { ContentRegistry } from '../content/registry.js';
import type { ScenarioDefinition } from '../definitions/types.js';
import { createAccumulator, type GameState } from './types.js';

export function createInitialState(
  registry: ContentRegistry,
  scenario: ScenarioDefinition,
  campaignSeed: string,
  minutesPerTick: number,
): GameState {
  const region = registry.region(scenario.regionId, scenario.id);
  const startDate = new Date(`${scenario.startDate}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime())) {
    throw new Error(`Scenario "${scenario.id}" has an invalid startDate "${scenario.startDate}"`);
  }

  // Starting technologies are granted, not researched, so their unlocks have to
  // be applied here rather than by the research system.
  const research = {
    completed: [...scenario.startingTechnologies],
    active: [] as GameState['research']['active'],
    unlockedCooling: [] as string[],
    unlockedPower: [] as string[],
    unlockedHardware: [] as string[],
    unlockedContracts: [] as string[],
    capabilities: [] as string[],
  };
  for (const techId of scenario.startingTechnologies) {
    const technology = registry.technology(techId, scenario.id);
    for (const id of technology.unlocks.cooling ?? []) research.unlockedCooling.push(id);
    for (const id of technology.unlocks.power ?? []) research.unlockedPower.push(id);
    for (const id of technology.unlocks.hardware ?? []) research.unlockedHardware.push(id);
    for (const id of technology.unlocks.contracts ?? []) research.unlockedContracts.push(id);
    for (const id of technology.unlocks.capabilities ?? []) research.capabilities.push(id);
  }

  return {
    meta: {
      scenarioId: scenario.id,
      campaignSeed,
      startDateIso: startDate.toISOString(),
      minutesPerTick,
      tickIndex: 0,
      nextInstanceId: 0,
      gameTimeIso: startDate.toISOString(),
      campaignYear: startDate.getUTCFullYear(),
    },
    world: {
      regionId: region.id,
      weather: {
        dryBulbC: region.climate.monthlyMeanTempC[0] ?? 15,
        humidity01: region.climate.monthlyHumidity01[0] ?? 0.5,
        wetBulbC: 10,
        dailyMeanC: region.climate.monthlyMeanTempC[0] ?? 15,
        solarFactor01: 0,
        windFactor01: 0.5,
      },
      market: {
        energyPricePerMwh: region.grid.basePricePerMwh,
        gridCarbonKgPerMwh: region.grid.baseCarbonKgPerMwh,
        gridAvailable: true,
        outageTicksRemaining: 0,
        contractPriceFactor: 1,
        priceDriftFactor: 1,
        carbonDriftFactor: 1,
      },
      waterWithdrawnYearM3: 0,
      waterPriceFactor: 1,
      waterLimitFactor: 1,
      droughtActive: false,
    },
    company: {
      cash: scenario.startingCash,
      debt: scenario.startingDebt,
      reputation: scenario.startingReputation,
      communityTrust: region.people.startingTrust,
      influence: 0,
      companyLevel: 0,
      staffCount: 8,
      lifetimeRevenue: 0,
      lifetimeCost: 0,
      lifetimeCapex: 0,
    },
    facilities: [],
    contracts: [],
    contractOffers: [],
    research,
    activeEvents: [],
    eventCooldowns: {},
    hour: createAccumulator(),
    month: createAccumulator(),
    year: createAccumulator(),
    lastMonth: createAccumulator(),
    annualScores: [],
    annualReports: [],
    randomStreams: RandomStreams.fromSeed(campaignSeed).toState(),
    gateFlags: [],
    diagnostics: [],
  };
}
