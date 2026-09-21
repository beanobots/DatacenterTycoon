# Architecture

This is the headless simulation engine for DatacenterTycoon, built to the
Master Game Design and Implementation Specification. It follows the chapter 11
layering, with one substitution: the spec targets Unity and C#, and this
implementation is TypeScript on Node. The content layer — JSON definitions plus
JSON Schemas — is the portable part and transfers to a Unity project unchanged;
the simulation would be ported.

```
Content      content/**.json + content/schemas/*.schema.json
   ↓
Import       src/content/importer.ts      DTO parsing, schema validation, unit normalisation
             src/content/validator.ts     cross-reference validation
   ↓
Definitions  src/definitions/types.ts     immutable, deep-frozen, addressed by permanent ID
             src/content/registry.ts      lookups that throw with the missing ID named
   ↓
State        src/state/types.ts           mutable runtime state, plain serialisable data
             src/state/campaign.ts        scenario + seed → starting state
   ↓
Simulation   src/sim/engine.ts            clock, ordered systems, tick loop
             src/sim/systems/*.ts         one file per pipeline step
             src/sim/scoring.ts           the chapter 7 master score
   ↓
Presentation src/cli/main.ts              the only consumer; reads snapshots and reports
```

Nothing beneath `src/cli` imports anything that renders. `SimulationEngine`
runs to completion with no scene, no assets and no I/O beyond reading content.

## The tick pipeline

Chapter 9 fixes the order. Each system declares an `order` and the engine sorts
once at construction, so the sequence is a property of this list rather than of
registration order.

| Order | System | Chapter 9 step |
|---|---|---|
| 10 | `weather` | 1. Advance clock and sample weather |
| 20 | `market` | 2. Update price, grid carbon, grid availability |
| 30 | `workload-arrival` | 3. Generate workload arrivals and deadlines |
| 40 | `allocation` | 4. Allocate workloads to compatible hardware |
| 50 | `it-power` | 5. Calculate IT power and heat |
| 60 | `power-dispatch` | 6. Dispatch power sources and storage |
| 70 | `cooling-dispatch` | 7. Dispatch cooling and evaluate thermal limits |
| 80 | `reliability` | 8. Apply throttling, shutdowns and failure hazards |
| 90 | `accounting` | 9. Account for water, carbon, waste, revenue and cost |
| 100 | `sla` | 10. Resolve SLA performance and emit diagnostics |
| 105–128 | `maintenance`, `construction`, `events`, `research`, `finance`, `community`, `contract-market` | longer cadences (chapter 3) |
| 130 | `operator` | the decision-maker standing in for player input |
| 200 | `annual-scoring` | closes and scores the year |

The default tick is 15 simulated minutes. `TickCadence` marks which period
boundaries a tick closes, so a system asks "is this the last tick of the month?"
rather than keeping its own counters.

### Two deliberate couplings

**Cooling is evaluated during power dispatch.** Step 6 needs the cooling load to
know what to dispatch, and step 7 needs the same numbers to decide the thermal
outcome. Rather than compute it twice or reorder the spec's pipeline, both call
the pure `src/sim/cooling-model.ts`.

**Throttling lags by one tick.** Thermal shortfall is detected at step 7 and
reduces allocation at step 4 of the *following* tick. At 15 simulated minutes
that lag is close to how fast a real hall's inlet temperature moves, and it
keeps the pipeline a single forward pass rather than an iterative solve.

## Determinism

Chapter 9's rules, and how each is met:

- **Fixed simulation order** — systems sorted by `order` at construction.
- **Seeded independent streams by subsystem** — `src/core/rng.ts` gives each of
  nine subsystems its own counter-based stream. Streams are `{seed, counter}`
  pairs over splitmix64, so drawing from one can never shift another's sequence,
  and a stream restores without replaying history.
- **Stream state persisted in saves** — `randomStreams` is part of `GameState`.
- **Never use frame delta as economic time** — the clock counts whole ticks of
  fixed length; wall time never enters the simulation.
- **Accumulated energy and water, not averaged ratios** — every system adds to a
  `PeriodAccumulator`; PUE, CUE and WUE are divided once, at report time, from
  the year's totals.
- **Diagnostic snapshots around failures and score changes** — every system
  emits through `context.diagnostic`.

A campaign is reproducible from `(scenarioId, campaignSeed, content)` alone.
`tests/simulation.test.ts` asserts this, including that results do not depend on
how ticks are batched.

## Modifiers

Technologies, events and policies all express effects as
`{target, operation, value, priority}`. `ModifierStack` resolves a dotted target
to a number by applying its modifiers lowest priority first, tie-broken by
source ID so load order can never change an outcome. `describe()` returns the
contributing steps, which is what lets a score or a cost be decomposed for the
player (acceptance criterion 7).

Targets are listed in `docs/MODIFIER-TARGETS.md`.

## Content

Definitions are immutable and versioned; runtime state refers to them by
permanent string ID (chapter 10). The importer deep-freezes everything it
produces, so no system can mutate content at runtime.

Import collects issues rather than throwing, so one pass reports every problem.
A campaign refuses to start while any error remains. The split between error and
warning follows chapter 10's table.

## The operator policy

`src/sim/operator.ts` is **not** part of the simulation's rules. It is a stand-in
for player input so a headless campaign does something: it builds halls, buys
racks, signs contracts, chooses research and invests in power. Four presets —
balanced, green, hyperscaler, lean — weight the same decisions differently,
which is what lets the golden scenarios check that no single choice dominates.

A UI would replace it. Nothing else in the simulation depends on it.
