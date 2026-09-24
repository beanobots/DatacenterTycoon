/**
 * Numeric helpers shared by the simulation systems.
 *
 * Spec chapter 14 asserts "No NaN or infinite values", so every helper here
 * either produces a finite number or throws with enough context to find the
 * offending system.
 */

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

/** Maps `value` from [inMin, inMax] onto [outMin, outMax], clamped at both ends. */
export function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (inMax === inMin) return outMin;
  return lerp(outMin, outMax, (value - inMin) / (inMax - inMin));
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

/**
 * Division that returns `fallback` instead of Infinity or NaN when the
 * denominator is zero. Spec chapter 14: "PUE not calculated when IT energy is
 * zero" - callers pass `null` as the fallback to mean "undefined this period".
 */
export function safeDivide(numerator: number, denominator: number, fallback: number): number;
export function safeDivide(numerator: number, denominator: number, fallback: null): number | null;
export function safeDivide(numerator: number, denominator: number, fallback: number | null): number | null {
  if (denominator === 0 || !Number.isFinite(denominator) || !Number.isFinite(numerator)) return fallback;
  return numerator / denominator;
}

/** Throws if `value` is NaN or infinite. `label` names the value in the error. */
export function assertFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} is not finite (got ${value})`);
  }
  return value;
}

/** Rounds to `digits` decimals. Keeps report output readable and diff-stable. */
export function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Linear interpolation across a 12-entry monthly curve, wrapping December to
 * January. `dayOfYear` is 1-366. Used for climate and price profiles.
 */
export function sampleMonthlyCurve(curve: readonly number[], dayOfYear: number): number {
  if (curve.length !== 12) {
    throw new RangeError(`monthly curve must have 12 entries, got ${curve.length}`);
  }
  const position = ((dayOfYear - 1) / 365.25) * 12;
  const lowIndex = Math.floor(position) % 12;
  const highIndex = (lowIndex + 1) % 12;
  const low = curve[lowIndex] ?? 0;
  const high = curve[highIndex] ?? 0;
  return lerp(low, high, position - Math.floor(position));
}

/** Linear interpolation across a 24-entry hourly curve, wrapping 23 to 0. */
export function sampleHourlyCurve(curve: readonly number[], hourOfDay: number): number {
  if (curve.length !== 24) {
    throw new RangeError(`hourly curve must have 24 entries, got ${curve.length}`);
  }
  const lowIndex = Math.floor(hourOfDay) % 24;
  const highIndex = (lowIndex + 1) % 24;
  const low = curve[lowIndex] ?? 0;
  const high = curve[highIndex] ?? 0;
  return lerp(low, high, hourOfDay - Math.floor(hourOfDay));
}

/**
 * Inverse standard normal CDF, Acklam's rational approximation.
 *
 * Accurate to about 1.15e-9 in relative error across the open interval, which
 * is far beyond what any balance number needs. It exists so that "how much
 * spare capacity does a 99.9% commitment need" can be answered from the
 * distribution the arrivals are actually drawn from, rather than guessed at
 * with a flat margin.
 */
export function inverseNormal(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const low = 0.02425;

  const at = (row: readonly number[], index: number): number => row[index] ?? 0;

  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((at(c, 0) * q + at(c, 1)) * q + at(c, 2)) * q + at(c, 3)) * q + at(c, 4)) * q + at(c, 5))
      / ((((at(d, 0) * q + at(d, 1)) * q + at(d, 2)) * q + at(d, 3)) * q + 1);
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((at(c, 0) * q + at(c, 1)) * q + at(c, 2)) * q + at(c, 3)) * q + at(c, 4)) * q + at(c, 5))
      / ((((at(d, 0) * q + at(d, 1)) * q + at(d, 2)) * q + at(d, 3)) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((at(a, 0) * r + at(a, 1)) * r + at(a, 2)) * r + at(a, 3)) * r + at(a, 4)) * r + at(a, 5)) * q
    / (((((at(b, 0) * r + at(b, 1)) * r + at(b, 2)) * r + at(b, 3)) * r + at(b, 4)) * r + 1);
}

/**
 * Standard normal CDF, via Abramowitz & Stegun 7.1.26 on the error function.
 * Accurate to about 1.5e-7, which is well inside what a climate estimate can
 * claim. Used to answer "how much of the year is above this temperature".
 */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736)
    * t * t * Math.exp(-x * x) - 0.254829592 * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}
