// Time stamps of ls -l: the --time-style formats and the strftime conversions they use, in the
// C.UTF-8 locale and UTC (the simulated machines' zone).
//   upstream: coreutils src/ls.c decode_switches (time styles, long_time_format), print_long_format
//             (six months = 31556952 / 2 seconds); gnulib nstrftime
//   docs: strftime(3), date(1) of coreutils 9.4
//   reference: coreutils 9.4 ls -l, --full-time, --time-style=long-iso|iso|locale|+FORMAT and the
//              "invalid argument" listing for a bad style, captured 2026-11-16
//              (packages/host/transcripts/coreutils/ls-time.t)

import { civilFromMillis, millisFromCivil, type Millis } from '@simlab/kernel';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** [format for old or future files, format for recent files]. */
export type TimeFormats = [string, string];

/** The locale's (C) formats: `Nov 10 08:30` and `Jan  2  2025`. */
export const LOCALE_FORMATS: TimeFormats = ['%b %e  %Y', '%b %e %H:%M'];

export type TimeStyle = { ok: true; formats: TimeFormats } | { ok: false; error: 'invalid' | 'format' };

/** A --time-style or TIME_STYLE value. `posix-` styles apply outside the POSIX locale, and C.UTF-8 is not it. */
export function parseTimeStyle(style: string): TimeStyle {
  let s = style;
  while (s.startsWith('posix-')) s = s.slice(6);
  if (s.startsWith('+')) {
    const f = s.slice(1);
    const nl = f.indexOf('\n');
    if (nl < 0) return { ok: true, formats: [f, f] };
    if (f.indexOf('\n', nl + 1) >= 0) return { ok: false, error: 'format' };
    return { ok: true, formats: [f.slice(0, nl), f.slice(nl + 1)] };
  }
  switch (s) {
    case 'full-iso':
      return { ok: true, formats: ['%Y-%m-%d %H:%M:%S.%N %z', '%Y-%m-%d %H:%M:%S.%N %z'] };
    case 'long-iso':
      return { ok: true, formats: ['%Y-%m-%d %H:%M', '%Y-%m-%d %H:%M'] };
    case 'iso':
      return { ok: true, formats: ['%Y-%m-%d ', '%m-%d %H:%M'] };
    case 'locale':
      return { ok: true, formats: LOCALE_FORMATS };
    default:
      return { ok: false, error: 'invalid' };
  }
}

/**
 * Whether a time is shown in the recent format: within the past six months, not in the future.
 * ls requires the time to be before "now"; a time equal to now counts as past here because the
 * simulated clock can stand still between a write and the ls that follows, which a real clock
 * with nanoseconds never does.
 */
export function isRecent(t: Millis, now: Millis): boolean {
  const sixMonthsAgo = now - (31556952 / 2) * 1000;
  return sixMonthsAgo < t && t <= now;
}

export type Strftime = { ok: true; text: string } | { ok: false; conversion: string };

const pad = (n: number, width: number, fill: string): string => String(n).padStart(width, fill);

/** strftime with the conversions and flags a time style uses; others are reported, not guessed. */
export function strftime(format: string, t: Millis): Strftime {
  const c = civilFromMillis(t);
  const days = Math.floor(t / 86400000);
  const weekday = (((days + 4) % 7) + 7) % 7;
  const yday = Math.floor((t - millisFromCivil(c.year, 1, 1)) / 86400000);
  const seconds = Math.floor(t / 1000);
  const nanos = (((t % 1000) + 1000) % 1000) * 1_000_000;
  let out = '';
  for (let i = 0; i < format.length; i++) {
    const ch = format[i] as string;
    if (ch !== '%') {
      out += ch;
      continue;
    }
    const m = /^([-_0^#]*)(\d*)(:{0,3}[a-zA-Z%+])/.exec(format.slice(i + 1));
    if (!m) {
      out += ch;
      continue;
    }
    const flags = m[1] as string;
    const width = m[2] === '' ? undefined : Number(m[2]);
    const conv = m[3] as string;
    i += m[0].length;
    const num = (n: number, w: number, fill = '0'): string => {
      if (flags.includes('-')) return String(n);
      const f = flags.includes('_') ? ' ' : flags.includes('0') ? '0' : fill;
      return pad(n, width ?? w, f);
    };
    const text = (s: string): string => {
      const v = flags.includes('^') ? s.toUpperCase() : flags.includes('#') ? s.toUpperCase() : s;
      return width !== undefined ? v.padStart(width, flags.includes('0') ? '0' : ' ') : v;
    };
    switch (conv) {
      case 'Y':
        out += num(c.year, 1);
        break;
      case 'C':
        out += num(Math.floor(c.year / 100), 2);
        break;
      case 'y':
        out += num(c.year % 100, 2);
        break;
      case 'm':
        out += num(c.month, 2);
        break;
      case 'd':
        out += num(c.day, 2);
        break;
      case 'e':
        out += num(c.day, 2, ' ');
        break;
      case 'H':
        out += num(c.hour, 2);
        break;
      case 'k':
        out += num(c.hour, 2, ' ');
        break;
      case 'I':
        out += num(c.hour % 12 || 12, 2);
        break;
      case 'l':
        out += num(c.hour % 12 || 12, 2, ' ');
        break;
      case 'M':
        out += num(c.minute, 2);
        break;
      case 'S':
        out += num(c.second, 2);
        break;
      case 'j':
        out += num(yday + 1, 3);
        break;
      case 'u':
        out += num(weekday || 7, 1);
        break;
      case 'w':
        out += num(weekday, 1);
        break;
      case 's':
        out += num(seconds, 1);
        break;
      case 'N': {
        const digits = String(nanos).padStart(9, '0');
        out += width !== undefined ? digits.slice(0, width).padEnd(width, '0') : digits;
        break;
      }
      case 'b':
      case 'h':
        out += text(MONTHS[c.month - 1] as string);
        break;
      case 'B':
        out += text(MONTHS_FULL[c.month - 1] as string);
        break;
      case 'a':
        out += text(DAYS[weekday] as string);
        break;
      case 'A':
        out += text(DAYS_FULL[weekday] as string);
        break;
      case 'p':
        out += text(c.hour < 12 ? 'AM' : 'PM');
        break;
      case 'P':
        out += text(c.hour < 12 ? 'am' : 'pm');
        break;
      case 'z':
        out += '+0000';
        break;
      case ':z':
        out += '+00:00';
        break;
      case 'Z':
        out += text('UTC');
        break;
      case 'F':
        out += `${num(c.year, 4)}-${pad(c.month, 2, '0')}-${pad(c.day, 2, '0')}`;
        break;
      case 'D':
        out += `${pad(c.month, 2, '0')}/${pad(c.day, 2, '0')}/${pad(c.year % 100, 2, '0')}`;
        break;
      case 'T':
        out += `${pad(c.hour, 2, '0')}:${pad(c.minute, 2, '0')}:${pad(c.second, 2, '0')}`;
        break;
      case 'R':
        out += `${pad(c.hour, 2, '0')}:${pad(c.minute, 2, '0')}`;
        break;
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case '%':
        out += '%';
        break;
      case 'r':
        // The C locale's t_fmt_ampm, d_fmt, t_fmt and d_t_fmt (glibc locale/C-time.c).
        out += `${pad(c.hour % 12 || 12, 2, '0')}:${pad(c.minute, 2, '0')}:${pad(c.second, 2, '0')} ${c.hour < 12 ? 'AM' : 'PM'}`;
        break;
      case 'x':
        out += `${pad(c.month, 2, '0')}/${pad(c.day, 2, '0')}/${pad(c.year % 100, 2, '0')}`;
        break;
      case 'X':
        out += `${pad(c.hour, 2, '0')}:${pad(c.minute, 2, '0')}:${pad(c.second, 2, '0')}`;
        break;
      case 'c':
        out += `${DAYS[weekday] as string} ${MONTHS[c.month - 1] as string} ${pad(c.day, 2, ' ')} ${pad(c.hour, 2, '0')}:${pad(c.minute, 2, '0')}:${pad(c.second, 2, '0')} ${c.year}`;
        break;
      default:
        // Conversions strftime knows but this one does not: the notice. Unknown ones are copied
        // as written, as nstrftime does (`--time-style=+%Q` prints `%Q`).
        if (/^(:{1,3}z|[gGUVWqOE+])$/.test(conv)) return { ok: false, conversion: `%${conv}` };
        out += `%${m[0]}`;
    }
  }
  return { ok: true, text: out };
}
