/**
 * Annual scoring: closes the year, scores it, and starts the next one.
 *
 * Runs last in the tick so every other system has already booked its year.
 * Spec chapter 3 puts the sustainability report, overall score, policy review
 * and victory progress on the annual cadence.
 */

import type { SimulationTick } from '../../core/clock.js';
import type { ISimulationSystem, SimulationContext } from '../context.js';
import { buildAnnualReport, type AnnualReport } from '../report.js';
import { scoreYear } from '../scoring.js';
import { createAccumulator } from '../../state/types.js';

export class AnnualScoringSystem implements ISimulationSystem {
  readonly name = 'annual-scoring';
  readonly order = 200;

  /** Reports are kept alongside scores so the CLI can print either. */
  readonly reports: AnnualReport[] = [];

  tick(tick: SimulationTick, context: SimulationContext): void {
    context.state.meta.campaignYear = tick.year;
    if (!tick.cadence.year) return;

    // The year that just closed is the one before the tick that crossed into
    // January.
    const closingYear = tick.year - 1;
    const report = buildAnnualReport(context, closingYear, context.state.year);
    const score = scoreYear(report, context.scoreProfile, {
      minimumAvailability01: context.scenario.minimumAvailability01,
      gateFlags: context.state.gateFlags,
    });

    this.reports.push(report);
    context.state.annualScores.push(score);
    context.diagnostic('score.annual',
      `${closingYear}: ${score.rating} (${score.overall.toFixed(1)}) - ${score.label}`,
      {
        tick: tick.index, year: closingYear, overall: score.overall, rating: score.rating,
        pue: report.environment.pue ?? -1,
        cue: report.environment.cue ?? -1,
        wue: report.environment.wue ?? -1,
        availability01: report.reliability.availability01,
        itCapacityMw: report.capacity.itCapacityMw,
      });

    context.state.year = createAccumulator();
    // Gates that describe a condition during the reporting period clear at the
    // year boundary; gates that describe a standing state are re-raised by the
    // system that owns them.
    context.state.gateFlags = context.state.gateFlags.filter((gate) =>
      gate === 'gate.community_trust');
  }
}
