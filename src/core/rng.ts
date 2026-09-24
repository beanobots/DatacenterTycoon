/**
 * Deterministic random streams.
 *
 * Spec chapter 9, "Determinism rules":
 *   - Use seeded independent random streams by subsystem.
 *   - Persist random-stream state in saves.
 *
 * Streams are counter-based (splitmix64 over a 64-bit counter) rather than
 * state-chained, so a stream's entire state is `{seed, counter}`: two integers
 * that serialise exactly and restore without replaying history. Drawing from
 * one subsystem can therefore never shift another subsystem's sequence.
 */

/** Named subsystem streams. Adding a stream never perturbs existing ones. */
export const STREAM_NAMES = [
  'weather',
  'market',
  'workload',
  'failure',
  'maintenance',
  'events',
  'community',
  'research',
  'supplyChain',
] as const;

export type StreamName = (typeof STREAM_NAMES)[number];

export interface RandomStreamState {
  readonly seed: string;
  readonly counter: string;
}

export type RandomStreamsState = Record<StreamName, RandomStreamState>;

const MASK64 = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;

function splitmix64(x: bigint): bigint {
  let z = (x + GOLDEN) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

/** FNV-1a over a UTF-8 string, widened to 64 bits. Stable across platforms. */
export function hashSeed(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * prime) & MASK64;
  }
  return hash;
}

/** A single subsystem stream. Draws advance only this stream's counter. */
export class RandomStream {
  private readonly seed: bigint;
  private counter: bigint;

  constructor(seed: bigint, counter = 0n) {
    this.seed = seed & MASK64;
    this.counter = counter & MASK64;
  }

  static fromState(state: RandomStreamState): RandomStream {
    return new RandomStream(BigInt(state.seed), BigInt(state.counter));
  }

  toState(): RandomStreamState {
    return { seed: this.seed.toString(), counter: this.counter.toString() };
  }

  /** Next raw 64-bit draw. */
  private next64(): bigint {
    const value = splitmix64((this.seed ^ (this.counter * GOLDEN)) & MASK64);
    this.counter = (this.counter + 1n) & MASK64;
    return value;
  }

  /** Uniform in [0, 1). 53 significant bits, so the value is exactly representable. */
  float01(): number {
    return Number(this.next64() >> 11n) / 2 ** 53;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.float01() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) throw new RangeError(`int(${min}, ${max}): empty range`);
    const span = BigInt(max - min + 1);
    return min + Number(this.next64() % span);
  }

  /** True with probability `p`. p <= 0 never fires, p >= 1 always fires. */
  chance(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.float01() < p;
  }

  /** Standard normal via Box-Muller. Consumes two draws, always. */
  normal(mean = 0, stdDev = 1): number {
    // Guard against log(0); float01() can return exactly 0.
    const u1 = Math.max(this.float01(), Number.MIN_VALUE);
    const u2 = this.float01();
    const magnitude = Math.sqrt(-2 * Math.log(u1));
    return mean + stdDev * magnitude * Math.cos(2 * Math.PI * u2);
  }

  /** Picks one item. Throws on an empty list rather than returning undefined. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick() from empty array');
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new RangeError('pick() produced undefined');
    return item;
  }

  /**
   * A derived stream, deterministic in `label` and this stream's seed. Used to
   * give each facility or asset its own failure sequence without letting the
   * number of assets change any other asset's draws.
   */
  derive(label: string): RandomStream {
    return new RandomStream(splitmix64((this.seed ^ hashSeed(label)) & MASK64));
  }
}

/** The full set of subsystem streams for one campaign. */
export class RandomStreams {
  private readonly streams: Map<StreamName, RandomStream>;

  private constructor(streams: Map<StreamName, RandomStream>) {
    this.streams = streams;
  }

  /** Builds every stream from one campaign seed; each is independent. */
  static fromSeed(campaignSeed: string): RandomStreams {
    const base = hashSeed(campaignSeed);
    const streams = new Map<StreamName, RandomStream>();
    for (const name of STREAM_NAMES) {
      streams.set(name, new RandomStream(splitmix64((base ^ hashSeed(name)) & MASK64)));
    }
    return new RandomStreams(streams);
  }

  static fromState(state: RandomStreamsState): RandomStreams {
    const streams = new Map<StreamName, RandomStream>();
    for (const name of STREAM_NAMES) {
      const streamState = state[name];
      if (!streamState) throw new Error(`Save is missing random stream "${name}"`);
      streams.set(name, RandomStream.fromState(streamState));
    }
    return new RandomStreams(streams);
  }

  toState(): RandomStreamsState {
    const out = {} as Record<StreamName, RandomStreamState>;
    for (const name of STREAM_NAMES) out[name] = this.get(name).toState();
    return out;
  }

  get(name: StreamName): RandomStream {
    const stream = this.streams.get(name);
    if (!stream) throw new Error(`Unknown random stream "${name}"`);
    return stream;
  }
}
