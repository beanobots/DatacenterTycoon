/**
 * Deterministic simulation clock and cadence buckets.
 *
 * Spec chapter 9: "Never use rendered-frame delta as economic time." The clock
 * counts whole ticks of a fixed length; wall time never enters the simulation.
 * Spec chapter 3 defines the cadences each system runs at; `TickCadence` marks
 * which boundaries a given tick closes, so a system can ask "is this the last
 * tick of the hour?" rather than tracking its own counters.
 */

export const MINUTES_PER_TICK_DEFAULT = 15;
const MS_PER_MINUTE = 60_000;

export interface TickCadence {
  /** Every tick. 15 simulated minutes at the default rate. */
  readonly tick: true;
  readonly hour: boolean;
  readonly day: boolean;
  readonly week: boolean;
  readonly month: boolean;
  readonly quarter: boolean;
  readonly year: boolean;
}

export interface SimulationTick {
  /** Monotonic tick index since campaign start. */
  readonly index: number;
  /** Length of this tick in simulated minutes. */
  readonly minutes: number;
  /** Simulated UTC instant at the END of this tick. */
  readonly gameTimeUtc: Date;
  /** Simulated UTC instant at the START of this tick. */
  readonly startTimeUtc: Date;
  /** Fraction of an hour this tick covers; the unit for energy accounting. */
  readonly hours: number;
  readonly cadence: TickCadence;
  /** Local-ish hour of day at the tick end, 0-23. */
  readonly hourOfDay: number;
  /** 1-366. */
  readonly dayOfYear: number;
  /** 0-11. */
  readonly month: number;
  readonly year: number;
}

export type TickListener = (tick: SimulationTick) => void;

export class SimulationClock {
  readonly minutesPerTick: number;
  readonly startTimeUtc: Date;
  private currentTick: number;
  private listeners: TickListener[] = [];
  isPaused = false;

  constructor(startTimeUtc: Date, minutesPerTick = MINUTES_PER_TICK_DEFAULT, startingTick = 0) {
    if (!Number.isInteger(minutesPerTick) || minutesPerTick <= 0) {
      throw new RangeError(`minutesPerTick must be a positive integer, got ${minutesPerTick}`);
    }
    if (60 % minutesPerTick !== 0) {
      throw new RangeError(`minutesPerTick must divide 60 so hour boundaries land on ticks, got ${minutesPerTick}`);
    }
    if (Number.isNaN(startTimeUtc.getTime())) {
      throw new RangeError('startTimeUtc is not a valid date');
    }
    this.minutesPerTick = minutesPerTick;
    this.startTimeUtc = new Date(startTimeUtc.getTime());
    this.currentTick = startingTick;
  }

  get tickIndex(): number {
    return this.currentTick;
  }

  /** Simulated instant at the end of the most recently completed tick. */
  get gameTimeUtc(): Date {
    return this.timeAtTick(this.currentTick);
  }

  private timeAtTick(index: number): Date {
    return new Date(this.startTimeUtc.getTime() + index * this.minutesPerTick * MS_PER_MINUTE);
  }

  onTick(listener: TickListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((candidate) => candidate !== listener);
    };
  }

  /** Advances one tick and notifies listeners. Returns null while paused. */
  advanceOneTick(): SimulationTick | null {
    if (this.isPaused) return null;
    const next = this.currentTick + 1;
    const tick = this.describeTick(next);
    this.currentTick = next;
    for (const listener of this.listeners) listener(tick);
    return tick;
  }

  /** Describes tick `index` without advancing. Pure in the clock's own state. */
  describeTick(index: number): SimulationTick {
    const end = this.timeAtTick(index);
    const start = this.timeAtTick(index - 1);
    return {
      index,
      minutes: this.minutesPerTick,
      gameTimeUtc: end,
      startTimeUtc: start,
      hours: this.minutesPerTick / 60,
      cadence: cadenceFor(end, start),
      hourOfDay: end.getUTCHours(),
      dayOfYear: dayOfYear(end),
      month: end.getUTCMonth(),
      year: end.getUTCFullYear(),
    };
  }

  /** Ticks spanning `days` of simulated time. */
  ticksForDays(days: number): number {
    return Math.round((days * 24 * 60) / this.minutesPerTick);
  }
}

/**
 * Which period boundaries this tick closes. A boundary is closed when the
 * tick's end instant falls in a different period than its start instant, so a
 * tick ending exactly at 00:00 on 1 January closes the hour, day, week, month,
 * quarter and year together.
 */
export function cadenceFor(end: Date, start: Date): TickCadence {
  const hour = end.getUTCHours() !== start.getUTCHours() || end.getUTCDate() !== start.getUTCDate();
  const day = end.getUTCDate() !== start.getUTCDate() || end.getUTCMonth() !== start.getUTCMonth();
  const month = end.getUTCMonth() !== start.getUTCMonth() || end.getUTCFullYear() !== start.getUTCFullYear();
  const year = end.getUTCFullYear() !== start.getUTCFullYear();
  // Weeks close when the day rolls into a Monday.
  const week = day && end.getUTCDay() === 1;
  const quarter = month && end.getUTCMonth() % 3 === 0;
  return { tick: true, hour, day, week, month, quarter, year };
}

export function dayOfYear(date: Date): number {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const elapsedDays = (date.getTime() - startOfYear) / 86_400_000;
  return Math.floor(elapsedDays) + 1;
}

/** ISO date without the time part, for report keys and log lines. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
