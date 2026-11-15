// Seeded PRNG with named streams (docs/ARCHITECTURE.md §2.6).
//
// Generator: xoshiro128** by Blackman and Vigna (public domain, https://prng.di.unimi.it/,
// reference code xoshiro128starstar.c): 128 bits of state as four 32-bit words, period 2^128 - 1.
// A stream's initial state is a pure function of (world seed, stream name): the name and seed are
// hashed (hash.ts) and the hash seeds SplitMix32 (the 32-bit variant of SplitMix64, Steele, Lea and
// Flood 2014; mixing constants from the MurmurHash3 finalizer), which fills the four words. So
// the order in which streams are first used never changes what any stream draws.

import { hashString } from './hash.ts';

export type PrngState = [number, number, number, number];

export interface Random {
  /** Uniform integer in [0, n), for 1 <= n <= 2^32. */
  int(n: number): number;
  /** Uniform float in [0, 1) with 32 bits of precision. */
  float(): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  /** `length` characters drawn from `alphabet`. */
  chars(length: number, alphabet: string): string;
}

export function initialPrngState(seed: number, name: string): PrngState {
  const h = hashString(`${seed}\u0000${name}`);
  let x = parseInt(h.slice(0, 8), 16) ^ parseInt(h.slice(8), 16);
  const next = (): number => {
    x = (x + 0x9e3779b9) | 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  const s: PrngState = [next(), next(), next(), next()];
  // An all-zero state is the one fixed point of xoshiro; SplitMix cannot produce it from four
  // consecutive draws, but guard anyway.
  if ((s[0] | s[1] | s[2] | s[3]) === 0) s[0] = 1;
  return s;
}

/** Advances `s` in place and returns the next 32-bit output. */
export function nextUint32(s: PrngState): number {
  const result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
  const t = s[1] << 9;
  s[2] ^= s[0];
  s[3] ^= s[1];
  s[1] ^= s[2];
  s[0] ^= s[3];
  s[2] ^= t;
  s[3] = rotl(s[3], 11);
  for (let i = 0; i < 4; i++) s[i] = (s[i] as number) >>> 0;
  return result;
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

const TWO_32 = 0x1_0000_0000;

/** A `Random` over a state array that lives in the world and is advanced in place. */
export function randomOver(s: PrngState): Random {
  const int = (n: number): number => {
    if (!Number.isInteger(n) || n < 1 || n > TWO_32) throw new RangeError(`int(${n}): n must be an integer in [1, 2^32]`);
    // Rejection sampling removes the modulo bias.
    const limit = TWO_32 - (TWO_32 % n);
    for (;;) {
      const x = nextUint32(s);
      if (x < limit) return x % n;
    }
  };
  return {
    int,
    float: () => nextUint32(s) / TWO_32,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('pick from an empty list');
      return items[int(items.length)] as T;
    },
    shuffle<T>(items: readonly T[]): T[] {
      // Fisher–Yates, from the end.
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        const tmp = out[i] as T;
        out[i] = out[j] as T;
        out[j] = tmp;
      }
      return out;
    },
    chars(length: number, alphabet: string): string {
      let out = '';
      for (let i = 0; i < length; i++) out += alphabet[int(alphabet.length)];
      return out;
    },
  };
}
