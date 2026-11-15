// strftime as GNU date formats with it (gnulib nstrftime) in the C.UTF-8 locale, for a time in a
// zone with a fixed offset (the simulated machines run in UTC).
//   docs: date --help of coreutils 9.4 (the list of conversions and flags); strftime(3)
//   upstream: gnulib lib/nstrftime.c __strftime_internal (padding flags, width, E and O modifiers,
//             %N width as a precision, a bad conversion copied as written)
//   reference: coreutils 9.4 date outputs, captured 2026-11-16 (packages/host/transcripts/coreutils/date.t):
//             `%c` → `Mon Nov 16 08:00:05 2026`, `%x` → `11/16/26`, `%X` → `08:00:05`,
//             `%r` → `08:00:05 AM`, `%-10d` → `5`, `%_5H` → `    3`, `%10Y` → `0000002026`,
//             `%+6Y` → `+02026`, `%#Z` → `utc`, `%^a` → `MON`, `%Ey` → `26`, `%E|` → `%E|`

import { civilFromMillis, millisFromCivil } from '@simlab/kernel';

export interface Zone {
  /** %Z */
  abbrev: string;
  /** Seconds east of UTC. */
  offset: number;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A conversion the simulator does not format (a width on a composite one): the caller prints the notice. */
export class FormatUnsupported extends Error {}

interface Broken {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  wday: number;
  /** 0-based day of the year */
  yday: number;
}

function broken(ms: number, zone: Zone): Broken {
  const c = civilFromMillis(ms + zone.offset * 1000);
  const yday = Math.round((millisFromCivil(c.year, c.month, c.day) - millisFromCivil(c.year, 1, 1)) / 86400000);
  return { year: c.year, month: c.month, day: c.day, hour: c.hour, minute: c.minute, second: c.second, wday: c.weekday, yday };
}

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** ISO 8601 week-based year and week number (%G, %V). upstream: nstrftime iso_week_days */
function isoWeek(t: Broken): { year: number; week: number } {
  const isoWeekDays = (yday: number, wday: number): number => {
    const big = 382; // a multiple of 7 plus the ISO week start offset, as in gnulib
    return yday - ((yday - wday + big) % 7) + 3;
  };
  let year = t.year;
  let days = isoWeekDays(t.yday, t.wday);
  if (days < 0) {
    year--;
    days = isoWeekDays(t.yday + (isLeap(year) ? 366 : 365), t.wday);
  } else {
    const d = isoWeekDays(t.yday - (isLeap(year) ? 366 : 365), t.wday);
    if (d >= 0) {
      year++;
      days = d;
    }
  }
  return { year, week: Math.floor(days / 7) + 1 };
}

const E_OK = new Set([...'cCxXyY']);
const O_OK = new Set([...'deHIkmMSuUVwWyl']);

/** Formats `ms` (milliseconds since the epoch) with `format`. */
export function strftime(format: string, ms: number, zone: Zone): string {
  const t = broken(ms, zone);
  const nanos = (((ms % 1000) + 1000) % 1000) * 1000000;
  let out = '';
  for (let i = 0; i < format.length; i++) {
    const c = format[i] as string;
    if (c !== '%') {
      out += c;
      continue;
    }
    const start = i;
    let pad = '';
    let upcase = false;
    let swapcase = false;
    for (;;) {
      const f = format[i + 1];
      if (f === '_' || f === '-' || f === '0' || f === '+') pad = f;
      else if (f === '^') upcase = true;
      else if (f === '#') swapcase = true;
      else break;
      i++;
    }
    let widthText = '';
    while (/[0-9]/.test(format[i + 1] ?? '')) widthText += format[++i];
    const width = widthText === '' ? -1 : Number(widthText);
    let modifier = '';
    if (format[i + 1] === 'E' || format[i + 1] === 'O') modifier = format[++i] as string;
    const conv = format[++i];
    // A bad conversion is copied as written, padded to the width (`%5|` → `  %5|`).
    const bad = (): string => {
      const spec = format.slice(start, i + 1);
      return pad === '-' || width <= spec.length ? spec : spec.padStart(width, pad === '0' ? '0' : ' ');
    };
    if (conv === undefined) {
      out += format.slice(start);
      break;
    }
    if ((modifier === 'E' && !E_OK.has(conv)) || (modifier === 'O' && !O_OK.has(conv))) {
      out += bad();
      continue;
    }

    /** DO_NUMBER: zero padding to `digits` by default; `_` spaces, `-` none; a width widens it. */
    const num = (digits: number, value: number, defaultPad = '0'): string => {
      const neg = value < 0;
      let s = String(Math.abs(value));
      const p = pad === '' || pad === '+' ? defaultPad : pad;
      if (p !== '-') {
        const w = Math.max(width, digits) - (neg ? 1 : 0);
        s = s.padStart(w, p === '_' ? ' ' : '0');
        if (p === '_' && neg) return s.replace(/^( *)/, '$1-');
      }
      return neg ? `-${s}` : s;
    };
    /** Text fields: padded with spaces (zeros with the 0 flag) to the width. */
    const text = (s: string, swapToLower = false): string => {
      let v = s;
      if (upcase) v = v.toUpperCase();
      else if (swapcase) v = swapToLower ? v.toLowerCase() : v.toUpperCase();
      if (pad === '-' || width <= v.length) return v;
      return v.padStart(width, pad === '0' || pad === '+' ? '0' : ' ');
    };
    /** %Y-style years: with the + flag, a sign when the width or the number exceeds four digits. */
    const year = (value: number, digits: number): string => {
      if (pad === '+' && (width > 4 || String(Math.abs(value)).length > 4)) {
        const w = Math.max(width, digits) - 1;
        return `+${String(value).padStart(w, '0')}`;
      }
      return num(digits, value);
    };
    const composite = (sub: string): string => {
      if (width >= 0 || pad !== '') throw new FormatUnsupported(`the date format ${format.slice(start, i + 1)}`);
      const v = strftime(sub, ms, zone);
      return upcase || swapcase ? v.toUpperCase() : v;
    };
    const hour12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
    const offsetText = (colons: number): string => {
      const sign = zone.offset < 0 ? '-' : '+';
      const a = Math.abs(zone.offset);
      const hh = String(Math.floor(a / 3600)).padStart(2, '0');
      const mm = String(Math.floor((a % 3600) / 60)).padStart(2, '0');
      const ss = String(a % 60).padStart(2, '0');
      if (colons === 0) return `${sign}${hh}${mm}`;
      if (colons === 1) return `${sign}${hh}:${mm}`;
      if (colons === 2) return `${sign}${hh}:${mm}:${ss}`;
      return a % 3600 === 0 ? `${sign}${hh}` : a % 60 === 0 ? `${sign}${hh}:${mm}` : `${sign}${hh}:${mm}:${ss}`;
    };

    switch (conv) {
      case '%':
        if (modifier !== '' || width >= 0 || pad !== '') throw new FormatUnsupported(`the date format ${format.slice(start, i + 1)}`);
        out += '%';
        break;
      case 'a':
        out += text((DAYS[t.wday] as string).slice(0, 3));
        break;
      case 'A':
        out += text(DAYS[t.wday] as string);
        break;
      case 'b':
      case 'h':
        out += text((MONTHS[t.month - 1] as string).slice(0, 3));
        break;
      case 'B':
        out += text(MONTHS[t.month - 1] as string);
        break;
      case 'c':
        out += composite('%a %b %e %H:%M:%S %Y');
        break;
      case 'C':
        out += year(Math.floor(t.year / 100), 2);
        break;
      case 'd':
        out += num(2, t.day);
        break;
      case 'D':
        out += composite('%m/%d/%y');
        break;
      case 'e':
        out += num(2, t.day, '_');
        break;
      case 'F':
        out += composite('%+4Y-%m-%d');
        break;
      case 'g':
        out += num(2, ((isoWeek(t).year % 100) + 100) % 100);
        break;
      case 'G':
        out += year(isoWeek(t).year, 4);
        break;
      case 'H':
        out += num(2, t.hour);
        break;
      case 'I':
        out += num(2, hour12);
        break;
      case 'j':
        out += num(3, t.yday + 1);
        break;
      case 'k':
        out += num(2, t.hour, '_');
        break;
      case 'l':
        out += num(2, hour12, '_');
        break;
      case 'm':
        out += num(2, t.month);
        break;
      case 'M':
        out += num(2, t.minute);
        break;
      case 'n':
        out += '\n';
        break;
      case 'N': {
        // The width is the number of digits shown (%3N: milliseconds).
        const digits = String(nanos).padStart(9, '0');
        out += width > 0 && width < 9 ? digits.slice(0, width) : width > 9 ? digits.padEnd(width, '0') : digits;
        break;
      }
      case 'p':
        out += text(t.hour < 12 ? 'AM' : 'PM', true);
        break;
      case 'P':
        out += text(t.hour < 12 ? 'am' : 'pm');
        break;
      case 'q':
        out += num(1, Math.floor((t.month - 1) / 3) + 1);
        break;
      case 'r':
        out += composite('%I:%M:%S %p');
        break;
      case 'R':
        out += composite('%H:%M');
        break;
      case 's':
        out += num(1, Math.floor(ms / 1000));
        break;
      case 'S':
        out += num(2, t.second);
        break;
      case 't':
        out += '\t';
        break;
      case 'T':
        out += composite('%H:%M:%S');
        break;
      case 'u':
        out += num(1, t.wday === 0 ? 7 : t.wday);
        break;
      case 'U':
        out += num(2, Math.floor((t.yday - t.wday + 7) / 7));
        break;
      case 'V':
        out += num(2, isoWeek(t).week);
        break;
      case 'w':
        out += num(1, t.wday);
        break;
      case 'W':
        out += num(2, Math.floor((t.yday - ((t.wday - 1 + 7) % 7) + 7) / 7));
        break;
      case 'x':
        out += composite('%m/%d/%y');
        break;
      case 'X':
        out += composite('%H:%M:%S');
        break;
      case 'y':
        out += num(2, ((t.year % 100) + 100) % 100);
        break;
      case 'Y':
        out += year(t.year, 4);
        break;
      case 'z':
        out += offsetText(0);
        break;
      case ':': {
        // %:z %::z %:::z
        let colons = 0;
        let j = i;
        while (format[j] === ':' && colons < 3) {
          colons++;
          j++;
        }
        if (format[j] !== 'z') {
          out += bad();
          break;
        }
        i = j;
        out += offsetText(colons);
        break;
      }
      case 'Z':
        out += text(zone.abbrev, true);
        break;
      default:
        out += bad();
    }
  }
  return out;
}
