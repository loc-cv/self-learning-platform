// cut — remove sections from each line of files. GNU coreutils 9.4.
//   docs: cut --help and cut(1) of coreutils 9.4
//   upstream: coreutils src/cut.c (main, cut_bytes, cut_fields), src/set-fields.c (set_fields)
//   reference: coreutils 9.4 cut, captured 2026-11-16 (packages/host/transcripts/coreutils/cut.t)
// Streams line by line. -c selects bytes exactly as -b does: cut 9.4 has no multibyte support, so
// cutting inside a UTF-8 character leaves an invalid byte (shown as U+FFFD).

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { utf8Length } from '../../utf8.ts';
import { isFsError, strerror } from '../../vfs/errno.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { openInput, parseArgs, usageError, warn } from '../lib/io.ts';
import { fromOctets, toOctets } from '../lib/octets.ts';
import { quote, quotef } from '../lib/quote.ts';
import { readSome } from '../lib/textio.ts';

/** `cut --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: cut OPTION... [FILE]...\nPrint selected parts of lines from each FILE to standard output.\n\nWith no FILE, or when FILE is -, read standard input.\n\nMandatory arguments to long options are mandatory for short options too.\n  -b, --bytes=LIST        select only these bytes\n  -c, --characters=LIST   select only these characters\n  -d, --delimiter=DELIM   use DELIM instead of TAB for field delimiter\n  -f, --fields=LIST       select only these fields;  also print any line\n                            that contains no delimiter character, unless\n                            the -s option is specified\n  -n                      (ignored)\n      --complement        complement the set of selected bytes, characters\n                            or fields\n  -s, --only-delimited    do not print lines not containing delimiters\n      --output-delimiter=STRING  use STRING as the output delimiter\n                            the default is to use the input delimiter\n  -z, --zero-terminated   line delimiter is NUL, not newline\n      --help        display this help and exit\n      --version     output version information and exit\n\nUse one, and only one of -b, -c or -f.  Each LIST is made up of one\nrange, or many ranges separated by commas.  Selected input is written\nin the same order that it is read, and is written exactly once.\nEach range is one of:\n\n  N     N'th byte, character or field, counted from 1\n  N-    from N'th byte, character or field, to end of line\n  N-M   from N'th to M'th (included) byte, character or field\n  -M    from first to M'th (included) byte, character or field\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/cut>\nor available locally via: info '(coreutils) cut invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'b', long: 'bytes', arg: 'required' },
  { short: 'c', long: 'characters', arg: 'required' },
  { short: 'd', long: 'delimiter', arg: 'required' },
  { short: 'f', long: 'fields', arg: 'required' },
  // upstream: cut.c, -n is accepted and ignored (the help says "(ignored)").
  { short: 'n', id: 'n' },
  { long: 'complement' },
  { short: 's', long: 'only-delimited' },
  { long: 'output-delimiter', arg: 'required' },
  { short: 'z', long: 'zero-terminated', supported: false },
  { long: 'help' },
  { long: 'version' },
];

/** Selected ranges, 1-based and inclusive, sorted and merged; `hi` may be Infinity. */
type Ranges = { lo: number; hi: number }[];

/** upstream: set-fields.c set_fields. Returns the ranges or the error message (usage follows). */
export function setFields(spec: string, positions: boolean, complement: boolean): Ranges | string {
  const numbered = positions ? 'byte/character positions are numbered from 1' : 'fields are numbered from 1';
  const ranges: Ranges = [];
  let initial = 1;
  let value = 0;
  let lhs = false;
  let rhs = false;
  let dash = false;
  let numStart = -1;
  for (let i = 0; ; i++) {
    const c = spec[i];
    if (c === '-') {
      numStart = -1;
      if (dash) return positions ? 'invalid byte or character range' : 'invalid field range';
      dash = true;
      if (lhs && value === 0) return numbered;
      initial = lhs ? value : 1;
      value = 0;
    } else if (c === undefined || c === ',' || c === ' ' || c === '\t') {
      numStart = -1;
      if (dash) {
        dash = false;
        if (!lhs && !rhs) return 'invalid range with no endpoint: -';
        if (!rhs) ranges.push({ lo: initial, hi: Infinity });
        else {
          if (value < initial) return 'invalid decreasing range';
          ranges.push({ lo: initial, hi: value });
        }
        value = 0;
      } else {
        if (value === 0) return numbered;
        ranges.push({ lo: value, hi: value });
        value = 0;
      }
      if (c === undefined) break;
      lhs = rhs = false;
    } else if (c >= '0' && c <= '9') {
      if (numStart < 0) numStart = i;
      if (dash) rhs = true;
      else lhs = true;
      value = value * 10 + Number(c);
      // upstream: the value must stay below UINTMAX_MAX.
      if (value >= 2 ** 64 - 1) {
        const bad = /^[0-9]+/.exec(spec.slice(numStart))?.[0] ?? '';
        return positions ? `byte/character offset ${quote(bad)} is too large` : `field number ${quote(bad)} is too large`;
      }
    } else {
      return positions ? `invalid byte/character position ${quote(spec.slice(i))}` : `invalid field value ${quote(spec.slice(i))}`;
    }
  }
  if (ranges.length === 0) return positions ? 'missing list of byte/character positions' : 'missing list of fields';
  ranges.sort((a, b) => a.lo - b.lo);
  const merged: Ranges = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.lo <= last.hi + 1) last.hi = Math.max(last.hi, r.hi);
    else merged.push({ ...r });
  }
  if (!complement) return merged;
  const out: Ranges = [];
  let next = 1;
  for (const r of merged) {
    if (r.lo > next) out.push({ lo: next, hi: r.lo - 1 });
    next = r.hi + 1;
  }
  if (next !== Infinity) out.push({ lo: next, hi: Infinity });
  return out;
}

const selected = (r: Ranges, n: number): boolean => r.some((x) => n >= x.lo && n <= x.hi);
const rangeStart = (r: Ranges, n: number): boolean => r.some((x) => x.lo === n);

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  let mode: 'bytes' | 'fields' | undefined;
  let list = '';
  let delim: string | undefined;
  let outDelim: string | undefined;
  let complement = false;
  let onlyDelimited = false;
  for (const o of args.options) {
    const v = o.value ?? '';
    switch (o.id) {
      case 'bytes':
      case 'characters':
      case 'fields':
        if (mode !== undefined) return yield* usageError(p, 'only one list may be specified');
        mode = o.id === 'fields' ? 'fields' : 'bytes';
        list = v;
        break;
      case 'delimiter':
        // upstream: cut.c, one byte (no multibyte delimiters in 9.4); an empty one means NUL.
        if (utf8Length(v) > 1) return yield* usageError(p, 'the delimiter must be a single character');
        delim = v === '' ? '\0' : v;
        break;
      case 'output-delimiter':
        outDelim = v;
        break;
      case 'complement':
        complement = true;
        break;
      case 'only-delimited':
        onlyDelimited = true;
        break;
      case 'help':
        yield* p.write(1, HELP);
        return 0;
      case 'version':
        return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
    }
  }
  if (mode === undefined) return yield* usageError(p, 'you must specify a list of bytes, characters, or fields');
  if (mode === 'bytes' && delim !== undefined) return yield* usageError(p, 'an input delimiter may be specified only when operating on fields');
  if (mode === 'bytes' && onlyDelimited) return yield* usageError(p, 'suppressing non-delimited lines makes sense\n\tonly when operating on fields');
  const ranges = setFields(list, mode === 'bytes', complement);
  if (typeof ranges === 'string') return yield* usageError(p, ranges);
  const tab = delim ?? '\t';

  const cutLine = (body: string): string | undefined => {
    if (mode === 'bytes') {
      const bytes = toOctets(body);
      const out: number[] = [];
      let printed = false;
      for (let k = 1; k <= bytes.length; k++) {
        if (!selected(ranges, k)) continue;
        if (outDelim !== undefined && printed && rangeStart(ranges, k)) out.push(...toOctets(outDelim));
        out.push(bytes[k - 1] as number);
        printed = true;
      }
      return fromOctets(out);
    }
    if (!body.includes(tab)) return onlyDelimited ? undefined : body;
    const fields = body.split(tab);
    const picked = fields.filter((_, k) => selected(ranges, k + 1));
    return picked.join(outDelim ?? tab);
  };

  const files = args.operands.length > 0 ? args.operands : ['-'];
  let status = 0;
  for (const name of files) {
    const opened = openInput(p, name, 3);
    if (!opened.ok) {
      yield* warn(p, `${quotef(name)}: ${strerror(opened.error.code)}`);
      status = 1;
      continue;
    }
    try {
      for (;;) {
        const line = yield* readSome(p, opened.fd, { line: true });
        if (line === null) break;
        const out = cutLine(line.endsWith('\n') ? line.slice(0, -1) : line);
        if (out !== undefined) yield* p.write(1, `${out}\n`);
      }
    } catch (e) {
      if (!isFsError(e)) throw e;
      yield* warn(p, `${quotef(name)}: ${strerror(e.code)}`);
      status = 1;
    } finally {
      if (opened.fd !== 0) p.close(opened.fd);
    }
  }
  return status;
}

export const cutProgram: ProgramSpec = { name: 'cut', main };
