# Modifier targets

Every technology, event and policy effect names a target on this list. A target
not on it resolves to its base value and the effect silently does nothing, so
new content should add its target here and to the system that reads it.

Convention: a target is read with a base of `1` when it is a multiplier and `0`
when it is an additive share.

## Cooling

| Target | Base | Read by | Meaning |
|---|---|---|---|
| `cooling.energyFactor` | 1 | cooling model | Multiplies cooling energy per unit of heat removed |
| `cooling.pumpEfficiency` | 1 | cooling model | Divides cooling energy; pump and distribution gains |
| `cooling.capacity` | 1 | cooling model | Multiplies rated cooling capacity |
| `cooling.densityKwPerRack` | 1 | operator, hall rating | Multiplies the rack density a technology supports |
| `cooling.heatReuse` | 1 | cooling model | Multiplies the recoverable share of rejected heat |
| `cooling.failureRate` | 1 | reliability | Multiplies cooling plant hazard |

## Hardware

| Target | Base | Read by | Meaning |
|---|---|---|---|
| `hardware.computePerRack` | 1 | allocation, operator | Multiplies compute units delivered per rack |
| `hardware.powerDraw` | 1 | IT power | Multiplies rack power draw |
| `hardware.heatOutput` | 1 | IT power | Multiplies heat produced per unit of power |
| `hardware.purchaseCost` | 1 | operator | Multiplies rack purchase price |
| `hardware.failureRate` | 1 | reliability | Multiplies rack hazard |
| `hardware.resaleValue` | 1 | operator | Multiplies resale recovered at retirement |

## Facility and power

| Target | Base | Read by | Meaning |
|---|---|---|---|
| `facility.electricalLoss` | 1 | power dispatch | Multiplies conversion and distribution loss |
| `facility.auxiliaryLoad` | 1 | power dispatch | Multiplies auxiliary load |
| `facility.maintenanceCost` | 1 | finance, maintenance | Multiplies maintenance spend |
| `facility.maintenanceComplexity` | 1 | maintenance, reliability, cooling | Raises staffing need and lowers maintenance quality |
| `facility.hallCapex` | 1 | operator | Multiplies hall shell cost |
| `facility.constructionSpeed` | 1 | construction | Multiplies build progress per week |
| `power.capex` | 1 | operator | Multiplies power asset cost |
| `power.renewableCapex` | 1 | operator | Multiplies renewable asset cost only |
| `power.failureRate` | 1 | reliability | Multiplies power asset hazard |
| `power.storageLife` | 1 | — | Reserved: storage replacement interval |
| `power.storageCapacity` | 1 | — | Reserved: usable storage capacity |
| `power.renewableUtilization` | 1 | — | Reserved: renewable output actually captured |
| `power.dieselRuntimeLimit` | 1 | power dispatch | Multiplies permitted generator run hours |
| `grid.available` | 1 | market | `set` to 0 forces a grid outage |

## Water, waste and environment

| Target | Base | Read by | Meaning |
|---|---|---|---|
| `water.freshwaterDemand` | 1 | cooling model | Multiplies site water draw |
| `water.priceMultiplier` | 1 | accounting | Multiplies water price |
| `water.withdrawalLimit` | 1 | accounting | Multiplies the permitted annual withdrawal |
| `waste.diversionRate` | 0 | operator | Adds to the share of e-waste diverted from landfill |
| `waste.ewasteGeneration` | 1 | operator | Multiplies mass generated at retirement |
| `environment.biodiversity` | 0 | — | Reserved: adds to site ecological condition |
| `environment.offsetCapacity` | 0 | — | Reserved: contracted carbon removal |
| `heat.reuseRevenue` | 1 | accounting | Multiplies heat sale revenue |

## Scheduling, market and company

| Target | Base | Read by | Meaning |
|---|---|---|---|
| `scheduling.flexibleShift01` | 0 | workload arrival | Share of flexible load that may be deferred |
| `scheduling.carbonAwareShift01` | 0 | workload arrival | Added deferral driven by carbon intensity |
| `scheduling.loadMigration01` | 0 | workload arrival | Added deferral from cross-region migration |
| `scheduling.forecastQuality01` | 0 | — | Reserved: forecast horizon quality |
| `market.contractPrice` | 1 | market, accounting | Multiplies contract pricing |
| `grid.demandResponseRevenue` | 0 | accounting | Payment rate for contracted flexibility |
| `network.transitCost` | 1 | finance | Multiplies network transit cost |
| `network.latency` | 1 | report | Multiplies latency to the demand centre |
| `research.pointsPerYear` | 1 | research | Multiplies research point generation |
| `company.reputationGain` | 1 | SLA | Multiplies reputation earned for delivered months |
| `community.trustGain` | 0 | community | Adds to daily trust movement |
| `security.incidentRate` | 1 | — | Reserved: security incident hazard |
| `policy.carbonPrice` | 1 | accounting | Multiplies the carbon price |
| `finance.operatingCost` | 1 | finance | Multiplies recurring operating cost |

Targets marked *Reserved* are defined and carried by content but not yet read by
a system. They validate and resolve; they simply have no effect until the system
that owns them is built.
