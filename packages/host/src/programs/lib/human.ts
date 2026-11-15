// Human-readable sizes and block sizes as GNU programs print them (ls -h, --si, --block-size,
// df and du later): gnulib's human.c, with its default rounding (up, `human_ceiling`), and the
// SIZE argument of --block-size and the BLOCK_SIZE environment variables (gnulib human_options).
//   upstream: gnulib lib/human.c human_readable, humblock
//   reference: coreutils 9.4 ls -lh, ls -sh, ls --si, ls --block-size=K, captured 2026-11-16
//              (packages/host/transcripts/coreutils/ls-long.t)

/** Flags of human_readable (gnulib human.h). */
export interface HumanOptions {
  /** Pick the unit so the number is short (-h, --si). */
  autoscale?: boolean;
  /** Print the unit letter. */
  si?: boolean;
  /** Powers of 1024 rather than 1000. */
  base1024?: boolean;
  /** Append `B` (`KB`, `KiB`). */
  b?: boolean;
  /** Thousands separators: none in the C.UTF-8 locale, so it changes nothing. */
  groupDigits?: boolean;
}

const POWER_LETTER = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y', 'R', 'Q'];

/** The amount `n` in units of `from`, printed in units of `to`, rounded up. */
export function humanReadable(n: number, opts: HumanOptions, from: number, to: number): string {
  const base = opts.base1024 ? 1024 : 1000;
  const exponentMax = POWER_LETTER.length - 1;
  let exponent = -1;
  let digits: string;

  let amt: number;
  let tenths = 0;
  let remainder = 0;
  let integer = false;
  if (to <= from && from % to === 0) {
    amt = n * (from / to);
    integer = true;
  } else if (to > from && to % from === 0) {
    const divisor = to / from;
    const r10 = (n % divisor) * 10;
    const r2 = (r10 % divisor) * 2;
    amt = Math.floor(n / divisor);
    tenths = Math.floor(r10 / divisor);
    remainder = r2 < divisor ? (r2 > 0 ? 1 : 0) : 2 + (divisor < r2 ? 1 : 0);
    integer = true;
  } else amt = 0;

  if (integer) {
    let point = '';
    if (opts.autoscale) {
      exponent = 0;
      if (base <= amt) {
        do {
          const r10 = (amt % base) * 10 + tenths;
          const r2 = (r10 % base) * 2 + (remainder >> 1);
          amt = Math.floor(amt / base);
          tenths = Math.floor(r10 / base);
          remainder = r2 < base ? (r2 + remainder !== 0 ? 1 : 0) : 2 + (base < r2 + remainder ? 1 : 0);
          exponent++;
        } while (base <= amt && exponent < exponentMax);
        if (amt < 10) {
          if (remainder > 0) {
            tenths++;
            remainder = 0;
            if (tenths === 10) {
              amt++;
              tenths = 0;
            }
          }
          if (amt < 10) {
            point = `.${tenths}`;
            tenths = remainder = 0;
          }
        }
      }
    }
    if (tenths + remainder > 0) {
      amt++;
      if (opts.autoscale && amt === base && exponent < exponentMax) {
        exponent++;
        point = '.0';
        amt = 1;
      }
    }
    digits = `${amt}${point}`;
  } else {
    // Units that do not divide each other: floating point, rounded up (adjust_value).
    const d = n * (from / to);
    digits = String(Math.ceil(d));
  }

  let suffix = '';
  if (opts.si) {
    if (exponent < 0) {
      exponent = 0;
      for (let power = 1; power < to; power *= base) if (++exponent === exponentMax) break;
    }
    if (exponent) suffix += !opts.base1024 && exponent === 1 ? 'k' : POWER_LETTER[exponent];
    if (opts.b) {
      if (opts.base1024 && exponent) suffix += 'i';
      suffix += 'B';
    }
  }
  return digits + suffix;
}

export type BlockSize = { ok: true; size: number; opts: HumanOptions } | { ok: false; error: 'invalid' | 'suffix' };

const UNIT_POWER: Record<string, number> = { k: 1, K: 1, m: 2, M: 2, g: 3, G: 3, t: 4, T: 4, p: 5, P: 5, e: 6, E: 6, z: 7, Z: 7, y: 8, Y: 8, r: 9, R: 9, q: 10, Q: 10 };

/**
 * A SIZE argument (`--block-size=K`, `BLOCK_SIZE=1M`): an optional integer and an optional unit;
 * a unit with no number means "print the unit letter" (humblock). `human-readable` and `si` are
 * the -h and --si scales.
 */
export function parseBlockSize(spec: string): BlockSize {
  const opts: HumanOptions = {};
  let s = spec;
  if (s.startsWith("'")) {
    opts.groupDigits = true;
    s = s.slice(1);
  }
  if (s === 'human-readable') return { ok: true, size: 1, opts: { ...opts, autoscale: true, si: true, base1024: true } };
  if (s === 'si') return { ok: true, size: 1, opts: { ...opts, autoscale: true, si: true } };
  // xstrtoumax with the suffixes "eEgGkKmMpPtTyYzZ0" (and R, Q), base 10.
  const m = /^([0-9]*)(.*)$/.exec(s) as RegExpExecArray;
  const num = m[1] as string;
  const unit = m[2] as string;
  if (num === '' && unit === '') return { ok: false, error: 'invalid' };
  let size = num === '' ? 1 : Number(num);
  if (unit !== '') {
    const letter = unit[0] as string;
    const power = UNIT_POWER[letter];
    if (power === undefined) return { ok: false, error: num === '' ? 'invalid' : 'suffix' };
    const rest = unit.slice(1);
    let base: number;
    if (rest === '') base = 1024;
    else if (rest === 'B' || rest === 'D') base = 1000;
    else if (rest === 'iB') base = 1024;
    else return { ok: false, error: 'suffix' };
    size *= base ** power;
    if (num === '') {
      opts.si = true;
      if (unit.endsWith('B')) opts.b = true;
      if (!unit.endsWith('B') || unit.endsWith('iB')) opts.base1024 = true;
    }
  }
  if (size === 0 || !Number.isSafeInteger(size)) return { ok: false, error: 'invalid' };
  return { ok: true, size, opts };
}
