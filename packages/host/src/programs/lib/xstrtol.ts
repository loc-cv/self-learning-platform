// Number arguments as gnulib's xstrtoumax reads them: optional leading white space and `+`, decimal
// digits, then one optional multiplier suffix from the program's list. With `0` in the list a
// suffix may be followed by `B` (powers of 1000) or `iB` (powers of 1024).
//   upstream: gnulib lib/xstrtol.c (__xstrtol, bkm_scale_by_power), lib/xdectoint.c (xnumtoumax)
//   reference: coreutils 9.4 head/tail, captured 2026-11-16 — `head -n 2k`, `-n 1KiB`, `-n 1kB`,
//              `-n 1x` and `-n 1e` invalid, `-n 1Q` and `-n 99999999999999999999999` overflow,
//              `-n " 3"` accepted, `-n "3 "` invalid, `-n 0x10` invalid, `-n 010` is ten.

export const UINTMAX_MAX = (1n << 64n) - 1n;

export type XstrtolResult = { kind: 'ok'; value: bigint } | { kind: 'invalid' } | { kind: 'overflow' };

/** Power of the multiplier base for each suffix letter. upstream: xstrtol.c __xstrtol */
const POWERS: Record<string, number> = { k: 1, K: 1, m: 2, M: 2, g: 3, G: 3, t: 4, T: 4, P: 5, E: 6, Z: 7, Y: 8, R: 9, Q: 10 };

/** glibc strerror(EOVERFLOW). reference: coreutils 9.4 head, captured 2026-11-16 */
export const EOVERFLOW_TEXT = 'Value too large for defined data type';

/** xstrtoumax(s, NULL, 10, &n, validSuffixes) with an empty suffix list meaning none allowed. */
export function xstrtoumax(s: string, validSuffixes: string): XstrtolResult {
  let i = 0;
  while (i < s.length && ' \t\n\v\f\r'.includes(s[i] as string)) i++;
  if (s[i] === '-') return { kind: 'invalid' };
  if (s[i] === '+') i++;
  const start = i;
  while (i < s.length && (s[i] as string) >= '0' && (s[i] as string) <= '9') i++;
  let value: bigint;
  let overflow = false;
  if (i === start) {
    // No digits: a valid suffix alone means one unit (`k` is 1024).
    if (i < s.length && validSuffixes.includes(s[i] as string)) value = 1n;
    else return { kind: 'invalid' };
  } else {
    value = BigInt(s.slice(start, i));
    if (value > UINTMAX_MAX) {
      overflow = true;
      value = UINTMAX_MAX;
    }
  }
  if (i < s.length) {
    const c = s[i] as string;
    if (validSuffixes === '' || !validSuffixes.includes(c)) return { kind: 'invalid' };
    let base = 1024n;
    let len = 1;
    if (validSuffixes.includes('0')) {
      if (s[i + 1] === 'i' && s[i + 2] === 'B') len = 3;
      else if (s[i + 1] === 'B' || s[i + 1] === 'D') {
        base = 1000n;
        len = 2;
      }
    }
    let scale: bigint;
    if (c === 'b') scale = 512n;
    else if (c === 'B') scale = 1024n;
    else if (c === 'c') scale = 1n;
    else if (c === 'w') scale = 2n;
    else scale = base ** BigInt(POWERS[c] ?? 0);
    value *= scale;
    if (value > UINTMAX_MAX) {
      overflow = true;
      value = UINTMAX_MAX;
    }
    i += len;
    // Characters after the suffix: invalid, and an overflow is then not reported as such.
    if (i < s.length) return { kind: 'invalid' };
  }
  return overflow ? { kind: 'overflow' } : { kind: 'ok', value };
}

/** A count as a JavaScript number; values beyond 2^53 only ever mean "more than any input". */
export function toCount(v: bigint): number {
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
}
