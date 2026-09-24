/**
 * Pipeline step 6: dispatch power sources and storage.
 *
 * Total facility demand is IT plus cooling plus conversion loss plus auxiliary
 * load (spec chapter 9). Cooling is evaluated here through the shared cooling
 * model so dispatch knows the real load; step 7 reuses the same numbers to
 * decide the thermal outcome.
 *
 * Merit order, cheapest and cleanest first:
 *   1. Must-take on-site renewables (spilled if they exceed demand)
 *   2. Firm clean contracts (nuclear, hydro, SMR)
 *   3. Storage discharge, when the hour is dirty or expensive or the grid is down
 *   4. Grid import, up to the interconnection limit
 *   5. Dispatchable generation (gas, hydrogen)
 *   6. Diesel, which exists for the hour everything else has failed
 */

import type { SimulationTick } from '../../core/clock.js';
import { assertFinite, clamp, clamp01 } from '../../core/math.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';
import type { PowerAssetState } from '../../state/types.js';
import { evaluateCooling } from '../cooling-model.js';
import { groupRackOutput } from '../era.js';

/**
 * Floor on the maintenance term of the cooling capacity formula. Neglect and
 * complexity make plant less effective; they never make it inert.
 */
const MIN_MAINTENANCE_QUALITY = 0.45;

/** Dispatch rank by source kind and cleanliness. Lower runs first. */
function meritRank(context: SimulationContext, asset: PowerAssetState): number {
  const def = context.registry.power(asset.definitionId, asset.instanceId);
  if (def.kind === 'storage') return 30;
  if (def.renewable) return 10;
  if (def.clean && def.dispatchability01 > 0.5) return 20;
  if (def.id === 'power.grid') return 40;
  if (def.id === 'power.diesel_backup') return 60;
  return 50;
}

export class PowerDispatchSystem implements ISimulationSystem {
  readonly name = 'power-dispatch';
  readonly order = 60;

  tick(tick: SimulationTick, context: SimulationContext): void {
    this.evaluateCoolingLoad(context);

    const scratch = context.scratch;
    const balance = context.balance;
    const lossShare = balance.baseElectricalLoss01 * context.modifiers.value('facility.electricalLoss', 1);
    const auxShare = balance.baseAuxiliaryLoad01 * context.modifiers.value('facility.auxiliaryLoad', 1);

    // Conversion loss applies to everything downstream of the switchgear.
    scratch.electricalLossKw = (scratch.itPowerKw + scratch.coolingPowerKw) * lossShare;
    scratch.auxiliaryKw = scratch.itPowerKw * auxShare;
    scratch.facilityPowerKw = assertFinite(
      scratch.itPowerKw + scratch.coolingPowerKw + scratch.electricalLossKw + scratch.auxiliaryKw,
      'facility power',
    );

    let remainingMwh = (scratch.facilityPowerKw / 1000) * tick.hours;
    if (remainingMwh <= 0) return;

    const assets = context.state.facilities
      .flatMap((f) => f.powerAssets)
      .filter((a) => a.available && a.constructionProgress01 >= 1)
      .sort((a, b) => meritRank(context, a) - meritRank(context, b) || a.instanceId.localeCompare(b.instanceId));

    let surplusMwh = 0;

    for (const asset of assets) {
      const def = context.registry.power(asset.definitionId, asset.instanceId);
      if (def.kind === 'storage') continue; // handled after the must-take pass

      const availableMwh = this.availableEnergy(context, asset, tick.hours);
      if (availableMwh <= 0) continue;

      if (def.renewable) {
        // Must-take: it generates whether or not the facility needs it.
        const used = Math.min(availableMwh, remainingMwh);
        surplusMwh += availableMwh - used;
        if (used > 0) this.draw(context, asset, used);
        remainingMwh -= used;
        continue;
      }

      if (remainingMwh <= 0) continue;
      if (def.id === 'power.diesel_backup' && context.state.world.market.gridAvailable) {
        continue; // diesel only runs when the grid is gone
      }
      const used = Math.min(availableMwh, remainingMwh);
      if (used > 0) {
        this.draw(context, asset, used);
        asset.runHoursThisYear += tick.hours * (used / Math.max(availableMwh, 1e-9));
      }
      remainingMwh -= used;
    }

    remainingMwh = this.dispatchStorage(context, assets, remainingMwh, surplusMwh, tick.hours);

    scratch.unservedEnergyMwh = Math.max(0, remainingMwh);
    if (scratch.unservedEnergyMwh > 1e-9) {
      context.diagnostic('power.unserved',
        'Facility demand exceeded available supply; load was shed',
        { tick: tick.index, unservedMwh: Number(scratch.unservedEnergyMwh.toFixed(5)) });
    }
  }

  /** Runs the cooling model for every hall and sums the result. */
  private evaluateCoolingLoad(context: SimulationContext): void {
    const scratch = context.scratch;
    const weather = context.state.world.weather;
    const heatExport = context.state.research.capabilities.includes('heat_export');
    const loadShares = this.hallLoadShares(context);

    let coolingKw = 0;
    let waterM3PerHour = 0;
    let recoverableKw = 0;
    let weightedShortfall = 0;
    let totalHeat = 0;

    for (const facility of context.state.facilities) {
      // Maintenance quality degrades cooling capacity but can never eliminate
      // it. A subtractive form (2 - complexity) reaches zero once enough
      // complexity-adding technology is researched, which would make a
      // well-researched operator's plant stop removing heat entirely - a
      // research reward that destroys the facility.
      const complexity = Math.max(1, context.modifiers.value('facility.maintenanceComplexity', 1));
      const maintenance01 = clamp(
        clamp01(1 - facility.maintenanceBacklog * 0.02) / complexity,
        MIN_MAINTENANCE_QUALITY, 1,
      );
      for (const hall of facility.halls) {
        if (hall.constructionProgress01 < 1) continue;
        const shareOfIt = loadShares.get(hall.instanceId) ?? 0;
        const hallHeatKw = scratch.heatLoadKw * shareOfIt;
        const hallItKw = scratch.itPowerKw * shareOfIt;
        if (hallHeatKw <= 0) continue;

        const result = evaluateCooling({
          cooling: context.registry.cooling(hall.coolingId, hall.instanceId),
          heatLoadKw: hallHeatKw,
          itPowerKw: hallItKw,
          ratedCoolingKw: hall.coolingFailed ? hall.ratedCoolingKw * 0.35 : hall.ratedCoolingKw,
          condition01: hall.condition01,
          maintenance01,
          dryBulbC: weather.dryBulbC,
          wetBulbC: weather.wetBulbC,
          contamination01: context.region.climate.contamination01,
          elevationM: context.region.climate.elevationM,
          baseCoolingOverhead01: context.balance.baseCoolingOverhead01,
          modifiers: context.modifiers,
          heatExportAvailable: heatExport,
        });

        coolingKw += result.coolingPowerKw;
        waterM3PerHour += result.waterM3PerHour;
        recoverableKw += result.recoverableHeatKw;
        weightedShortfall += result.shortfall01 * hallHeatKw;
        totalHeat += hallHeatKw;
      }
    }

    scratch.coolingPowerKw = coolingKw;
    scratch.coolingWaterM3 = waterM3PerHour;
    scratch.recoverableHeatKw = recoverableKw;
    scratch.coolingShortfall01 = totalHeat > 0 ? clamp01(weightedShortfall / totalHeat) : 0;
  }

  /**
   * Each hall's share of the facility IT load, by installed rated power. Racks
   * in one hall cannot be cooled by another hall's plant, so load has to be
   * split before the cooling model runs. Computed in one pass: doing it per
   * hall would rescan every hall for every hall.
   */
  private hallLoadShares(context: SimulationContext): Map<string, number> {
    const hallKw = new Map<string, number>();
    let total = 0;
    for (const facility of context.state.facilities) {
      for (const hall of facility.halls) {
        if (hall.constructionProgress01 < 1) continue;
        let kw = 0;
        for (const group of hall.rackGroups) {
          kw += Math.max(0, group.count - group.failedCount)
            * groupRackOutput(context, group).powerKw;
        }
        hallKw.set(hall.instanceId, kw);
        total += kw;
      }
    }
    if (total <= 0) return new Map();
    const shares = new Map<string, number>();
    for (const [id, kw] of hallKw) shares.set(id, kw / total);
    return shares;
  }

  /** Energy this asset can deliver over `hours`, given weather and resource quality. */
  private availableEnergy(context: SimulationContext, asset: PowerAssetState, hours: number): number {
    const def = context.registry.power(asset.definitionId, asset.instanceId);
    const quality = context.region.resourceQuality[def.id] ?? def.dispatchability01;
    const condition = clamp01(asset.condition01);

    if (def.id === 'power.grid') {
      if (!context.state.world.market.gridAvailable) return 0;
      return Math.min(asset.capacityMw, context.region.grid.capacityMw) * hours * condition;
    }
    if (def.id === 'power.solar_rooftop' || def.id === 'power.solar_ground') {
      return asset.capacityMw * context.state.world.weather.solarFactor01 * hours * condition;
    }
    if (def.id === 'power.wind_contract') {
      return asset.capacityMw * quality * context.state.world.weather.windFactor01 * 2 * hours * condition;
    }
    if (def.id === 'power.diesel_backup') {
      // Runtime restrictions cap diesel hours per year.
      const limit = context.modifiers.value('power.dieselRuntimeLimit', 1) * 200;
      if (asset.runHoursThisYear >= limit) return 0;
    }
    if (def.renewable) {
      return asset.capacityMw * quality * hours * condition;
    }
    return asset.capacityMw * def.dispatchability01 * hours * condition;
  }

  private draw(context: SimulationContext, asset: PowerAssetState, mwh: number): void {
    const key = asset.definitionId;
    const current = context.scratch.energyBySource.get(key) ?? 0;
    context.scratch.energyBySource.set(key, current + mwh);
  }

  /**
   * Storage discharges to cover what nothing cheaper could, and charges from
   * spilled renewable output or, when it has headroom, from a cheap clean grid
   * hour. The charge-from-grid path is what makes storage worth owning on a
   * dirty grid: it moves clean hours into dirty ones.
   */
  private dispatchStorage(
    context: SimulationContext,
    assets: readonly PowerAssetState[],
    remainingMwh: number,
    surplusMwh: number,
    hours: number,
  ): number {
    const storage = assets.filter((a) => context.registry.power(a.definitionId, a.instanceId).kind === 'storage');
    if (storage.length === 0) return remainingMwh;

    let outstanding = remainingMwh;
    for (const asset of storage) {
      if (outstanding <= 0) break;
      const def = context.registry.power(asset.definitionId, asset.instanceId);
      const maxDischargeMwh = asset.capacityMw * hours;
      const deliverable = Math.min(asset.storedMwh, maxDischargeMwh, outstanding);
      if (deliverable <= 0) continue;
      asset.storedMwh -= deliverable;
      asset.cycles += asset.usableMwh > 0 ? deliverable / asset.usableMwh : 0;
      asset.usableMwh *= 1 - def.degradationPerCycle01;
      this.draw(context, asset, deliverable);
      outstanding -= deliverable;
    }

    // Charging: spilled renewables first, then a cheap hour on the grid.
    const market = context.state.world.market;
    const cheapHour = market.energyPricePerMwh < context.region.grid.basePricePerMwh * 0.85;
    const cleanHour = market.gridCarbonKgPerMwh < context.region.grid.baseCarbonKgPerMwh * 0.85;

    for (const asset of storage) {
      const def = context.registry.power(asset.definitionId, asset.instanceId);
      const headroom = Math.max(0, asset.usableMwh - asset.storedMwh);
      if (headroom <= 0) continue;
      const maxChargeMwh = Math.min(asset.capacityMw * hours, headroom);

      const fromSurplus = Math.min(surplusMwh, maxChargeMwh);
      if (fromSurplus > 0) {
        asset.storedMwh += fromSurplus * def.roundTripEfficiency01;
        surplusMwh -= fromSurplus;
      }
      const stillFree = maxChargeMwh - fromSurplus;
      if (stillFree > 0 && market.gridAvailable && (cheapHour || cleanHour) && outstanding <= 0) {
        // Charging from the grid is a real draw and is metered as one.
        const gridAsset = assets.find((a) => a.definitionId === 'power.grid');
        if (gridAsset) {
          asset.storedMwh += stillFree * def.roundTripEfficiency01;
          this.draw(context, gridAsset, stillFree);
        }
      }
    }

    return outstanding;
  }
}
