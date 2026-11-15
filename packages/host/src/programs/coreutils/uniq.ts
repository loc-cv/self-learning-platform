// uniq — report or omit repeated lines. GNU coreutils 9.4.
//   docs: uniq --help and uniq(1) of coreutils 9.4
//   upstream: coreutils src/uniq.c (main, size_opt, find_field, different, check_file)
//   reference: coreutils 9.4 uniq, captured 2026-11-16 (packages/host/transcripts/coreutils/uniq.t)
// Streams: each group is written as soon as the next different line (or end of input) shows it
// complete. Comparisons are on bytes, case folding (-i) on ASCII, as uniq does in C.UTF-8.

import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { isFsError, strerror } from '../../vfs/errno.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { openInput, parseArgs, usageError, warn } from '../lib/io.ts';
import { toOctets } from '../lib/octets.ts';
import { quote, quoteaf, quotef } from '../lib/quote.ts';
import { chooseArg, readSome } from '../lib/textio.ts';

/** `uniq --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: uniq [OPTION]... [INPUT [OUTPUT]]\nFilter adjacent matching lines from INPUT (or standard input),\nwriting to OUTPUT (or standard output).\n\nWith no options, matching lines are merged to the first occurrence.\n\nMandatory arguments to long options are mandatory for short options too.\n  -c, --count           prefix lines by the number of occurrences\n  -d, --repeated        only print duplicate lines, one for each group\n  -D                    print all duplicate lines\n      --all-repeated[=METHOD]  like -D, but allow separating groups\n                                 with an empty line;\n                                 METHOD={none(default),prepend,separate}\n  -f, --skip-fields=N   avoid comparing the first N fields\n      --group[=METHOD]  show all items, separating groups with an empty line;\n                          METHOD={separate(default),prepend,append,both}\n  -i, --ignore-case     ignore differences in case when comparing\n  -s, --skip-chars=N    avoid comparing the first N characters\n  -u, --unique          only print unique lines\n  -z, --zero-terminated     line delimiter is NUL, not newline\n  -w, --check-chars=N   compare no more than N characters in lines\n      --help        display this help and exit\n      --version     output version information and exit\n\nA field is a run of blanks (usually spaces and/or TABs), then non-blank\ncharacters.  Fields are skipped before chars.\n\nNote: 'uniq' does not detect repeated lines unless they are adjacent.\nYou may want to sort the input first, or use 'sort -u' without 'uniq'.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/uniq>\nor available locally via: info '(coreutils) uniq invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'c', long: 'count' },
  { short: 'd', long: 'repeated' },
  { short: 'D', id: 'D' },
  { long: 'all-repeated', arg: 'optional' },
  { short: 'f', long: 'skip-fields', arg: 'required' },
  { long: 'group', arg: 'optional' },
  { short: 'i', long: 'ignore-case' },
  { short: 's', long: 'skip-chars', arg: 'required' },
  { short: 'u', long: 'unique' },
  { short: 'z', long: 'zero-terminated', supported: false },
  { short: 'w', long: 'check-chars', arg: 'required' },
  { long: 'help' },
  { long: 'version' },
  // upstream: uniq.c, the obsolete -N (skip N fields).
  ...[...'0123456789'].map((d): OptionSpec => ({ short: d, id: 'digit', supported: false })),
];

type Delimit = 'none' | 'prepend' | 'separate';
type Grouping = 'separate' | 'prepend' | 'append' | 'both';

/** upstream: uniq.c size_opt — a non-negative decimal; larger values saturate. */
function sizeOpt(s: string): number | undefined {
  const m = /^[ \t\n\v\f\r]*\+?([0-9]+)$/.exec(s);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isSafeInteger(v) ? v : Number.MAX_SAFE_INTEGER;
}

interface Settings {
  skipFields: number;
  skipChars: number;
  checkChars: number;
  ignoreCase: boolean;
}

const isBlank = (b: number): boolean => b === 0x20 || b === 0x09;

/** The bytes of a line uniq compares. upstream: uniq.c find_field */
function compared(line: string, st: Settings): number[] {
  const b = toOctets(line);
  let i = 0;
  for (let f = 0; f < st.skipFields && i < b.length; f++) {
    while (i < b.length && isBlank(b[i] as number)) i++;
    while (i < b.length && !isBlank(b[i] as number)) i++;
  }
  i = Math.min(b.length, i + st.skipChars);
  let out = b.slice(i, Math.min(b.length, i + st.checkChars));
  if (st.ignoreCase) out = out.map((c) => (c >= 0x61 && c <= 0x7a ? c - 32 : c));
  return out;
}

const same = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, k) => x === b[k]);

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  const st: Settings = { skipFields: 0, skipChars: 0, checkChars: Number.MAX_SAFE_INTEGER, ignoreCase: false };
  let count = false;
  let repeated = false;
  let unique = false;
  let allRepeated = false;
  let delimit: Delimit = 'none';
  let grouping: Grouping | undefined;
  for (const o of args.options) {
    const v = o.value ?? '';
    switch (o.id) {
      case 'count':
        count = true;
        break;
      case 'repeated':
        repeated = true;
        break;
      case 'D':
        allRepeated = true;
        break;
      case 'all-repeated': {
        allRepeated = true;
        if (o.value !== undefined) {
          const r = yield* chooseArg(p, '--all-repeated', v, [['none', 'none'], ['prepend', 'prepend'], ['separate', 'separate']] as const);
          if (typeof r === 'number') return r;
          delimit = r.value;
        }
        break;
      }
      case 'group': {
        grouping = 'separate';
        if (o.value !== undefined) {
          const r = yield* chooseArg(p, '--group', v, [['prepend', 'prepend'], ['append', 'append'], ['separate', 'separate'], ['both', 'both']] as const);
          if (typeof r === 'number') return r;
          grouping = r.value;
        }
        break;
      }
      case 'skip-fields':
      case 'skip-chars':
      case 'check-chars': {
        const n = sizeOpt(v);
        if (n === undefined) {
          const what = o.id === 'skip-fields' ? 'invalid number of fields to skip' : o.id === 'skip-chars' ? 'invalid number of bytes to skip' : 'invalid number of bytes to compare';
          yield* warn(p, `${v}: ${what}`);
          return 1;
        }
        if (o.id === 'skip-fields') st.skipFields = n;
        else if (o.id === 'skip-chars') st.skipChars = n;
        else st.checkChars = n;
        break;
      }
      case 'ignore-case':
        st.ignoreCase = true;
        break;
      case 'unique':
        unique = true;
        break;
      case 'help':
        yield* p.write(1, HELP);
        return 0;
      case 'version':
        return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
    }
  }
  // Operands: INPUT and OUTPUT; "+N" is the obsolete form of -s N. upstream: uniq.c main, case 1
  const files: string[] = [];
  for (const a of args.operands) {
    const plus = /^\+/.test(a) ? sizeOpt(a.slice(1)) : undefined;
    if (plus !== undefined && /^\+[0-9]+$/.test(a)) st.skipChars = plus;
    else if (files.length === 2) return yield* usageError(p, `extra operand ${quote(a)}`);
    else files.push(a);
  }
  if (grouping !== undefined && (count || repeated || allRepeated || unique)) return yield* usageError(p, '--group is mutually exclusive with -c/-d/-D/-u');
  if (count && allRepeated) return yield* usageError(p, 'printing all duplicated lines and repeat counts is meaningless');

  const input = files[0] ?? '-';
  const opened = openInput(p, input, 3);
  if (!opened.ok) {
    yield* warn(p, `${quotef(input)}: ${strerror(opened.error.code)}`);
    return 1;
  }
  let out = 1;
  const output = files[1];
  if (output !== undefined && output !== '-') {
    try {
      out = p.open(output, { write: true, create: true, truncate: true });
    } catch (e) {
      if (!isFsError(e)) throw e;
      yield* warn(p, `${quotef(output)}: ${strerror(e.code)}`);
      return 1;
    }
  }

  // What is printed of each group. upstream: uniq.c check_file, with output_unique cleared by
  // -d and -D and output_first_repeated by -u.
  const outUnique = !repeated && !allRepeated;
  const outFirstRepeated = !unique;
  let firstGroupDone = false;
  const emitGroup = function* (lines: string[]): Op<void> {
    const n = lines.length;
    let text = '';
    if (grouping !== undefined) {
      // One delimiter between groups; prepend and both also put one first, append and both last.
      if (grouping === 'prepend' || grouping === 'both' || firstGroupDone) text += '\n';
      text += lines.join('');
    } else if (allRepeated) {
      if (n > 1) {
        if (delimit === 'prepend' || (delimit === 'separate' && firstGroupDone)) text += '\n';
        text += lines.join('');
      }
    } else if ((n === 1 && outUnique) || (n > 1 && outFirstRepeated)) {
      text += count ? `${String(n).padStart(7)} ${lines[0]}` : (lines[0] as string);
    }
    if (text !== '') {
      if (grouping !== undefined || allRepeated) firstGroupDone = true;
      yield* p.write(out, text);
    }
  };
  const terminated = (l: string): string => (l.endsWith('\n') ? l : `${l}\n`);

  let status = 0;
  let group: string[] = [];
  let key: number[] = [];
  try {
    for (;;) {
      const line = yield* readSome(p, opened.fd, { line: true });
      if (line === null) break;
      const body = line.endsWith('\n') ? line.slice(0, -1) : line;
      const k = compared(body, st);
      if (group.length > 0 && !same(k, key)) {
        yield* emitGroup(group);
        group = [];
      }
      if (group.length === 0) key = k;
      group.push(terminated(line));
    }
  } catch (e) {
    if (!isFsError(e)) throw e;
    yield* warn(p, `error reading ${quoteaf(input)}: ${strerror(e.code)}`);
    status = 1;
  }
  if (group.length > 0) yield* emitGroup(group);
  if ((grouping === 'append' || grouping === 'both') && firstGroupDone) yield* p.write(out, '\n');
  if (opened.fd !== 0) p.close(opened.fd);
  if (out !== 1) p.close(out);
  return status;
}

export const uniqProgram: ProgramSpec = { name: 'uniq', main };
