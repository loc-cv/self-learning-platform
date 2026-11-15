// The date strings of `date -d` (gnulib parse_datetime), the common part: `@SECONDS`, ISO 8601
// dates and date-times (with T, Z or a numeric offset), YYYYMMDD, M/D/Y, month names, times with
// am/pm, the UTC/GMT/UT/Z zones, `now`/`today`/`tomorrow`/`yesterday`, and relative items
// (`2 days ago`, `+1 month`, `next week`). The machines run in UTC.
//   docs: coreutils manual "Date input formats" (info '(coreutils) Date input formats')
//   upstream: gnulib lib/parse-datetime.y (the grammar's items, `number`, relative units applied
//             to the broken-down time before mktime, which normalizes Jan 31 + 1 month to Mar 3)
//   reference: coreutils 9.4 `date -d` results for each form, captured 2026-11-16
//              (packages/host/transcripts/coreutils/date.t); the word tables are the strings of
//              /usr/bin/date (`strings`): month and day names, TOMORROW … TWELFTH, AGO, HENCE,
//              the units, AM/PM, and the zone abbreviations.
// A word parse_datetime knows but this parser does not handle (day names, ordinals, other zone
// abbreviations, military zone letters) gives `unsupported`; a word it does not know at all, or a
// value out of range, gives `invalid`, as the real parser rejects them.

import { civilFromMillis, millisFromCivil } from '@simlab/kernel';

export type DateResult = { ok: true; ms: number } | { ok: false; invalid: true } | { ok: false; unsupported: string };

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const UNITS: Record<string, 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'> = {
  year: 'year',
  month: 'month',
  fortnight: 'day',
  week: 'day',
  day: 'day',
  hour: 'hour',
  minute: 'minute',
  min: 'minute',
  second: 'second',
  sec: 'second',
};
const UNIT_SCALE: Record<string, number> = { fortnight: 14, week: 7 };
const ZERO_ZONES = new Set(['utc', 'gmt', 'ut', 'z']);

/** Words of parse_datetime's tables that this parser does not handle. */
const KNOWN_UNHANDLED = new Set([
  ...['sunday', 'monday', 'tuesday', 'tues', 'wednesday', 'wednes', 'thursday', 'thur', 'thurs', 'friday', 'saturday'],
  ...['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
  ...['first', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'],
  ...['dst', 'wet', 'west', 'bst', 'art', 'brt', 'brst', 'nst', 'ndt', 'ast', 'adt', 'clt', 'clst', 'est', 'edt', 'cst', 'cdt', 'mst', 'mdt', 'pst', 'pdt'],
  ...['akst', 'akdt', 'hst', 'hast', 'hadt', 'sst', 'wat', 'cet', 'cest', 'met', 'mez', 'mest', 'mesz', 'eet', 'eest', 'cat', 'sast', 'eat', 'msk', 'msd'],
  ...['ist', 'sgt', 'kst', 'jst', 'gst', 'nzst', 'nzdt'],
]);

type Token =
  | { t: 'num'; v: number; digits: number; frac: string }
  | { t: 'snum'; v: number; digits: number; neg: boolean }
  | { t: 'word'; w: string }
  | { t: ':' | '/' };

class Invalid extends Error {}
class Unhandled extends Error {}

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (/[\s,]/.test(c)) {
      i++;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^([+-])([0-9]+)/.exec(s.slice(i)))) {
      const digits = m[2] as string;
      out.push({ t: 'snum', v: (m[1] === '-' ? -1 : 1) * Number(digits), digits: digits.length, neg: m[1] === '-' });
      i += m[0].length;
    } else if ((m = /^([0-9]+)(?:[.,]([0-9]+))?/.exec(s.slice(i)))) {
      out.push({ t: 'num', v: Number(m[1]), digits: (m[1] as string).length, frac: m[2] ?? '' });
      i += m[0].length;
    } else if ((m = /^[A-Za-z][A-Za-z.]*/.exec(s.slice(i)))) {
      out.push({ t: 'word', w: m[0].toLowerCase() });
      i += m[0].length;
    } else if (c === ':' || c === '/') {
      out.push({ t: c });
      i++;
    } else if (c === '(' || c === '"' || c === '=') {
      throw new Unhandled(s);
    } else throw new Invalid(s);
  }
  return out;
}

const daysIn = (y: number, m: number): number => [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] as number;

/** A two-digit year: 69–99 are 1969–1999, 00–68 are 2000–2068 (POSIX). */
const fullYear = (v: number, digits: number): number => (digits === 2 ? (v >= 69 ? 1900 + v : 2000 + v) : v);

function monthOf(w: string): number | undefined {
  if (w === 'sept') return 9;
  const k = MONTHS.findIndex((m) => m === w || (w.length === 3 && m.startsWith(w)));
  return k < 0 ? undefined : k + 1;
}

function unitOf(w: string): string | undefined {
  if (w in UNITS) return w;
  if (w.endsWith('s') && w.slice(0, -1) in UNITS) return w.slice(0, -1);
  return undefined;
}

interface State {
  date?: { y?: number; m: number; d: number };
  time?: { h: number; min: number; s: number; ms: number };
  zone?: number;
  rel: { year: number; month: number; day: number; hour: number; minute: number; second: number };
  relSeen: boolean;
}

function parseItems(tokens: Token[]): State {
  const st: State = { rel: { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 }, relSeen: false };
  let i = 0;
  const peek = (k = 0): Token | undefined => tokens[i + k];
  const word = (k = 0): string | undefined => {
    const t = peek(k);
    return t?.t === 'word' ? t.w : undefined;
  };
  const setDate = (d: { y?: number; m: number; d: number }): void => {
    if (st.date) throw new Invalid('two dates');
    st.date = d;
  };
  const setZone = (offsetSeconds: number): void => {
    if (st.zone !== undefined) throw new Invalid('two zones');
    st.zone = offsetSeconds;
  };
  /** A numeric zone: +H, +HH, +HHMM, or +HH:MM after the sign. */
  const numericZone = (t: Extract<Token, { t: 'snum' }>): number => {
    let h: number;
    let m = 0;
    if (peek()?.t === ':' && peek(1)?.t === 'num') {
      h = Math.abs(t.v);
      m = (peek(1) as Extract<Token, { t: 'num' }>).v;
      i += 2;
    } else if (t.digits <= 2) h = Math.abs(t.v);
    else if (t.digits === 4) {
      h = Math.floor(Math.abs(t.v) / 100);
      m = Math.abs(t.v) % 100;
    } else throw new Invalid('zone');
    if (h > 24 || m > 59) throw new Invalid('zone');
    return (t.neg ? -1 : 1) * (h * 3600 + m * 60);
  };
  const meridian = (h: number): number => {
    const w = word();
    if (w === 'am' || w === 'a.m.' || w === 'pm' || w === 'p.m.') {
      i++;
      if (h < 1 || h > 12) throw new Invalid('hour');
      return (h % 12) + (w.startsWith('p') ? 12 : 0);
    }
    return h;
  };
  const setTime = (h: number, min: number, s: number, ms: number): void => {
    if (st.time) throw new Invalid('two times');
    const hh = meridian(h);
    if (hh > 23 || min > 59 || s > 59) throw new Invalid('time');
    st.time = { h: hh, min, s, ms };
    // A signed number right after a time is its zone.
    const z = peek();
    if (z?.t === 'snum') {
      i++;
      setZone(numericZone(z));
    }
  };
  const relative = (n: number, unit: string): void => {
    let v = n * (UNIT_SCALE[unit] ?? 1);
    const w = word();
    if (w === 'ago' || w === 'hence') {
      i++;
      if (w === 'ago') v = -v;
    }
    st.rel[UNITS[unit] as keyof State['rel']] += v;
    st.relSeen = true;
  };
  /** Time after HH: `:MM[:SS[.frac]]`. */
  const clock = (h: Extract<Token, { t: 'num' }>): void => {
    i += 2; // HH :
    const mm = peek();
    if (mm?.t !== 'num') throw new Invalid('time');
    i++;
    let s = 0;
    let ms = 0;
    if (peek()?.t === ':' && peek(1)?.t === 'num') {
      const ss = peek(1) as Extract<Token, { t: 'num' }>;
      s = ss.v;
      ms = Math.floor(Number(`0.${ss.frac || '0'}`) * 1000);
      i += 2;
    }
    setTime(h.v, mm.v, s, ms);
  };

  while (i < tokens.length) {
    const t = tokens[i] as Token;
    if (t.t === 'num') {
      const n1 = peek(1);
      const n2 = peek(2);
      if (n1?.t === 'snum' && n1.neg && n2?.t === 'snum' && n2.neg) {
        // ISO 8601: YYYY-MM-DD, optionally followed by T and a time.
        setDate({ y: fullYear(t.v, t.digits), m: -n1.v, d: -n2.v });
        i += 3;
        if (word() === 't') {
          i++;
          const h = peek();
          if (h?.t !== 'num' || peek(1)?.t !== ':') throw new Invalid('T');
          clock(h);
        }
        continue;
      }
      if (n1?.t === ':') {
        clock(t);
        continue;
      }
      if (n1?.t === '/' && n2?.t === 'num') {
        i += 3;
        if (peek()?.t === '/' && peek(1)?.t === 'num') {
          const n3 = peek(1) as Extract<Token, { t: 'num' }>;
          i += 2;
          if (t.digits >= 4) setDate({ y: t.v, m: n2.v, d: n3.v });
          else setDate({ y: fullYear(n3.v, n3.digits), m: t.v, d: n2.v });
        } else setDate({ m: t.v, d: n2.v });
        continue;
      }
      const w1 = word(1);
      if (w1 !== undefined && unitOf(w1)) {
        i += 2;
        relative(t.v, unitOf(w1) as string);
        continue;
      }
      if (w1 !== undefined && monthOf(w1) !== undefined) {
        // D MONTH [YEAR]
        i += 2;
        const y = peek();
        if (y?.t === 'num' && peek(1)?.t !== ':') {
          i++;
          setDate({ y: fullYear(y.v, y.digits), m: monthOf(w1) as number, d: t.v });
        } else setDate({ m: monthOf(w1) as number, d: t.v });
        continue;
      }
      // upstream `number`: a year after a date without one, YYYYMMDD, or HH / HHMM.
      i++;
      if (st.date && st.date.y === undefined && !st.relSeen && t.digits > 2) st.date.y = t.v;
      else if (t.digits > 4) setDate({ y: Math.floor(t.v / 10000), m: Math.floor(t.v / 100) % 100, d: t.v % 100 });
      else if (t.digits <= 2) setTime(t.v, 0, 0, 0);
      else setTime(Math.floor(t.v / 100), t.v % 100, 0, 0);
      continue;
    }
    if (t.t === 'snum') {
      const w1 = word(1);
      if (w1 !== undefined && unitOf(w1)) {
        i += 2;
        relative(t.v, unitOf(w1) as string);
        continue;
      }
      throw new Invalid('number');
    }
    if (t.t === 'word') {
      const w = t.w;
      i++;
      if (w === 'now' || w === 'today') {
        st.relSeen = true;
        continue;
      }
      if (w === 'tomorrow' || w === 'yesterday') {
        st.rel.day += w === 'tomorrow' ? 1 : -1;
        st.relSeen = true;
        continue;
      }
      if (w === 'next' || w === 'last' || w === 'this') {
        const u = word();
        if (u === undefined || !unitOf(u)) throw new Unhandled(w);
        i++;
        relative(w === 'next' ? 1 : w === 'last' ? -1 : 0, unitOf(u) as string);
        continue;
      }
      if (unitOf(w)) {
        relative(1, unitOf(w) as string);
        continue;
      }
      if (ZERO_ZONES.has(w)) {
        const z = peek();
        if (z?.t === 'snum') {
          i++;
          setZone(numericZone(z));
        } else setZone(0);
        continue;
      }
      const month = monthOf(w);
      if (month !== undefined) {
        // MONTH D [YEAR] or MONTH YEAR is not handled; MONTH D [YEAR]:
        const d = peek();
        if (d?.t !== 'num') throw new Unhandled(w);
        i++;
        const y = peek();
        if (y?.t === 'num' && peek(1)?.t !== ':') {
          i++;
          setDate({ y: fullYear(y.v, y.digits), m: month, d: d.v });
        } else setDate({ m: month, d: d.v });
        continue;
      }
      if (KNOWN_UNHANDLED.has(w) || /^[a-ik-z]$/.test(w)) throw new Unhandled(w);
      throw new Invalid(w);
    }
    // A lone ':' or '/'.
    throw new Invalid('punctuation');
  }
  return st;
}

/** Parses a `date -d` string relative to `now` (UTC). */
export function parseDate(input: string, now: number): DateResult {
  const at = /^\s*@\s*([+-]?)([0-9]+)(?:[.,]([0-9]*))?\s*$/.exec(input);
  if (/^\s*@/.test(input)) {
    if (!at) return { ok: false, invalid: true };
    const secs = Number(at[2]);
    if (secs > 9e12) return { ok: false, unsupported: `the date ${input.trim()}` };
    const ms = secs * 1000 + Math.floor(Number(`0.${at[3] || '0'}`) * 1000);
    return { ok: true, ms: at[1] === '-' ? -ms : ms };
  }
  const today = civilFromMillis(now);
  if (input.trim() === '') return { ok: true, ms: millisFromCivil(today.year, today.month, today.day) };
  let st: State;
  try {
    st = parseItems(tokenize(input));
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, invalid: true };
    if (e instanceof Unhandled) return { ok: false, unsupported: `the date string ‘${input}’` };
    throw e;
  }
  const d = st.date;
  const y = d?.y ?? today.year;
  const m = d?.m ?? today.month;
  const day = d?.d ?? today.day;
  if (d && (m < 1 || m > 12 || day < 1 || day > daysIn(y, m))) return { ok: false, invalid: true };
  let time = st.time;
  if (!time) time = d ? { h: 0, min: 0, s: 0, ms: 0 } : { h: today.hour, min: today.minute, s: today.second, ms: today.ms };
  // Years, months and days are added to the broken-down date, which is then normalized.
  const months = y * 12 + (m - 1) + st.rel.year * 12 + st.rel.month;
  const yy = Math.floor(months / 12);
  const mm = months - yy * 12 + 1;
  let ms = millisFromCivil(yy, mm, 1, time.h, time.min, time.s, time.ms) + (day - 1 + st.rel.day) * 86400000;
  if (st.zone !== undefined) ms -= st.zone * 1000;
  ms += (st.rel.hour * 3600 + st.rel.minute * 60 + st.rel.second) * 1000;
  return { ok: true, ms };
}
