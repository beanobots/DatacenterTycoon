# DatacenterTycoon — simulation engine

A headless, deterministic simulation engine for **DatacenterTycoon**, a
data-center city-builder about compute, energy, cooling, water, carbon,
hardware, reliability and community impact.

Built to the *Master Game Design and Implementation Specification*. The spec
targets Unity and C#; this implementation is TypeScript on Node. The content
layer — JSON definitions plus JSON Schemas — is the portable part and transfers
to a Unity project unchanged.

## Quick start

```bash
npm install
npm run validate          # validate all content against its schemas
npm test                  # unit, simulation and golden-scenario tests
npm run dct -- scenarios  # list the playable scenarios
npm run dct -- run --scenario scenario.dry_grid --years 10
```

## What it does

```
$ npm run dct -- run --scenario scenario.cold_cloud --years 8 --seed golden

Cold Cloud Facility - Nordic Cold Coast
seed "golden", strategy "balanced", 8 years, 280512 ticks in 10.4s

year      IT cap     PUE    CUE     WUE   avail      revenue    mgn     cash  trust     score
------------------------------------------------------------------------------------------------
2025    0.72 MW   1.532     67   0.000   99.790%      4.0M   -87%     173M     21    C 58.8
2026    0.80 MW   1.510     59   0.000  100.000%      6.3M   -37%     160M     21    B 64.3
2027    0.90 MW   1.481     59   0.000  100.000%     10.0M    36%     151M     30    B 70.9
2028    1.11 MW   1.477     56   0.000  100.000%     11.9M    27%     141M     23    B 69.4
2029    1.27 MW   1.470     55   0.000   99.966%     18.4M    54%     135M     23    B 70.5
2030    1.56 MW   1.459     52   0.000  100.000%     29.7M    64%     132M     24    B 73.1
2031    1.41 MW   1.457     47   0.000  100.000%     30.6M    58%     124M     45    B 72.8
2032    1.58 MW   1.346     41   0.401  100.000%     26.2M    53%     114M     60    A 77.8

Objectives
  [ ] Reach a PUE of 1.20 or better.  (environment.pue = 1.3456, target lte 1.2)
  [x] Export at least 15% of facility energy as useful heat.  (environment.erf01 = 0.326)
  [ ] Reach 20 MW of commissioned IT capacity.  (capacity.itCapacityMw = 1.5818)
```

Every number decomposes. `--diagnostics 40` prints the event stream behind it —
grid outages, thermal throttling, rack failures, retrofits, research, SLA
breaches — each with the values that produced it.

## Playing it

`npm run build:web` bundles the engine for the browser and writes `web/`. Serve
that directory and open it, or use the published artifact. Each month the
simulation stops and hands you the decisions the autopilot would otherwise make:
research, contracts, hardware, halls, cooling retrofits and power. Untick a
category's autopilot to take it over, tick it to hand it back.

## Commands

| Command | What it does |
|---|---|
| `dct validate` | Validates every content file against its schema and cross-references |
| `dct scenarios` | Lists scenarios with their objectives |
| `dct run --scenario <id>` | Runs a campaign and prints annual reports |
| `dct golden` | Runs every scenario once — the regression sweep |

Useful flags: `--seed`, `--years`, `--strategy`, `--out <file.json>` for
telemetry, `--save`/`--load` for save round-trips, `--diagnostics <n>`.

## What is implemented

**Content pipeline** — 146 JSON definitions across 11 kinds, 15 JSON Schemas,
an importer that collects every problem in one pass, and a cross-reference
validator implementing chapter 10's error and warning table (unknown
references, dependency cycles, unit incompatibilities, unnormalised score
weights, unreachable and dominated content).

**The full chapter 9 tick pipeline**, all ten steps, at 15 simulated minutes per
tick: weather → market → workload arrivals → allocation → IT power and heat →
power dispatch → cooling dispatch → reliability hazards → accounting → SLA.
Plus maintenance, construction, events, research, finance, community and the
contract market on their chapter 3 cadences.

**The physics the design pillars rest on** — a psychrometric cooling model where
technologies derate against dry-bulb or wet-bulb temperature by their own
sensitivity; power dispatch by merit order with storage and hourly clean-energy
matching; bathtub-curve failure hazards scaled by age, condition, thermal stress
and load; independent accounting of energy, carbon, water, waste and habitat.

**Chapter 12's balance tables** as data: 9 cooling technologies, 11 power
sources, 12 hardware families, 8 workloads, 69 technologies across all ten
branches, 17 events, 10 contract archetypes, 4 regions, 4 scenarios.

**The chapter 7 master score** with all five weighted categories, six rating
bands, the anti-exploit gates, and a per-component decomposition for every
number.

**A playable turn loop.** `src/sim/player.ts` enumerates what the operator could
do this month and applies the choice; `src/sim/operator.ts` is now an operations
layer with an optional heuristic on top, switchable per decision category. A
player and the autopilot call the same operations, so a hall the player builds
is priced, aged and failed exactly like one the heuristic builds. The browser
build in `web/` is the game: advance a month, read what happened, decide.

**Determinism and saves** — nine independent counter-based random streams,
persisted stream state, content hashing, and save migrations across three
schema versions.

## Design notes worth knowing

- **Definitions are immutable.** The importer deep-freezes everything; runtime
  state refers to content by permanent string ID.
- **Reports are built from accumulated totals, never averaged ratios.** PUE, CUE
  and WUE are divided once, at year end, and are `null` rather than infinite
  when IT energy is zero.
- **Reserved capacity and running work are separate quantities.** A customer
  reserving compute occupies it whether or not their jobs run; utilisation
  decides the power those units draw. That is what makes a disaster-recovery
  tenant cheap to host and an AI training cluster expensive.
- **The operator is an autopilot, not a rule.** `src/sim/operator.ts` holds the
  mechanics of running the business plus a heuristic that decides when to use
  them. Hand any category to the player and the heuristic stops acting on it;
  the mechanics are unchanged. Four strategy presets weight the heuristic's
  judgement differently.
- **Every action states its trade-off.** The first design pillar is that a
  technology improves at most two outcomes while adding a cost or constraint.
  That is only a pillar if the player sees the other half before committing, so
  the action list carries it as text.

See `docs/ARCHITECTURE.md` for the layering and `docs/MODIFIER-TARGETS.md` for
the effect namespace that technologies, events and policies write against.

## Status and known gaps

The engine runs 35-year campaigns deterministically and every acceptance
criterion in chapter 14 that does not require a UI is covered by tests.

**Balance is a prototype, as the spec intends.** Chapter 12 states its values
are "prototype gameplay values... they require simulation testing and iterative
playtesting". Two open items are worth naming:

*Capacity growth.* The operator policy grows more slowly than the scenarios'
megawatt targets assume, so capacity objectives (12 MW desert, 20 MW cold) are
not met inside a campaign even when the operation is otherwise healthy. The
financial, reliability and environmental loops behave correctly; what needs
iteration is the capital-allocation policy and the per-MW cost and revenue bases
it works against. `--out` telemetry and the `build.*` / `finance.*` diagnostics
exist to drive that work.

*A design question the weights raise.* On the fossil-grid scenario an operator
can reach an A ("Industry Leader") with a carbon intensity near 570 kg/MWh,
because the environmental category scores it correctly at 41/100 but is only
25% of the total and the other four categories are strong. That follows chapter
7's weights and bands exactly, and chapter 7's anti-exploit gates contain no
carbon floor — so this is faithful to the spec rather than a bug. Whether a
carbon gate belongs alongside the insolvency and permit gates is a design call,
not an implementation one.

Not yet built: multi-region campaigns and load migration between them, the
policy definition kind (schema exists, no system reads it), competitor
operators, and the presentation layer.
