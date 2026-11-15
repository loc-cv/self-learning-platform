// The date strings `touch -d` and `touch -t` take, in the subset the simulator parses.
//   upstream: gnulib lib/parse-datetime.y (coreutils 9.4 tarball) for -d; lib/posixtm.c posixtime
//             with PDS_LEADING_YEAR | PDS_CENTURY | PDS_SECONDS for -t
//   reference: coreutils 9.4 touch -d/-t, captured 2026-11-16 (packages/host/transcripts/coreutils/touch.t)
// Supported -d forms: `@SECONDS[.frac]`, and `[YY]YY-MM-DD` optionally followed (after blanks or
// `T`) by `H:MM[:SS[.frac]]` or `HHMM`, optionally followed by `Z`, `UTC`, `GMT` or a numeric
// offset (`+02`, `+0530`, `-05:00`). Local time is UTC. Anything else (relative items like
// "yesterday", month names, weekdays) is reported as unsupported, never guessed.

import { civilFromMillis, millisFromCivil, type Millis } from '@simlab/kernel';

export type DateResult = { ok: true; ms: Millis } | { ok: false; invalid: true } | { ok: false; unsupported: true };

const INVALID: DateResult = { ok: false, invalid: true };
const UNSUPPORTED: DateResult = { ok: false, unsupported: true };

function daysIn(year: number, month: number): number {
  return new Array<number>(31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)[month - 1] as number;
}

/** First three digits of a fraction as milliseconds (truncated, as the nanoseconds would be). */
const fracMs = (f: string | undefined): number => (f ? Number(f.slice(0, 3).padEnd(3, '0')) : 0);

/** A two-digit year as parse-datetime reads it: 69–99 are 19xx, 00–68 are 20xx. */
const fullYear = (y: string): number => (y.length === 2 ? (Number(y) < 69 ? 2000 : 1900) + Number(y) : Number(y));

/** parse_datetime for the supported forms. */
export function parseTouchDate(input: string): DateResult {
  const s = input.trim();
  const epoch = /^@\s*([-+]?)(\d+)(?:[.,](\d+))?$/.exec(s);
  if (epoch) {
    const sign = epoch[1] === '-' ? -1 : 1;
    return { ok: true, ms: sign * (Number(epoch[2]) * 1000 + fracMs(epoch[3])) };
  }
  if (s.startsWith('@')) return /^@\s*[-+]?\d/.test(s) ? INVALID : UNSUPPORTED;
  const m = /^(\d+)-(\d{1,2})-(\d{1,2})(?:(?:\s+|[Tt])(?:(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:[.,](\d+))?)?|(\d{2})(\d{2})))?(?:\s*(Z|z|UTC|utc|GMT|gmt|[+-]\d{1,2}(?::?\d{2})?))?$/.exec(s);
  if (!m) {
    // A signed number where the year goes is a relative item or an error; leave both to the notice
    // unless it is the plain "-YYYY-MM-DD" the real parser rejects.
    if (/^[-+]\d+-\d{1,2}-\d{1,2}$/.test(s)) return INVALID;
    return UNSUPPORTED;
  }
  const [, ys, mo, da, h1, mi1, se, frac, h2, mi2, zone] = m;
  const yearDigits = ys as string;
  if (yearDigits.length !== 2 && yearDigits.length !== 4) return UNSUPPORTED;
  const year = fullYear(yearDigits);
  const month = Number(mo);
  const day = Number(da);
  const hour = Number(h1 ?? h2 ?? 0);
  const minute = Number(mi1 ?? mi2 ?? 0);
  const second = Number(se ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return INVALID;
  if (hour > 23 || minute > 59 || second > 59) return INVALID;
  let offset = 0;
  if (zone && /^[+-]/.test(zone)) {
    const z = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(zone) as RegExpExecArray;
    const zh = Number(z[2]);
    const zm = Number(z[3] ?? 0);
    if (zh > 24 || zm > 59) return INVALID;
    offset = (z[1] === '-' ? -1 : 1) * (zh * 60 + zm) * 60_000;
  }
  return { ok: true, ms: millisFromCivil(year, month, day, hour, minute, second, fracMs(frac)) - offset };
}

/** posixtime: `[[CC]YY]MMDDhhmm[.ss]`; the year defaults to the current one. */
export function parseTouchStamp(s: string, now: Millis): Millis | null {
  const m = /^(\d+)(?:\.(\d{2}))?$/.exec(s);
  if (!m) return null;
  const digits = m[1] as string;
  let year: number;
  let rest: string;
  if (digits.length === 8) {
    year = civilFromMillis(now).year;
    rest = digits;
  } else if (digits.length === 10) {
    year = fullYear(digits.slice(0, 2));
    rest = digits.slice(2);
  } else if (digits.length === 12) {
    year = Number(digits.slice(0, 4));
    rest = digits.slice(4);
  } else return null;
  const month = Number(rest.slice(0, 2));
  const day = Number(rest.slice(2, 4));
  const hour = Number(rest.slice(4, 6));
  const minute = Number(rest.slice(6, 8));
  const second = m[2] === undefined ? 0 : Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month) || hour > 23 || minute > 59 || second > 60) return null;
  // A leap second (:60) becomes the next minute's first second, as mktime normalizes it.
  return millisFromCivil(year, month, day, hour, minute, 0) + second * 1000;
}
