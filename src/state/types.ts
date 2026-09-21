/**
 * Mutable runtime state.
 *
 * Spec chapter 9 gives the master state model:
 *   GameState { meta, world, economy, companies, regions, facilities,
 *               research, activeEvents, annualScores, randomStreams }
 * Everything here is plain serialisable data - no class instances, no
 * references to definitions, only permanent string IDs (chapter 10).
 */

import type { RandomStreamsState } from '../core/rng.js';
import type { ScoreWeights } from '../definitions/types.js';

export interface MetaState {
  readonly scenarioId: string;
  readonly campaignSeed: string;
  readonly startDateIso: string;
  readonly minutesPerTick: number;
  tickIndex: number;
  /** Simulated UTC instant at the end of the last completed tick. */
  gameTimeIso: string;
  campaignYear: number;
}

export interface WeatherState {
  dryBulbC: number;
  humidity01: number;
  /** Derived from dry bulb and humidity; drives evaporative performance. */
  wetBulbC: number;
  /** Today's mean, held across the day so weather does not flicker per tick. */
  dailyMeanC: number;
  /** 0-1 clear-sky solar factor for the current tick. */
  solarFactor01: number;
  /** 0-1 wind resource factor for the current tick. */
  windFactor01: number;
}

export interface MarketState {
  /** Current wholesale energy price, $/MWh. */
  energyPricePerMwh: number;
  /** Current grid carbon intensity, kg CO2e/MWh. */
  gridCarbonKgPerMwh: number;
  gridAvailable: boolean;
  /** Ticks remaining in the current grid outage. */
  outageTicksRemaining: number;
  /** Multiplier on contract pricing from commercial events. */
  contractPriceFactor: number;
  /** Cumulative real drift applied to price and carbon since campaign start. */
  priceDriftFactor: number;
  carbonDriftFactor: number;
}

export interface WorldState {
  regionId: string;
  weather: WeatherState;
  market: MarketState;
  /** Water withdrawn this calendar year, m3, against the regional limit. */
  waterWithdrawnYearM3: number;
  /** Multiplier on water price from drought events and restrictions. */
  waterPriceFactor: number;
  /** Multiplier on the regional withdrawal limit from restrictions. */
  waterLimitFactor: number;
  droughtActive: boolean;
}

export interface CompanyState {
  cash: number;
  debt: number;
  /** 0-100, global customer and lender confidence. */
  reputation: number;
  /** -100..100, local permits, incentives and expansion rights. */
  communityTrust: number;
  influence: number;
  researchPoints: number;
  /** Rises with capacity; gates high-tier research. */
  companyLevel: number;
  staffCount: number;
  /** Cumulative totals for the annual report. */
  lifetimeRevenue: number;
  lifetimeCost: number;
  lifetimeCapex: number;
}

/** A group of identical racks installed together, aged and conditioned together. */
export interface RackGroupState {
  readonly instanceId: string;
  readonly hardwareId: string;
  count: number;
  /** 0-1; falls with age and hazard, rises with maintenance. */
  condition01: number;
  /** Tick the group was commissioned. */
  installedTick: number;
  /** Racks currently out of service awaiting repair. */
  failedCount: number;
  /** Cumulative energy served, MWh. For depreciation and refresh decisions. */
  lifetimeItMwh: number;
}

export interface HallState {
  readonly instanceId: string;
  /** Cooling technology serving this hall. */
  coolingId: string;
  /** Tick the hall shell was commissioned; ages the cooling plant. */
  installedTick: number;
  /** Racks the hall shell can hold. */
  rackCapacity: number;
  rackGroups: RackGroupState[];
  /** 0-1 build progress; racks cannot be installed below 1. */
  constructionProgress01: number;
  condition01: number;
  /** Rated cooling capacity, kW. */
  ratedCoolingKw: number;
  /** Cooling units out of service. */
  coolingFailed: boolean;
  /** 0-1 share of IT load shed by thermal throttling, applied next tick. */
  throttle01: number;
  /** Current cold-aisle inlet temperature, degrees C. */
  inletTempC: number;
}

export interface PowerAssetState {
  readonly instanceId: string;
  readonly definitionId: string;
  capacityMw: number;
  condition01: number;
  installedTick: number;
  /** Storage only: current energy content, MWh. */
  storedMwh: number;
  /** Storage only: usable capacity after degradation, MWh. */
  usableMwh: number;
  /** Storage only: cumulative full-equivalent cycles. */
  cycles: number;
  /** Generation only: hours run this year, for runtime restrictions. */
  runHoursThisYear: number;
  available: boolean;
  /** Construction progress; the asset generates nothing below 1. */
  constructionProgress01: number;
}

export interface FacilityState {
  readonly instanceId: string;
  readonly regionId: string;
  halls: HallState[];
  powerAssets: PowerAssetState[];
  /** Land consumed by buildings and generation, hectares. */
  landUsedHectares: number;
  /** Land restored to habitat, hectares. */
  landRestoredHectares: number;
  /** 0-100 ecological condition of the site. */
  biodiversity: number;
  /** Maintenance jobs waiting, each a repair not yet funded or staffed. */
  maintenanceBacklog: number;
}

/**
 * An offer on the contract market. Contract definitions are archetypes; the
 * market instantiates them at a negotiated size, price and term, so the book
 * the operator can build is not a fixed list of ten singletons.
 */
export interface ContractOfferState {
  readonly instanceId: string;
  readonly definitionId: string;
  readonly computeUnits: number;
  readonly pricePerComputeUnitHour: number;
  readonly termMonths: number;
  readonly offeredTick: number;
  readonly expiresTick: number;
}

export interface ActiveContractState {
  readonly instanceId: string;
  readonly definitionId: string;
  /** Negotiated terms, snapshotted at signing; the definition is the archetype. */
  readonly computeUnits: number;
  readonly pricePerComputeUnitHour: number;
  readonly termMonths: number;
  startTick: number;
  endTick: number;
  /** Compute-unit-hours demanded this SLA period. */
  demandedUnitHours: number;
  /** Compute-unit-hours actually served this SLA period. */
  servedUnitHours: number;
  /** Cumulative over the contract, for renewal and reporting. */
  lifetimeDemandedUnitHours: number;
  lifetimeServedUnitHours: number;
  revenueThisPeriod: number;
  penaltiesThisPeriod: number;
  /** Deferred flexible work waiting for a cheaper or cleaner hour. */
  backlogUnitHours: number;
}

export interface ResearchState {
  /** Completed technology IDs. */
  completed: string[];
  /** Technology currently being researched, if any. */
  activeId: string | null;
  /** Research points already committed to the active technology. */
  activeProgressRP: number;
  /** Unlocked content IDs, accumulated from completed technologies. */
  unlockedCooling: string[];
  unlockedPower: string[];
  unlockedHardware: string[];
  unlockedContracts: string[];
  capabilities: string[];
}

export interface ActiveEventState {
  readonly instanceId: string;
  readonly definitionId: string;
  startTick: number;
  endTick: number;
}

/** Accumulators reset at the close of each accounting period. */
export interface PeriodAccumulator {
  itMwh: number;
  coolingMwh: number;
  electricalLossMwh: number;
  auxiliaryMwh: number;
  facilityMwh: number;
  /** Energy by source definition ID, MWh. */
  energyBySource: Record<string, number>;
  /** Clean energy delivered in the same hour it was consumed, MWh. */
  hourlyMatchedCleanMwh: number;
  renewableMwh: number;
  cleanMwh: number;
  exportedHeatMwh: number;
  operationalCarbonKg: number;
  embodiedCarbonKg: number;
  offsetCarbonKg: number;
  waterWithdrawnM3: number;
  waterConsumedM3: number;
  waterReclaimedM3: number;
  revenue: number;
  energyCost: number;
  waterCost: number;
  maintenanceCost: number;
  staffCost: number;
  fuelCost: number;
  carbonCost: number;
  penalties: number;
  otherCost: number;
  capex: number;
  heatRevenue: number;
  gridServiceRevenue: number;
  /** Compute-unit-hours demanded and served across all contracts. */
  demandedUnitHours: number;
  servedUnitHours: number;
  /** Ticks in which any contracted capacity was unserved. */
  degradedTicks: number;
  totalTicks: number;
  incidents: number;
  preventableIncidents: number;
  wasteGeneratedTonnes: number;
  wasteDivertedTonnes: number;
  wasteLandfilledTonnes: number;
  hardwareRetiredRacks: number;
  hardwareResaleRevenue: number;
}

export interface ScoreCategoryDetail {
  readonly score: number;
  /** Named contributions, each already scored 0-100, for the drawer. */
  readonly components: Readonly<Record<string, number>>;
}

export interface AnnualScore {
  readonly year: number;
  readonly overall: number;
  readonly rating: string;
  readonly label: string;
  readonly categories: Readonly<Record<keyof ScoreWeights, ScoreCategoryDetail>>;
  readonly gatesTripped: readonly string[];
}

export interface GameState {
  meta: MetaState;
  world: WorldState;
  company: CompanyState;
  facilities: FacilityState[];
  contracts: ActiveContractState[];
  contractOffers: ContractOfferState[];
  research: ResearchState;
  activeEvents: ActiveEventState[];
  /** Cooldown expiry tick per event definition ID. */
  eventCooldowns: Record<string, number>;
  /** Accumulators for the current hour, month and year. */
  hour: PeriodAccumulator;
  month: PeriodAccumulator;
  year: PeriodAccumulator;
  annualScores: AnnualScore[];
  randomStreams: RandomStreamsState;
  /** Gates currently tripped, e.g. an unresolved safety incident. */
  gateFlags: string[];
  /** Diagnostic snapshots around failures and score changes (chapter 9). */
  diagnostics: DiagnosticEntry[];
}

export interface DiagnosticEntry {
  readonly tick: number;
  readonly timeIso: string;
  readonly kind: string;
  readonly message: string;
  readonly data?: Readonly<Record<string, number | string | boolean>>;
}

export function createAccumulator(): PeriodAccumulator {
  return {
    itMwh: 0, coolingMwh: 0, electricalLossMwh: 0, auxiliaryMwh: 0, facilityMwh: 0,
    energyBySource: {}, hourlyMatchedCleanMwh: 0, renewableMwh: 0, cleanMwh: 0,
    exportedHeatMwh: 0, operationalCarbonKg: 0, embodiedCarbonKg: 0, offsetCarbonKg: 0,
    waterWithdrawnM3: 0, waterConsumedM3: 0, waterReclaimedM3: 0,
    revenue: 0, energyCost: 0, waterCost: 0, maintenanceCost: 0, staffCost: 0, fuelCost: 0,
    carbonCost: 0, penalties: 0, otherCost: 0, capex: 0, heatRevenue: 0, gridServiceRevenue: 0,
    demandedUnitHours: 0, servedUnitHours: 0, degradedTicks: 0, totalTicks: 0,
    incidents: 0, preventableIncidents: 0,
    wasteGeneratedTonnes: 0, wasteDivertedTonnes: 0, wasteLandfilledTonnes: 0,
    hardwareRetiredRacks: 0, hardwareResaleRevenue: 0,
  };
}

/** Adds `from` into `into`. Used to roll the hour up into month and year. */
export function accumulate(into: PeriodAccumulator, from: PeriodAccumulator): void {
  for (const key of Object.keys(from) as Array<keyof PeriodAccumulator>) {
    if (key === 'energyBySource') continue;
    (into[key] as number) += from[key] as number;
  }
  for (const [sourceId, mwh] of Object.entries(from.energyBySource)) {
    into.energyBySource[sourceId] = (into.energyBySource[sourceId] ?? 0) + mwh;
  }
}

export function totalCost(period: PeriodAccumulator): number {
  return period.energyCost + period.waterCost + period.maintenanceCost + period.staffCost
    + period.fuelCost + period.carbonCost + period.penalties + period.otherCost;
}

export function totalRevenue(period: PeriodAccumulator): number {
  return period.revenue + period.heatRevenue + period.gridServiceRevenue + period.hardwareResaleRevenue;
}
