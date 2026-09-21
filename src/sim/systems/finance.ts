/**
 * Finance: salaries, maintenance, insurance, interest, tax, and the period roll.
 *
 * Spec chapter 3 cadences: salaries and research accounting monthly; debt,
 * taxes and financial reports quarterly. This system also rolls the hourly
 * accumulator into the month and year, which is what keeps the reports built
 * from accumulated totals rather than averaged ratios (chapter 9).
 */

import type { SimulationTick } from '../../core/clock.js';
import { clamp } from '../../core/math.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';
import { accumulate, createAccumulator, totalCost, totalRevenue } from '../../state/types.js';

export class FinanceSystem implements ISimulationSystem {
  readonly name = 'finance';
  readonly order = 120;

  tick(tick: SimulationTick, context: SimulationContext): void {
    const state = context.state;
    const company = state.company;

    if (tick.cadence.hour) {
      // Everything the pipeline charged this hour becomes cash now, so the
      // operator's monthly decisions see a current balance.
      const hour = state.hour;
      company.cash += totalRevenue(hour) - totalCost(hour);
      company.lifetimeRevenue += totalRevenue(hour);
      company.lifetimeCost += totalCost(hour);
      company.lifetimeCapex += hour.capex;
      accumulate(state.month, hour);
      accumulate(state.year, hour);
      state.hour = createAccumulator();
    }

    if (tick.cadence.month) {
      this.chargeStaff(context);
      this.chargeFixedCosts(context);
      this.updateCompanyLevel(context);
    }

    if (tick.cadence.quarter) {
      this.serviceDebt(context);
    }

    if (tick.cadence.year) {
      this.settleTax(context);
      for (const facility of state.facilities) {
        for (const asset of facility.powerAssets) asset.runHoursThisYear = 0;
      }
      state.world.waterWithdrawnYearM3 = 0;
    }

    if (company.cash < 0 && !state.gateFlags.includes('gate.critical_insolvency')) {
      // Cash below zero draws on a revolving facility; the gate records that it
      // happened, because the chapter 7 rule caps the rating at C regardless of
      // how the year ends.
      state.gateFlags.push('gate.critical_insolvency');
      context.diagnostic('finance.insolvency', 'Cash balance went negative; drawing on credit', {
        tick: tick.index, cash: Math.round(company.cash), debt: Math.round(company.debt),
      });
    }
    if (company.cash < 0) {
      company.debt += -company.cash;
      company.cash = 0;
    }
  }

  private chargeStaff(context: SimulationContext): void {
    const state = context.state;
    const rackCount = state.facilities
      .flatMap((f) => f.halls)
      .flatMap((h) => h.rackGroups)
      .reduce((total, group) => total + group.count, 0);

    const complexity = context.modifiers.value('facility.maintenanceComplexity', 1);
    const required = Math.max(6, Math.ceil((rackCount / context.balance.racksPerStaff) * complexity));
    // Hiring lags demand; staff arrive over months, not instantly.
    const hiringRate = context.region.people.laborSupply01;
    state.company.staffCount += (required - state.company.staffCount) * clamp(hiringRate, 0.1, 1) * 0.35;
    state.company.staffCount = Math.max(6, state.company.staffCount);

    const monthlySalary = context.balance.baseAnnualSalary * context.region.people.wageIndex / 12;
    state.hour.staffCost += state.company.staffCount * monthlySalary;
  }

  private chargeFixedCosts(context: SimulationContext): void {
    const state = context.state;
    const assetValue = this.assetValue(context);
    const operatingCostModifier = context.modifiers.value('finance.operatingCost', 1);

    // Scheduled maintenance as a share of asset value, on top of the repair
    // spend the maintenance system books.
    const maintenance = assetValue * context.balance.baseMaintenance01 / 12
      * context.modifiers.value('facility.maintenanceCost', 1) * operatingCostModifier;
    state.hour.maintenanceCost += maintenance;

    const insurance = assetValue * context.balance.annualInsurance01 / 12;
    state.hour.otherCost += insurance;

    // Network transit, billed on installed IT capacity.
    const itMw = this.installedItMw(context);
    const transit = itMw * 400 * context.region.connectivity.transitCostPerGbpsMonth / 1000
      * context.modifiers.value('network.transitCost', 1);
    state.hour.otherCost += transit;
  }

  private serviceDebt(context: SimulationContext): void {
    const state = context.state;
    const quarterlyRate = context.balance.annualInterestRate01 / 4;
    // Lenders price risk off reputation: a trusted operator borrows cheaper.
    const riskPremium = 1 + (60 - Math.min(60, state.company.reputation)) / 100;
    const interest = state.company.debt * quarterlyRate * riskPremium;
    state.hour.otherCost += interest;

    // Principal repayment: a slice of the balance each quarter when solvent.
    // It moves cash directly and is NOT an operating cost - booking it as one
    // would understate margin and double-charge a balance-sheet movement.
    if (state.company.cash > state.company.debt * 0.05) {
      const repayment = state.company.debt * 0.02;
      state.company.debt -= repayment;
      state.company.cash -= repayment;
    }
  }

  private settleTax(context: SimulationContext): void {
    const state = context.state;
    const year = state.year;
    const profit = totalRevenue(year) - totalCost(year)
      - this.assetValue(context) * context.balance.annualDepreciation01;
    if (profit <= 0) return;
    state.hour.otherCost += profit * context.region.policy.taxRate01;
  }

  /** Replacement value of every commissioned asset, for maintenance and insurance. */
  private assetValue(context: SimulationContext): number {
    const balance = context.balance;
    let value = 0;
    for (const facility of context.state.facilities) {
      for (const hall of facility.halls) {
        const cooling = context.registry.cooling(hall.coolingId, hall.instanceId);
        value += (hall.ratedCoolingKw / 1000) * balance.baseCoolingCapexPerMw * cooling.capexFactor;
        for (const group of hall.rackGroups) {
          const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
          value += group.count * balance.baseRackPurchaseCost * hardware.purchaseFactor;
        }
      }
      for (const asset of facility.powerAssets) {
        const definition = context.registry.power(asset.definitionId, asset.instanceId);
        value += asset.capacityMw * balance.basePowerCapexPerMw * definition.capexFactor;
      }
    }
    return value;
  }

  private installedItMw(context: SimulationContext): number {
    let kw = 0;
    for (const facility of context.state.facilities) {
      for (const hall of facility.halls) {
        for (const group of hall.rackGroups) {
          const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
          kw += group.count * context.balance.baseRackPowerKw * hardware.powerFactor;
        }
      }
    }
    return kw / 1000;
  }

  private updateCompanyLevel(context: SimulationContext): void {
    // Company level gates high-tier research; it tracks installed capacity and
    // standing rather than cash, so a leveraged operator cannot buy seniority.
    const itMw = this.installedItMw(context);
    const level = Math.floor(Math.min(6,
      Math.log2(Math.max(1, itMw)) * 0.9 + context.state.company.reputation / 40));
    context.state.company.companyLevel = Math.max(context.state.company.companyLevel, level);
  }
}
