// date — print or set the system date and time. GNU coreutils 9.4.
//   docs: date --help and date(1) of coreutils 9.4
//   upstream: coreutils src/date.c main, batch_convert, show_date; gnulib posixtime
//   reference: coreutils 9.4 date, captured 2026-11-16 (packages/host/transcripts/coreutils/date.t)
// The time is the kernel's virtual clock. Machines run in UTC: TZ unset or empty, or naming UTC
// or GMT, is supported; another zone gets the notice (there is no time zone database). Setting
// the clock needs CAP_SYS_TIME: an ordinary user gets EPERM, as on Linux, and root the notice.
// Formatting is date-format.ts, -d strings date-parse.ts.

import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { civilFromMillis, millisFromCivil } from '@simlab/kernel';
import { isFsError, strerror } from '../../vfs/errno.ts';
import { openInput, parseArgs, readAll, usageError, warn } from '../lib/io.ts';
import { quote, quotef } from '../lib/quote.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { FormatUnsupported, strftime, type Zone } from './date-format.ts';
import { parseDate } from './date-parse.ts';

/** `date --help`; NUL stands for argv[0]. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: \u0000 [OPTION]... [+FORMAT]\n  or:  \u0000 [-u|--utc|--universal] [MMDDhhmm[[CC]YY][.ss]]\nDisplay date and time in the given FORMAT.\nWith -s, or with [MMDDhhmm[[CC]YY][.ss]], set the date and time.\n\nMandatory arguments to long options are mandatory for short options too.\n  -d, --date=STRING          display time described by STRING, not 'now'\n      --debug                annotate the parsed date,\n                              and warn about questionable usage to stderr\n  -f, --file=DATEFILE        like --date; once for each line of DATEFILE\n  -I[FMT], --iso-8601[=FMT]  output date/time in ISO 8601 format.\n                               FMT='date' for date only (the default),\n                               'hours', 'minutes', 'seconds', or 'ns'\n                               for date and time to the indicated precision.\n                               Example: 2006-08-14T02:34:56-06:00\n  --resolution               output the available resolution of timestamps\n                               Example: 0.000000001\n  -R, --rfc-email            output date and time in RFC 5322 format.\n                               Example: Mon, 14 Aug 2006 02:34:56 -0600\n      --rfc-3339=FMT         output date/time in RFC 3339 format.\n                               FMT='date', 'seconds', or 'ns'\n                               for date and time to the indicated precision.\n                               Example: 2006-08-14 02:34:56-06:00\n  -r, --reference=FILE       display the last modification time of FILE\n  -s, --set=STRING           set time described by STRING\n  -u, --utc, --universal     print or set Coordinated Universal Time (UTC)\n      --help        display this help and exit\n      --version     output version information and exit\n\nAll options that specify the date to display are mutually exclusive.\nI.e.: --date, --file, --reference, --resolution.\n\nFORMAT controls the output.  Interpreted sequences are:\n\n  %%   a literal %\n  %a   locale's abbreviated weekday name (e.g., Sun)\n  %A   locale's full weekday name (e.g., Sunday)\n  %b   locale's abbreviated month name (e.g., Jan)\n  %B   locale's full month name (e.g., January)\n  %c   locale's date and time (e.g., Thu Mar  3 23:05:25 2005)\n  %C   century; like %Y, except omit last two digits (e.g., 20)\n  %d   day of month (e.g., 01)\n  %D   date; same as %m/%d/%y\n  %e   day of month, space padded; same as %_d\n  %F   full date; like %+4Y-%m-%d\n  %g   last two digits of year of ISO week number (see %G)\n  %G   year of ISO week number (see %V); normally useful only with %V\n  %h   same as %b\n  %H   hour (00..23)\n  %I   hour (01..12)\n  %j   day of year (001..366)\n  %k   hour, space padded ( 0..23); same as %_H\n  %l   hour, space padded ( 1..12); same as %_I\n  %m   month (01..12)\n  %M   minute (00..59)\n  %n   a newline\n  %N   nanoseconds (000000000..999999999)\n  %p   locale's equivalent of either AM or PM; blank if not known\n  %P   like %p, but lower case\n  %q   quarter of year (1..4)\n  %r   locale's 12-hour clock time (e.g., 11:11:04 PM)\n  %R   24-hour hour and minute; same as %H:%M\n  %s   seconds since the Epoch (1970-01-01 00:00 UTC)\n  %S   second (00..60)\n  %t   a tab\n  %T   time; same as %H:%M:%S\n  %u   day of week (1..7); 1 is Monday\n  %U   week number of year, with Sunday as first day of week (00..53)\n  %V   ISO week number, with Monday as first day of week (01..53)\n  %w   day of week (0..6); 0 is Sunday\n  %W   week number of year, with Monday as first day of week (00..53)\n  %x   locale's date representation (e.g., 12/31/99)\n  %X   locale's time representation (e.g., 23:13:48)\n  %y   last two digits of year (00..99)\n  %Y   year\n  %z   +hhmm numeric time zone (e.g., -0400)\n  %:z  +hh:mm numeric time zone (e.g., -04:00)\n  %::z  +hh:mm:ss numeric time zone (e.g., -04:00:00)\n  %:::z  numeric time zone with : to necessary precision (e.g., -04, +05:30)\n  %Z   alphabetic time zone abbreviation (e.g., EDT)\n\nBy default, date pads numeric fields with zeroes.\nThe following optional flags may follow '%':\n\n  -  (hyphen) do not pad the field\n  _  (underscore) pad with spaces\n  0  (zero) pad with zeros\n  +  pad with zeros, and put '+' before future years with >4 digits\n  ^  use upper case if possible\n  #  use opposite case if possible\n\nAfter any flags comes an optional field width, as a decimal number;\nthen an optional modifier, which is either\nE to use the locale's alternate representations if available, or\nO to use the locale's alternate numeric symbols if available.\n\nExamples:\nConvert seconds since the Epoch (1970-01-01 UTC) to a date\n  $ date --date='@2147483647'\n\nShow the time on the west coast of the US (use tzselect(1) to find TZ)\n  $ TZ='America/Los_Angeles' date\n\nShow the local time for 9AM next Friday on the west coast of the US\n  $ date --date='TZ=\"America/Los_Angeles\" 09:00 next Fri'\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/date>\nor available locally via: info '(coreutils) date invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'd', long: 'date', arg: 'required' },
  { long: 'debug', supported: false },
  { short: 'f', long: 'file', arg: 'required' },
  { short: 'I', long: 'iso-8601', arg: 'optional' },
  { long: 'resolution', supported: false },
  { short: 'R', long: 'rfc-email' },
  { long: 'rfc-3339', arg: 'required' },
  { short: 'r', long: 'reference', arg: 'required' },
  { short: 's', long: 'set', arg: 'required' },
  { short: 'u', long: 'utc' },
  { long: 'universal', id: 'utc' },
  { long: 'help' },
  { long: 'version' },
];

/** The C locale's date_fmt. */
const DEFAULT_FORMAT = '%a %b %e %H:%M:%S %Z %Y';
const RFC_EMAIL = '%a, %d %b %Y %H:%M:%S %z';
/** --iso-8601 arguments in date.c's order, which its error message lists. */
const ISO: [string, string][] = [
  ['hours', '%Y-%m-%dT%H%:z'],
  ['minutes', '%Y-%m-%dT%H:%M%:z'],
  ['date', '%Y-%m-%d'],
  ['seconds', '%Y-%m-%dT%H:%M:%S%:z'],
  ['ns', '%Y-%m-%dT%H:%M:%S,%N%:z'],
];
const RFC3339: [string, string][] = [
  ['date', '%Y-%m-%d'],
  ['seconds', '%Y-%m-%d %H:%M:%S%:z'],
  ['ns', '%Y-%m-%d %H:%M:%S.%N%:z'],
];

/** TZ values that name UTC or GMT. reference: `TZ=… date +%Z`, captured 2026-11-16 */
const UTC_NAMES = new Set(['UTC', 'UTC0', 'Etc/UTC', ':UTC', ':Etc/UTC', 'Universal', 'Zulu', 'UCT', 'UTC+0']);
const GMT_NAMES = new Set(['GMT', 'GMT0', 'Etc/GMT', 'GMT+0']);

class Fail extends Error {
  readonly status: number;
  constructor(status: number) {
    super('date failed');
    this.status = status;
  }
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP.split('\u0000').join(p.argv[0] ?? p.name));
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });

  /** argmatch: an exact or unambiguous abbreviated argument, else coreutils' message and usage. */
  const argmatch = function* (option: string, value: string, table: [string, string][]): Op<string> {
    const exact = table.find(([k]) => k === value);
    if (exact) return exact[1];
    const cands = table.filter(([k]) => k.startsWith(value));
    if (cands.length === 1) return (cands[0] as [string, string])[1];
    yield* warn(p, `${cands.length === 0 ? 'invalid' : 'ambiguous'} argument ${quote(value)} for ${quote(option)}`);
    yield* p.write(2, `Valid arguments are:\n${table.map(([k]) => `  - ${quote(k)}\n`).join('')}Try '${p.name} --help' for more information.\n`);
    throw new Fail(1);
  };

  let format: string | undefined;
  let datestr: string | undefined;
  let batch: string | undefined;
  let reference: string | undefined;
  let setDatestr: string | undefined;
  let utc = false;
  try {
    for (const o of args.options) {
      let fmt: string | undefined;
      switch (o.id) {
        case 'date':
          datestr = o.value;
          break;
        case 'file':
          batch = o.value;
          break;
        case 'reference':
          reference = o.value;
          break;
        case 'set':
          setDatestr = o.value;
          break;
        case 'utc':
          utc = true;
          break;
        case 'rfc-email':
          fmt = RFC_EMAIL;
          break;
        case 'rfc-3339':
          fmt = yield* argmatch('--rfc-3339', o.value ?? '', RFC3339);
          break;
        case 'iso-8601':
          fmt = o.value === undefined ? '%Y-%m-%d' : yield* argmatch('--iso-8601', o.value, ISO);
          break;
      }
      if (fmt !== undefined) {
        if (format !== undefined) {
          yield* warn(p, 'multiple output formats specified');
          return 1;
        }
        format = fmt;
      }
    }
  } catch (e) {
    if (e instanceof Fail) return e.status;
    throw e;
  }
  const specified = Number(datestr !== undefined) + Number(batch !== undefined) + Number(reference !== undefined);
  const setting = setDatestr !== undefined;
  if (specified > 1) return yield* usageError(p, 'the options to specify dates for printing are mutually exclusive');
  if (setting && specified > 0) return yield* usageError(p, 'the options to print and set the time may not be used together');
  const operands = args.operands;
  let posixOperand: string | undefined;
  if (operands.length > 0) {
    if (operands.length > 1) return yield* usageError(p, `extra operand ${quote(operands[1] as string)}`);
    const op = operands[0] as string;
    if (op.startsWith('+')) {
      if (format !== undefined) {
        yield* warn(p, 'multiple output formats specified');
        return 1;
      }
      format = op.slice(1);
    } else if (setting || specified > 0) {
      return yield* usageError(p, `the argument ${quote(op)} lacks a leading '+';\nwhen using an option to specify date(s), any non-option\nargument must be a format string beginning with '+'`);
    } else posixOperand = op;
  }
  format ??= DEFAULT_FORMAT;

  // The zone: -u sets TZ=UTC0; otherwise TZ, and the machine's /etc/localtime (UTC) when unset.
  const tz = utc ? 'UTC0' : p.env['TZ'];
  let zone: Zone;
  if (tz === undefined || tz === '' || UTC_NAMES.has(tz)) zone = { abbrev: 'UTC', offset: 0 };
  else if (GMT_NAMES.has(tz)) zone = { abbrev: 'GMT', offset: 0 };
  else return yield* p.unsupported({ kind: 'behavior', what: `the time zone TZ=${tz}`, hints: ['the simulated machines run in UTC; TZ=UTC or an unset TZ works'] });

  const show = function* (ms: number): Op<void> {
    let text: string;
    try {
      text = strftime(format as string, ms, zone);
    } catch (e) {
      if (e instanceof FormatUnsupported) return yield* p.unsupported({ kind: 'flag-value', what: e.message });
      throw e;
    }
    yield* p.write(1, `${text}\n`);
  };
  const parse = function* (s: string): Op<number | undefined> {
    const r = parseDate(s, p.now);
    if (r.ok) return r.ms;
    if ('unsupported' in r) return yield* p.unsupported({ kind: 'flag-value', what: r.unsupported, hints: ['date -d understands @SECONDS, YYYY-MM-DD [HH:MM[:SS]], ISO 8601 with T and Z or an offset, now, today, tomorrow, yesterday and items like "2 days ago"'] });
    return undefined;
  };

  if (batch !== undefined) {
    const opened = openInput(p, batch, 3);
    if (!opened.ok) {
      yield* warn(p, `${quotef(batch)}: ${strerror(opened.error.code)}`);
      return 1;
    }
    let status = 0;
    let data: string;
    try {
      data = yield* readAll(p, opened.fd);
    } catch (e) {
      if (!isFsError(e)) throw e;
      yield* warn(p, `${quotef(batch)}: ${strerror(e.code)}`);
      return 1;
    }
    const lines = data.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) {
      const ms = yield* parse(line);
      if (ms === undefined) {
        yield* warn(p, `invalid date ${quote(line)}`);
        status = 1;
      } else yield* show(ms);
    }
    return status;
  }

  let when: number | undefined;
  let source: string;
  if (reference !== undefined) {
    try {
      when = p.fs().stat(reference).mtime;
    } catch (e) {
      if (!isFsError(e)) throw e;
      yield* warn(p, `${quotef(reference)}: ${strerror(e.code)}`);
      return 1;
    }
    source = reference;
  } else if (datestr !== undefined || setDatestr !== undefined) {
    source = (setDatestr ?? datestr) as string;
    when = yield* parse(source);
  } else if (posixOperand !== undefined) {
    source = posixOperand;
    when = posixtime(posixOperand, p.now);
  } else {
    source = '';
    when = p.now;
  }
  if (when === undefined) {
    yield* warn(p, `invalid date ${quote(source)}`);
    return 1;
  }
  let status = 0;
  if (setting || posixOperand !== undefined) {
    // clock_settime(2) needs CAP_SYS_TIME; the date is printed either way.
    if (p.cred.uid !== 0) {
      yield* warn(p, `cannot set date: ${strerror('EPERM')}`);
      status = 1;
    } else return yield* p.unsupported({ kind: 'behavior', what: 'setting the system clock' });
  }
  yield* show(when);
  return status;
}

/**
 * gnulib posixtime with PDS_TRAILING_YEAR | PDS_CENTURY | PDS_SECONDS: MMDDhhmm[[CC]YY][.ss],
 * the year defaulting to the current one. Undefined when malformed or out of range.
 */
export function posixtime(s: string, now: number): number | undefined {
  const m = /^([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2}|[0-9]{4})?(?:\.([0-9]{2}))?$/.exec(s);
  if (!m) return undefined;
  const [mon, day, hour, min] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  let year = civilFromMillis(now).year;
  if (m[5] !== undefined) {
    const v = Number(m[5]);
    year = m[5].length === 4 ? v : v >= 69 ? 1900 + v : 2000 + v;
  }
  const sec = m[6] === undefined ? 0 : Number(m[6]);
  if (mon < 1 || mon > 12 || day < 1 || hour > 23 || min > 59 || sec > 59) return undefined;
  const ms = millisFromCivil(year, mon, day, hour, min, sec);
  // mktime would move an impossible day (Feb 30) into the next month: posixtime rejects it.
  if (civilFromMillis(ms).day !== day) return undefined;
  return ms;
}

export const dateProgram: ProgramSpec = { name: 'date', main };
