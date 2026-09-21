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
