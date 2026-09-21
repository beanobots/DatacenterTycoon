/**
 * The master score (spec chapter 7).
 *
 *   OverallScore = Financial*0.20 + Reliability*0.25 + Environment*0.25
 *                + Customer*0.15 + Social*0.15
 *
 * Every category returns its components as well as its score, so the UI's
 * explanation drawer can decompose any number back to the values that produced
 * it - acceptance criterion 7.
 *
 * The anti-exploit gates are applied after the weighted total, because they cap
 * the RATING rather than the score: a 92-point year with an unresolved safety
 * incident is still a C.
 */

import { clamp, clamp01, remap } from '../core/math.js';
import type { ScoreProfileDefinition, ScoreWeights } from '../definitions/types.js';
import type { AnnualScore, ScoreCategoryDetail } from '../state/types.js';
import type { AnnualReport } from './report.js';

/** Scores a value where lower is better, against a target and a floor. */
function scoreLowerBetter(value: number | null, target: number, worst: number): number {
  if (value === null) return 50; // no IT energy: nothing to judge, so neutral
  return clamp(remap(value, target, worst, 100, 0), 0, 100);
}

/** Scores a value where higher is better, against a target. */
function scoreHigherBetter(value: number, target: number): number {
  if (target <= 0) return 100;
  return clamp01(value / target) * 100;
}

export function scoreYear(
  report: AnnualReport,
  profile: ScoreProfileDefinition,
  context: { minimumAvailability01: number; gateFlags: readonly string[] },
): AnnualScore {
  const targets = profile.environmentalTargets;

  // --- Financial: margin, runway, debt coverage, diversity, utilisation -----
  const financialComponents = {
    margin: clamp(remap(report.financial.operatingMargin01, -0.25, 0.35, 0, 100), 0, 100),
    runway: clamp(remap(report.financial.runwayMonths, 0, 18, 0, 100), 0, 100),
    debtCoverage: clamp(remap(report.financial.debtCoverage, 0, 4, 0, 100), 0, 100),
    diversity: report.financial.revenueDiversity01 * 100,
    utilization: clamp(remap(report.reliability.availability01, 0.8, 1, 0, 100), 0, 100),
  };

  // --- Reliability: SLA, availability, recovery, preventable, reserves ------
  const reliabilityComponents = {
    // Availability is scored against the last three nines, where the whole
    // reliability conversation actually happens.
    availability: clamp(remap(report.reliability.availability01, 0.98, 0.9999, 0, 100), 0, 100),
    slaCompliance: report.reliability.slaCompliance01 * 100,
    recovery: clamp(remap(report.reliability.degradedTickShare01, 0.05, 0, 0, 100), 0, 100),
    preventableIncidents: clamp(remap(report.reliability.preventableIncidents, 12, 0, 0, 100), 0, 100),
    reserves: clamp(remap(report.reliability.reserveMargin01, 0, 0.6, 0, 100), 0, 100),
  };

  // --- Environmental: carbon, PUE, clean match, water, waste, habitat -------
  // Offsets are scored separately and capped, so they cannot carry the
  // category (chapter 14: "Offsets cannot independently maximize environmental
  // score"). The carbon component is scored on GROSS operational intensity.
  const grossCue = report.environment.cue;
  const offsetShare = report.environment.operationalCarbonTonnes > 0
    ? clamp01(report.environment.offsetTonnes / report.environment.operationalCarbonTonnes)
    : 0;
  const environmentalComponents = {
    carbon: scoreLowerBetter(grossCue, targets.targetCue, targets.worstCue),
    pue: scoreLowerBetter(report.environment.pue, targets.targetPue, targets.worstPue),
    water: scoreLowerBetter(report.environment.wue, targets.targetWue, targets.worstWue),
    renewable: scoreHigherBetter(report.environment.ref01, targets.targetRenewable01),
    hourlyMatch: scoreHigherBetter(report.environment.hourlyMatch01, targets.targetHourlyMatch01),
    circularity: scoreHigherBetter(report.environment.wasteDiversion01, targets.targetDiversion01),
    heatReuse: scoreHigherBetter(report.environment.erf01, targets.targetHeatReuse01),
    habitat: clamp01(report.environment.biodiversity / 100) * 100,
    offsets: offsetShare * 100 * profile.maxOffsetShare01,
  };

  // --- Customer: completion, renewal, latency, price, compliance ------------
  const customerComponents = {
    completion: report.customer.completion01 * 100,
    latency: report.customer.latencySatisfaction01 * 100,
    reputation: report.customer.reputation,
    retention: clamp01(report.customer.contractsActive / 4) * 100,
  };

  // --- Social: trust, jobs, grid cooperation, transparency ------------------
  const socialComponents = {
    trust: clamp((report.social.trust + 100) / 2, 0, 100),
    jobs: clamp(remap(report.social.jobs, 0, 120, 0, 100), 0, 100),
    heatBenefit: clamp01(report.social.heatExportedMwh / Math.max(1, report.environment.facilityMwh * 0.2)) * 100,
    gridCooperation: clamp(remap(report.social.gridServiceRevenue, 0, 2_000_000, 0, 100), 0, 100),
    transparency: report.social.transparent ? 100 : 40,
  };

  const categories: Record<keyof ScoreWeights, ScoreCategoryDetail> = {
    financial: detail(financialComponents),
    reliability: detail(reliabilityComponents),
    environmental: detail(environmentalComponents),
    customer: detail(customerComponents),
    social: detail(socialComponents),
  };

  // --- Gates ---------------------------------------------------------------
  const tripped: string[] = [...context.gateFlags];
  if (report.reliability.availability01 < context.minimumAvailability01
    && !tripped.includes('gate.reliability_floor')) {
    tripped.push('gate.reliability_floor');
  }

  const adjusted = { ...categories };
  for (const gate of profile.gates) {
    if (!tripped.includes(gate.id) || !gate.zeroCategory) continue;
    adjusted[gate.zeroCategory] = { score: 0, components: categories[gate.zeroCategory].components };
  }

  const overall =
    adjusted.financial.score * profile.weights.financial +
    adjusted.reliability.score * profile.weights.reliability +
    adjusted.environmental.score * profile.weights.environmental +
    adjusted.customer.score * profile.weights.customer +
    adjusted.social.score * profile.weights.social;

  const band = ratingFor(overall, profile, tripped);
  return {
    year: report.year,
    overall: Math.round(overall * 100) / 100,
    rating: band.rating,
    label: band.label,
    categories: adjusted,
    gatesTripped: tripped,
  };
}

function detail(components: Record<string, number>): ScoreCategoryDetail {
  const values = Object.values(components);
  const score = values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
  return { score: Math.round(score * 100) / 100, components };
}

/** The band the score earns, then capped by any gate that caps the rating. */
function ratingFor(
  overall: number,
  profile: ScoreProfileDefinition,
  tripped: readonly string[],
): { rating: string; label: string } {
  const bands = [...profile.ratingBands].sort((a, b) => a.minScore - b.minScore);
  let earned = bands[0] ?? { rating: 'D', minScore: 0, label: 'Unrated' };
  for (const band of bands) {
    if (overall >= band.minScore) earned = band;
  }

  for (const gate of profile.gates) {
    if (!gate.capRating || !tripped.includes(gate.id)) continue;
    const cap = bands.find((band) => band.rating === gate.capRating);
    if (cap && bands.indexOf(cap) < bands.indexOf(earned)) earned = cap;
  }
  return { rating: earned.rating, label: earned.label };
}
