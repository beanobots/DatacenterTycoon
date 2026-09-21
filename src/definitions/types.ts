/**
 * Immutable content definitions.
 *
 * Spec chapter 10, "Definition/state separation": definitions are immutable,
 * versioned content; runtime state holds mutable values and refers to
 * definitions by permanent string ID. Nothing in this file is mutated after
 * campaign load - the importer deep-freezes every definition it produces.
 */

/** Every definition carries its own ID and schema version for migrations. */
export interface DefinitionBase {
  readonly id: string;
  readonly schemaVersion: number;
  readonly name: string;
  readonly description?: string;
}

// ---------------------------------------------------------------------------
// Modifiers - the effect system technologies, events and policies all share.
// ---------------------------------------------------------------------------

export type ModifierOperation = 'add' | 'multiply' | 'set' | 'min' | 'max';

/**
 * One effect on one named simulation value. `target` is a dotted path such as
 * `cooling.energyFactor`; modifiers are applied lowest `priority` first so
 * content can order competing effects deterministically.
 */
export interface Modifier {
  readonly target: string;
  readonly operation: ModifierOperation;
  readonly value: number;
  readonly priority: number;
  /** Optional filter: apply only to a definition with this ID. */
  readonly appliesTo?: string;
}

// ---------------------------------------------------------------------------
// Regions (spec chapter 4, "Regional variables")
// ---------------------------------------------------------------------------

export interface ClimateProfile {
  /** Monthly mean dry-bulb temperature, degrees C, January first. */
  readonly monthlyMeanTempC: readonly number[];
  /** Monthly mean daily temperature swing, degrees C. */
  readonly monthlySwingC: readonly number[];
  /** Monthly mean relative humidity, 0-1. */
  readonly monthlyHumidity01: readonly number[];
  /** Standard deviation of the daily weather noise, degrees C. */
  readonly dailyVariabilityC: number;
  /** Site elevation, metres. Thins the air and derates dry coolers. */
  readonly elevationM: number;
  /** Airborne contamination 0-1: smoke, dust, salt. Penalises economisers. */
  readonly contamination01: number;
}

export interface GridProfile {
  /** Interconnection capacity available to the player, MW. */
  readonly capacityMw: number;
  /** Annual mean wholesale price, $/MWh. */
  readonly basePricePerMwh: number;
  /** Multiplicative hourly price shape, 24 entries, mean ~1.0. */
  readonly hourlyPriceShape: readonly number[];
  /** Multiplicative monthly price shape, 12 entries, mean ~1.0. */
  readonly monthlyPriceShape: readonly number[];
  /** Annual mean grid carbon intensity, kg CO2e/MWh. */
  readonly baseCarbonKgPerMwh: number;
  /** Multiplicative hourly carbon shape, 24 entries. */
  readonly hourlyCarbonShape: readonly number[];
  /** Probability per hour that grid import is unavailable. */
  readonly hourlyOutageProbability: number;
  /** Mean outage length, hours. */
  readonly meanOutageHours: number;
  /** Annual real price drift, e.g. 0.01 for +1%/year. */
  readonly annualPriceDrift: number;
  /** Annual change in grid carbon intensity, e.g. -0.03 for -3%/year. */
  readonly annualCarbonDrift: number;
}

export interface WaterProfile {
  /** Annual withdrawal permitted, cubic metres. */
  readonly annualWithdrawalLimitM3: number;
  readonly pricePerM3: number;
  /** Watershed stress 0-1. Drives community reaction and drought risk. */
  readonly stress01: number;
  /** Share of demand servable from reclaimed supply once unlocked, 0-1. */
  readonly reclaimedAvailability01: number;
  readonly reclaimedPricePerM3: number;
  readonly annualDroughtProbability: number;
}

export interface LandProfile {
  readonly pricePerHectare: number;
  readonly availableHectares: number;
  /** Biodiversity sensitivity 0-1. Raises the trust cost of clearing land. */
  readonly biodiversitySensitivity01: number;
  readonly brownfield: boolean;
  /** Construction cost multiplier for terrain, access and ground conditions. */
  readonly constructionCostFactor: number;
}

export interface ConnectivityProfile {
  /** Round-trip latency to the nearest major demand centre, ms. */
  readonly latencyMsToDemandCentre: number;
  readonly fiberCapacityGbps: number;
  /** Number of independent fibre routes. 1 means no route redundancy. */
  readonly routeDiversity: number;
  readonly transitCostPerGbpsMonth: number;
}

export interface PeopleProfile {
  /** Availability of qualified staff, 0-1. */
  readonly laborSupply01: number;
  /** Wage multiplier against the balance profile's base salary. */
  readonly wageIndex: number;
  /** How strongly the community reacts to noise, water and traffic, 0-1. */
  readonly communitySensitivity01: number;
  readonly populationDensity: number;
  /** Community trust at campaign start, -100..100. */
  readonly startingTrust: number;
}

export interface HazardProfile {
  readonly heatWave: number;
  readonly drought: number;
  readonly flood: number;
  readonly storm: number;
  readonly wildfire: number;
  readonly earthquake: number;
  readonly seaLevel: number;
}

export interface PolicyProfile {
  /** Permit lead time, days. */
  readonly permitDays: number;
  /** Carbon price, $/tonne CO2e. */
  readonly carbonPricePerTonne: number;
  /** Multiplier on water price during restrictions. */
  readonly waterRestrictionFactor: number;
  /** Capital grant as a share of construction cost, 0-1. */
  readonly capitalIncentive01: number;
  /** Annual corporate tax rate, 0-1. */
  readonly taxRate01: number;
  /** Whether annual sustainability reporting is mandatory here. */
  readonly reportingMandatory: boolean;
}

export interface RegionDefinition extends DefinitionBase {
  readonly archetype: 'desert' | 'temperate' | 'cold' | 'urban' | 'tropical' | 'coastal';
  readonly climate: ClimateProfile;
  readonly grid: GridProfile;
  readonly water: WaterProfile;
  readonly land: LandProfile;
  readonly connectivity: ConnectivityProfile;
  readonly people: PeopleProfile;
  readonly hazards: HazardProfile;
  readonly policy: PolicyProfile;
  /** Capacity factor by power source ID, 0-1. Solar in a desert beats solar in the north. */
  readonly resourceQuality: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Cooling (spec chapter 12 cooling table)
// ---------------------------------------------------------------------------

export interface CoolingTechnologyDefinition extends DefinitionBase {
  readonly researchId: string | null;
  /** CapEx multiplier against the balance profile's base cost per cooling MW. */
  readonly capexFactor: number;
  /** Annual maintenance multiplier. */
  readonly maintenanceFactor: number;
  /** Cooling energy multiplier at reference conditions. */
  readonly energyFactor: number;
  /** Best-case energy factor when ambient conditions are favourable. */
  readonly energyFactorBest: number;
  /** Worst-case energy factor when ambient conditions are hostile. */
  readonly energyFactorWorst: number;
  /** Site water use, m3 per MWh of IT energy, at reference conditions. */
  readonly waterFactor: number;
  /** Maximum rack power this technology can cool, kW. */
  readonly densityKwPerRack: number;
  /** Share of rejected heat that is recoverable at useful grade, 0-1. */
  readonly heatReuse01: number;
  /** Maintenance and staffing complexity, 0-1. */
  readonly complexity01: number;
  /**
   * Dry-bulb temperature above which capacity starts derating, degrees C, and
   * the temperature at which capacity is exhausted.
   */
  readonly deratingStartC: number;
  readonly deratingEndC: number;
  /** How strongly wet-bulb temperature drives performance, 0-1. */
  readonly wetBulbSensitivity01: number;
  /** How strongly airborne contamination degrades performance, 0-1. */
  readonly contaminationSensitivity01: number;
  /** Base annual failure rate per unit. */
  readonly baseAnnualFailureRate: number;
}

// ---------------------------------------------------------------------------
// Power (spec chapter 12 power table)
// ---------------------------------------------------------------------------

export type PowerCarbonMode = 'regional' | 'fixed' | 'fuel';
export type PowerPriceMode = 'regional' | 'fixed';

export interface PowerSourceDefinition extends DefinitionBase {
  readonly researchId: string | null;
  readonly kind: 'import' | 'generation' | 'storage' | 'contract';
  /** CapEx multiplier against the balance profile's base cost per MW. */
  readonly capexFactor: number;
  /** Variable cost multiplier, or regional price for grid import. */
  readonly variableCostFactor: number;
  readonly priceMode: PowerPriceMode;
  /** How controllable the output is, 0-1. Drives dispatch order and firmness. */
  readonly dispatchability01: number;
  readonly carbonMode: PowerCarbonMode;
  /** Carbon multiplier against the balance profile's base intensity. */
  readonly carbonFactor: number;
  /** Land use, hectares per MW. */
  readonly landHectaresPerMw: number;
  /** Immediate community trust change on commissioning. */
  readonly communityDelta: number;
  /** Community trust change per hour of operation, for noisy sources. */
  readonly communityDeltaPerRunHour: number;
  /** Counts toward the renewable energy factor. */
  readonly renewable: boolean;
  /** Counts as clean for hourly matching (renewables, hydro, nuclear). */
  readonly clean: boolean;
  /** Storage only: usable energy per MW of power rating, hours. */
  readonly storageDurationHours: number;
  /** Storage only: round-trip efficiency, 0-1. */
  readonly roundTripEfficiency01: number;
  /** Storage only: capacity lost per full-equivalent cycle, 0-1. */
  readonly degradationPerCycle01: number;
  /** Generation only: fuel consumed per MWh, litres or kg. Drives fuel stock. */
  readonly fuelPerMwh: number;
  readonly baseAnnualFailureRate: number;
  /** Construction lead time, days. */
  readonly leadTimeDays: number;
  /** Asset life, years. */
  readonly lifeYears: number;
}

// ---------------------------------------------------------------------------
// Hardware (spec chapter 12 hardware table)
// ---------------------------------------------------------------------------

export type HardwareFamily = 'cpu' | 'gpu' | 'asic' | 'storage' | 'archive' | 'experimental';

export interface HardwareDefinition extends DefinitionBase {
  readonly researchId: string | null;
  readonly family: HardwareFamily;
  readonly generation: number;
  /** Purchase price multiplier against the balance profile's base rack price. */
  readonly purchaseFactor: number;
  /** Compute multiplier against the base compute units per rack. */
  readonly computeFactor: number;
  /** Power multiplier against the base rack power. */
  readonly powerFactor: number;
  /** Heat multiplier. Above the power factor where hardware runs hot for its draw. */
  readonly heatFactor: number;
  /** How many workload families this hardware serves well, 0-1. */
  readonly flexibility01: number;
  /** Embodied carbon multiplier against the base embodied carbon per rack. */
  readonly embodiedFactor: number;
  readonly lifeYears: number;
  /** Per-workload efficiency multipliers, keyed by workload definition ID. */
  readonly workloadAffinity: Readonly<Record<string, number>>;
  /** Minimum cooling density this hardware needs, kW per rack. */
  readonly requiredCoolingKwPerRack: number;
  readonly baseAnnualFailureRate: number;
  /** Refurbished stock: higher failure rate, lower embodied carbon. */
  readonly refurbished: boolean;
  /** Share of retired units recoverable for resale, 0-1. */
  readonly resaleValue01: number;
}

// ---------------------------------------------------------------------------
// Workloads and contracts (spec chapter 12 workload table)
// ---------------------------------------------------------------------------

export type PenaltyClass = 'low' | 'medium' | 'high' | 'extreme';

export interface WorkloadDefinition extends DefinitionBase {
  /** Revenue multiplier against the balance profile's base revenue per compute-hour. */
  readonly revenueFactor: number;
  /** Contracted availability, 0-1. Missing it triggers SLA penalties. */
  readonly uptimeRequirement01: number;
  /** Latency sensitivity, 0-1. Compared against regional latency. */
  readonly latencySensitivity01: number;
  /** How freely the job can be deferred or shifted, 0-1. */
  readonly flexibility01: number;
  /** How strongly the customer reacts to price, 0-1. */
  readonly priceSensitivity01: number;
  readonly penaltyClass: PenaltyClass;
  /** Hardware families that can serve this workload at all. */
  readonly compatibleFamilies: readonly HardwareFamily[];
  /** Multiplicative daily demand shape, 24 entries. */
  readonly hourlyDemandShape: readonly number[];
  /** Mean share of contracted capacity actually in use, 0-1. */
  readonly meanUtilization01: number;
  /** Latency beyond which the customer is dissatisfied, ms. */
  readonly latencyToleranceMs: number;
  /** Campaign year this workload family becomes available. */
  readonly availableFromYear: number;
}

export interface ContractDefinition extends DefinitionBase {
  readonly workloadId: string;
  /** Contracted compute units. */
  readonly computeUnits: number;
  readonly termMonths: number;
  /** Price per compute-unit-hour, before regional and market adjustment. */
  readonly pricePerComputeUnitHour: number;
  /** Availability the customer is buying, 0-1. */
  readonly slaUptime01: number;
  /** Penalty as a share of monthly revenue per point of missed availability. */
  readonly penaltyRate: number;
  /** Reputation required to be offered this contract, 0-100. */
  readonly minimumReputation: number;
  /** Technologies the operator must hold to bid. */
  readonly requiredTechnologies: readonly string[];
  /** Maximum carbon intensity the customer accepts, kg/MWh. 0 means no limit. */
  readonly maxCarbonIntensity: number;
  readonly reputationOnCompletion: number;
  readonly renewalProbability01: number;
  readonly availableFromYear: number;
}

// ---------------------------------------------------------------------------
// Technology (spec chapter 10 technology schema)
// ---------------------------------------------------------------------------

export type TechnologyBranch =
  | 'efficiency'
  | 'cooling'
  | 'power'
  | 'hardware'
  | 'network'
  | 'grid'
  | 'environment'
  | 'security'
  | 'operations'
  | 'megaproject';

export interface ResearchCost {
  /**
   * R&D budget for the project, funded over `durationDays` rather than paid up
   * front. Research is an operating cost that competes with racks and plant for
   * the same cash, which is the trade-off it exists to create.
   */
  readonly costUsd: number;
  readonly durationDays: number;
  readonly minimumCompanyLevel: number;
  /** Specialists the project occupies for its whole duration. */
  readonly requiredSpecialists: number;
}

export interface TechnologyUnlocks {
  readonly buildings?: readonly string[];
  readonly cooling?: readonly string[];
  readonly power?: readonly string[];
  readonly hardware?: readonly string[];
  readonly contracts?: readonly string[];
  readonly capabilities?: readonly string[];
}

export interface TechnologyDefinition extends DefinitionBase {
  readonly branch: TechnologyBranch;
  readonly tier: number;
  readonly research: ResearchCost;
  readonly prerequisites: readonly string[];
  readonly effects: readonly Modifier[];
  readonly unlocks: TechnologyUnlocks;
  /** Plain-language trade-off, shown in the research UI and reports. */
  readonly tradeOff: string;
}

// ---------------------------------------------------------------------------
// Events (spec chapter 13 event catalog)
// ---------------------------------------------------------------------------

export type EventClass = 'operational' | 'environmental' | 'commercial' | 'political' | 'opportunity';

export interface EventTrigger {
  /** Base probability per day of firing when conditions hold. */
  readonly dailyProbability: number;
  readonly minimumYear: number;
  /** Hazard key from the region's hazard profile that scales the probability. */
  readonly hazardKey?: keyof HazardProfile;
  /** Only fire when this condition holds. */
  readonly requiresCondition?: EventCondition;
  /** Days that must pass before this event can fire again. */
  readonly cooldownDays: number;
}

export interface EventCondition {
  /** Dotted path into the world snapshot, e.g. `weather.dryBulbC`. */
  readonly metric: string;
  readonly comparison: 'gt' | 'lt' | 'gte' | 'lte';
  readonly value: number;
}

export interface EventDefinition extends DefinitionBase {
  readonly eventClass: EventClass;
  readonly trigger: EventTrigger;
  readonly durationDays: number;
  readonly durationVarianceDays: number;
  readonly effects: readonly Modifier[];
  /** Immediate one-off cash impact, positive or negative. */
  readonly immediateCash: number;
  readonly immediateTrust: number;
  readonly immediateReputation: number;
  /** Player-readable mitigation, required by the chapter 10 validator warnings. */
  readonly mitigation: string;
}

// ---------------------------------------------------------------------------
// Scoring and balance profiles (spec chapter 7)
// ---------------------------------------------------------------------------

export interface ScoreWeights {
  readonly financial: number;
  readonly reliability: number;
  readonly environmental: number;
  readonly customer: number;
  readonly social: number;
}

export interface RatingBand {
  readonly rating: string;
  readonly minScore: number;
  readonly label: string;
}

export interface ScoreGate {
  readonly id: string;
  readonly description: string;
  /** Caps the overall rating at this letter while the gate is tripped. */
  readonly capRating?: string;
  /** Zeroes this score category for the reporting period. */
  readonly zeroCategory?: keyof ScoreWeights;
  /** Blocks expansion while tripped. */
  readonly blocksExpansion?: boolean;
}

export interface ScoreProfileDefinition extends DefinitionBase {
  readonly weights: ScoreWeights;
  readonly ratingBands: readonly RatingBand[];
  readonly gates: readonly ScoreGate[];
  /** Targets each environmental sub-metric is scored against. */
  readonly environmentalTargets: {
    readonly targetPue: number;
    readonly worstPue: number;
    readonly targetCue: number;
    readonly worstCue: number;
    readonly targetWue: number;
    readonly worstWue: number;
    readonly targetRenewable01: number;
    readonly targetHourlyMatch01: number;
    readonly targetDiversion01: number;
    readonly targetHeatReuse01: number;
  };
  /** Maximum share of the environmental score offsets may contribute. */
  readonly maxOffsetShare01: number;
}

export interface BalanceProfileDefinition extends DefinitionBase {
  /** Rack power at hardware power factor 1.0, kW. */
  readonly baseRackPowerKw: number;
  /** Compute units per rack at compute factor 1.0. */
  readonly baseRackComputeUnits: number;
  /** Rack purchase price at purchase factor 1.0, $. */
  readonly baseRackPurchaseCost: number;
  /** Embodied carbon per rack at embodied factor 1.0, kg CO2e. */
  readonly baseRackEmbodiedKgCo2e: number;
  /** Revenue per compute-unit-hour at revenue factor 1.0, $. */
  readonly baseRevenuePerComputeUnitHour: number;
  /** Cooling energy as a share of IT energy at cooling energy factor 1.0. */
  readonly baseCoolingOverhead01: number;
  /** Electrical conversion and distribution loss as a share of IT energy. */
  readonly baseElectricalLoss01: number;
  /** Auxiliary load (lighting, offices, security) as a share of IT energy. */
  readonly baseAuxiliaryLoad01: number;
  /** Cooling plant CapEx at cooling capex factor 1.0, $ per MW of IT load. */
  readonly baseCoolingCapexPerMw: number;
  /** Power asset CapEx at power capex factor 1.0, $ per MW. */
  readonly basePowerCapexPerMw: number;
  /** Grid carbon intensity at power carbon factor 1.0, kg CO2e/MWh. */
  readonly baseCarbonKgPerMwh: number;
  /** Energy price at variable cost factor 1.0, $/MWh. */
  readonly basePricePerMwh: number;
  /** Hall shell CapEx, $ per MW of IT capacity. */
  readonly baseHallCapexPerMw: number;
  /** Annual maintenance as a share of asset CapEx at maintenance factor 1.0. */
  readonly baseMaintenance01: number;
  /** Fully loaded annual salary at wage index 1.0, $. */
  readonly baseAnnualSalary: number;
  /** Racks one staff member can operate. */
  readonly racksPerStaff: number;
  /** Share of staff who can work as research specialists. */
  readonly researchStaffShare01: number;
  /** Inlet temperature above which hardware throttles, degrees C. */
  readonly thermalThrottleStartC: number;
  /** Inlet temperature at which hardware shuts down, degrees C. */
  readonly thermalShutdownC: number;
  /** Reference inlet temperature when cooling is keeping up, degrees C. */
  readonly referenceInletTempC: number;
  /** Interest rate on debt, annual, 0-1. */
  readonly annualInterestRate01: number;
  /** Asset depreciation, annual share of CapEx, 0-1. */
  readonly annualDepreciation01: number;
  /** E-waste landfill cost, $ per tonne. */
  readonly wasteLandfillCostPerTonne: number;
  /** Recycling cost, $ per tonne. Negative values would be revenue. */
  readonly wasteRecyclingCostPerTonne: number;
  /** Mass of one rack of hardware, tonnes. */
  readonly rackMassTonnes: number;
  /** Heat sale revenue, $ per MWh of recovered heat. */
  readonly heatSaleRevenuePerMwh: number;
  /** Insurance, annual share of asset value. */
  readonly annualInsurance01: number;
}

// ---------------------------------------------------------------------------
// Scenarios (spec chapter 13 walkthrough, chapter 14 golden scenarios)
// ---------------------------------------------------------------------------

export interface ScenarioObjective {
  readonly id: string;
  readonly description: string;
  /** Dotted path into the annual report, e.g. `environment.pue`. */
  readonly metric: string;
  readonly comparison: 'gt' | 'lt' | 'gte' | 'lte';
  readonly target: number;
  /** Campaign year by which the objective must hold. */
  readonly byYear: number;
}

export interface ScenarioDefinition extends DefinitionBase {
  readonly regionId: string;
  readonly startDate: string;
  readonly durationYears: number;
  readonly startingCash: number;
  readonly startingDebt: number;
  readonly startingReputation: number;
  readonly startingResearchPoints: number;
  readonly startingTechnologies: readonly string[];
  readonly scoreProfileId: string;
  readonly balanceProfileId: string;
  /** Events that may fire. Empty means every loaded event is eligible. */
  readonly eventIds: readonly string[];
  readonly objectives: readonly ScenarioObjective[];
  /** Minimum availability below which the reliability gate trips, 0-1. */
  readonly minimumAvailability01: number;
  /** Target IT capacity, MW. Drives the opening build plan. */
  readonly targetCapacityMw: number;
  readonly difficulty: 'easy' | 'normal' | 'hard';
}

/** Everything the importer produces, indexed by ID. */
export interface ContentRegistrySnapshot {
  readonly regions: ReadonlyMap<string, RegionDefinition>;
  readonly cooling: ReadonlyMap<string, CoolingTechnologyDefinition>;
  readonly power: ReadonlyMap<string, PowerSourceDefinition>;
  readonly hardware: ReadonlyMap<string, HardwareDefinition>;
  readonly workloads: ReadonlyMap<string, WorkloadDefinition>;
  readonly contracts: ReadonlyMap<string, ContractDefinition>;
  readonly technologies: ReadonlyMap<string, TechnologyDefinition>;
  readonly events: ReadonlyMap<string, EventDefinition>;
  readonly scenarios: ReadonlyMap<string, ScenarioDefinition>;
  readonly scoreProfiles: ReadonlyMap<string, ScoreProfileDefinition>;
  readonly balanceProfiles: ReadonlyMap<string, BalanceProfileDefinition>;
}
