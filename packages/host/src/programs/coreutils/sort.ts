// sort — sort lines of text files. GNU coreutils 9.4.
//   docs: sort --help and sort(1) of coreutils 9.4
//   upstream: coreutils src/sort.c (main's option handling, key parsing with parse_field_count,
//             set_ordering and badfieldspec, check_ordering_compatibility, check, mergefps)
//   reference: coreutils 9.4 sort under LANG=C.UTF-8, captured 2026-11-16
//              (packages/host/transcripts/coreutils/sort.t)
// Reads all its input before writing anything, as sort does. Comparisons: sort-compare.ts.

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { ACCESS } from '../../vfs/fs.ts';
import { isFsError, strerror } from '../../vfs/errno.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { openInput, parseArgs, warn } from '../lib/io.ts';
import { quote, quoteaf, quotef } from '../lib/quote.ts';
import { chooseArg, readRest, splitLines } from '../lib/textio.ts';
import { compareLines, isDefaultKey, newKey, type Key, type Order } from './sort-compare.ts';

/** `sort --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: sort [OPTION]... [FILE]...\n  or:  sort [OPTION]... --files0-from=F\nWrite sorted concatenation of all FILE(s) to standard output.\n\nWith no FILE, or when FILE is -, read standard input.\n\nMandatory arguments to long options are mandatory for short options too.\nOrdering options:\n\n  -b, --ignore-leading-blanks  ignore leading blanks\n  -d, --dictionary-order      consider only blanks and alphanumeric characters\n  -f, --ignore-case           fold lower case to upper case characters\n  -g, --general-numeric-sort  compare according to general numerical value\n  -i, --ignore-nonprinting    consider only printable characters\n  -M, --month-sort            compare (unknown) < 'JAN' < ... < 'DEC'\n  -h, --human-numeric-sort    compare human readable numbers (e.g., 2K 1G)\n  -n, --numeric-sort          compare according to string numerical value\n  -R, --random-sort           shuffle, but group identical keys.  See shuf(1)\n      --random-source=FILE    get random bytes from FILE\n  -r, --reverse               reverse the result of comparisons\n      --sort=WORD             sort according to WORD:\n                                general-numeric -g, human-numeric -h, month -M,\n                                numeric -n, random -R, version -V\n  -V, --version-sort          natural sort of (version) numbers within text\n\nOther options:\n\n      --batch-size=NMERGE   merge at most NMERGE inputs at once;\n                            for more use temp files\n  -c, --check, --check=diagnose-first  check for sorted input; do not sort\n  -C, --check=quiet, --check=silent  like -c, but do not report first bad line\n      --compress-program=PROG  compress temporaries with PROG;\n                              decompress them with PROG -d\n      --debug               annotate the part of the line used to sort,\n                              and warn about questionable usage to stderr\n      --files0-from=F       read input from the files specified by\n                            NUL-terminated names in file F;\n                            If F is - then read names from standard input\n  -k, --key=KEYDEF          sort via a key; KEYDEF gives location and type\n  -m, --merge               merge already sorted files; do not sort\n  -o, --output=FILE         write result to FILE instead of standard output\n  -s, --stable              stabilize sort by disabling last-resort comparison\n  -S, --buffer-size=SIZE    use SIZE for main memory buffer\n  -t, --field-separator=SEP  use SEP instead of non-blank to blank transition\n  -T, --temporary-directory=DIR  use DIR for temporaries, not $TMPDIR or /tmp;\n                              multiple options specify multiple directories\n      --parallel=N          change the number of sorts run concurrently to N\n  -u, --unique              with -c, check for strict ordering;\n                              without -c, output only the first of an equal run\n  -z, --zero-terminated     line delimiter is NUL, not newline\n      --help        display this help and exit\n      --version     output version information and exit\n\nKEYDEF is F[.C][OPTS][,F[.C][OPTS]] for start and stop position, where F is a\nfield number and C a character position in the field; both are origin 1, and\nthe stop position defaults to the line's end.  If neither -t nor -b is in\neffect, characters in a field are counted from the beginning of the preceding\nwhitespace.  OPTS is one or more single-letter ordering options [bdfgiMhnRrV],\nwhich override global ordering options for that key.  If no key is given, use\nthe entire line as the key.  Use --debug to diagnose incorrect key usage.\n\nSIZE may be followed by the following multiplicative suffixes:\n% 1% of memory, b 1, K 1024 (default), and so on for M, G, T, P, E, Z, Y, R, Q.\n\n*** WARNING ***\nThe locale specified by the environment affects sort order.\nSet LC_ALL=C to get the traditional sort order that uses\nnative byte values.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/sort>\nor available locally via: info '(coreutils) sort invocation'\n";

/** Exit status of errors other than disorder. upstream: sort.c SORT_FAILURE */
const SORT_FAILURE = 2;

const OPTIONS: OptionSpec[] = [
  { short: 'b', long: 'ignore-leading-blanks', id: 'b' },
  { short: 'd', long: 'dictionary-order', id: 'd' },
  { short: 'f', long: 'ignore-case', id: 'f' },
  { short: 'g', long: 'general-numeric-sort', id: 'g' },
  { short: 'i', long: 'ignore-nonprinting', id: 'i' },
  { short: 'M', long: 'month-sort', id: 'M' },
  { short: 'h', long: 'human-numeric-sort', id: 'h' },
  { short: 'n', long: 'numeric-sort', id: 'n' },
  { short: 'R', long: 'random-sort', supported: false },
  { long: 'random-source', arg: 'required', supported: false },
  { short: 'r', long: 'reverse', id: 'r' },
  { long: 'sort', arg: 'required' },
  { short: 'V', long: 'version-sort', id: 'V' },
  { long: 'batch-size', arg: 'required', supported: false },
  { short: 'c', id: 'c' },
  { long: 'check', arg: 'optional' },
  { short: 'C', id: 'C' },
  { long: 'compress-program', arg: 'required', supported: false },
  { long: 'debug', supported: false },
  { long: 'files0-from', arg: 'required', supported: false },
  { short: 'k', long: 'key', arg: 'required' },
  { short: 'm', long: 'merge' },
  { short: 'o', long: 'output', arg: 'required' },
  { short: 's', long: 'stable' },
  { short: 'S', long: 'buffer-size', arg: 'required', supported: false },
  { short: 't', long: 'field-separator', arg: 'required' },
  { short: 'T', long: 'temporary-directory', arg: 'required', supported: false },
  { long: 'parallel', arg: 'required', supported: false },
  { short: 'u', long: 'unique' },
  { short: 'z', long: 'zero-terminated', supported: false },
  { long: 'help' },
  { long: 'version' },
];

type Blanks = 'start' | 'end' | 'both';

/** upstream: sort.c set_ordering — ordering letters; returns where they stop. */
function setOrdering(s: string, i: number, key: Key, blanks: Blanks): number {
  for (; i < s.length; i++) {
    switch (s[i]) {
      case 'b':
        if (blanks !== 'end') key.skipsblanks = true;
        if (blanks !== 'start') key.skipeblanks = true;
        break;
      case 'd':
        key.ignore = 'nondictionary';
        break;
      case 'f':
        key.translate = true;
        break;
      case 'g':
        key.generalNumeric = true;
        break;
      case 'h':
        key.human = true;
        break;
      case 'i':
        key.ignore ??= 'nonprinting';
        break;
      case 'M':
        key.month = true;
        break;
      case 'n':
        key.numeric = true;
        break;
      case 'R':
        key.random = true;
        break;
      case 'r':
        key.reverse = true;
        break;
      case 'V':
        key.version = true;
        break;
      default:
        return i;
    }
  }
  return i;
}

type Parsed = { ok: true; key: Key } | { ok: false; message: string };

/** upstream: sort.c parse_field_count — digits (overflow saturates); the index after them, or undefined. */
function fieldCount(s: string, i: number): { value: number; next: number } | undefined {
  const m = /^[ \t\n\v\f\r]*\+?([0-9]+)/.exec(s.slice(i));
  if (!m) return undefined;
  const v = Number(m[1]);
  return { value: Number.isSafeInteger(v) ? v : Number.MAX_SAFE_INTEGER, next: i + m[0].length };
}

/** A -k KEYDEF. upstream: sort.c main, case 'k' */
function parseKey(spec: string): Parsed {
  const bad = (what: string): Parsed => ({ ok: false, message: `${what}: invalid field specification ${quote(spec)}` });
  const badCount = (what: string, at: number): Parsed => ({ ok: false, message: `${what}: invalid count at start of ${quote(spec.slice(at))}` });
  const key = newKey();
  const start = fieldCount(spec, 0);
  if (!start) return badCount('invalid number at field start', 0);
  if (start.value === 0) return bad('field number is zero');
  const sword = start.value - 1;
  let schar = 0;
  let i = start.next;
  if (spec[i] === '.') {
    const c = fieldCount(spec, i + 1);
    if (!c) return badCount("invalid number after '.'", i + 1);
    if (c.value === 0) return bad('character offset is zero');
    schar = c.value - 1;
    i = c.next;
  }
  key.sword = sword === 0 && schar === 0 ? 'line' : sword;
  key.schar = schar;
  i = setOrdering(spec, i, key, 'start');
  if (spec[i] !== ',') {
    key.eword = 'line';
    key.echar = 0;
  } else {
    const e = fieldCount(spec, i + 1);
    if (!e) return badCount("invalid number after ','", i + 1);
    if (e.value === 0) return bad('field number is zero');
    key.eword = e.value - 1;
    i = e.next;
    if (spec[i] === '.') {
      const c = fieldCount(spec, i + 1);
      if (!c) return badCount("invalid number after '.'", i + 1);
      key.echar = c.value;
      i = c.next;
    }
    i = setOrdering(spec, i, key, 'end');
  }
  if (i < spec.length) return bad('stray character in field spec');
  return { ok: true, key };
}

/** upstream: sort.c key_to_opts, for the "options '-…' are incompatible" message. */
function keyOpts(k: Key): string {
  let s = '';
  if (k.ignore === 'nondictionary') s += 'd';
  if (k.translate) s += 'f';
  if (k.generalNumeric) s += 'g';
  if (k.human) s += 'h';
  if (k.ignore === 'nonprinting') s += 'i';
  if (k.month) s += 'M';
  if (k.numeric) s += 'n';
  if (k.random) s += 'R';
  if (k.version) s += 'V';
  return s;
}

const SORT_CHOICES = [
  ['general-numeric', 'g'],
  ['human-numeric', 'h'],
  ['month', 'M'],
  ['numeric', 'n'],
  ['random', 'R'],
  ['version', 'V'],
] as const;

const CHECK_CHOICES = [
  ['quiet', 'C'],
  ['silent', 'C'],
  ['diagnose-first', 'c'],
] as const;

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS }, SORT_FAILURE);
  if (typeof args === 'number') return args;
  const die = function* (message: string) {
    yield* warn(p, message);
    return SORT_FAILURE;
  };
  const gkey = newKey();
  const keys: Key[] = [];
  let tab: string | undefined;
  let check: 'c' | 'C' | undefined;
  let output: string | undefined;
  let merge = false;
  let unique = false;
  let stable = false;
  for (const o of args.options) {
    const v = o.value ?? '';
    switch (o.id) {
      case 'b':
        gkey.skipsblanks = gkey.skipeblanks = true;
        break;
      case 'd':
      case 'f':
      case 'g':
      case 'i':
      case 'M':
      case 'h':
      case 'n':
      case 'r':
      case 'V':
        setOrdering(o.id, 0, gkey, 'both');
        break;
      case 'sort': {
        const r = yield* chooseArg(p, '--sort', v, SORT_CHOICES);
        if (typeof r === 'number') return r;
        if (r.value === 'R') return yield* p.unsupported({ kind: 'flag', what: 'the flag --sort=random' });
        setOrdering(r.value, 0, gkey, 'both');
        break;
      }
      case 'c':
      case 'C':
        check = o.id;
        break;
      case 'check': {
        if (o.value === undefined) check = 'c';
        else {
          const r = yield* chooseArg(p, '--check', v, CHECK_CHOICES);
          if (typeof r === 'number') return r;
          check = r.value;
        }
        break;
      }
      case 'key': {
        const k = parseKey(v);
        if (!k.ok) return yield* die(k.message);
        keys.push(k.key);
        break;
      }
      case 'merge':
        merge = true;
        break;
      case 'output':
        if (output !== undefined && output !== v) return yield* die('multiple output files specified');
        output = v;
        break;
      case 'stable':
        stable = true;
        break;
      case 'field-separator': {
        let t = v;
        if (t === '') return yield* die('empty tab');
        if ([...t].length > 1) {
          if (t === '\\0') t = '\0';
          // quote() in the locale style escapes a backslash.
          else return yield* die(`multi-character tab ${quote(t.replace(/\\/g, '\\\\'))}`);
        }
        if (tab !== undefined && tab !== t) return yield* die('incompatible tabs');
        tab = t;
        break;
      }
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
  const files = args.operands.length > 0 ? args.operands : ['-'];
  // The obsolete "+POS1 [-POS2]" key form is still accepted by sort; not simulated.
  const plus = args.operands.find((f) => /^\+[0-9]/.test(f));
  if (plus !== undefined) return yield* p.unsupported({ kind: 'syntax', what: `the obsolete key form ${plus}` });

  // upstream: sort.c main, inheritance of global options by keys without options of their own.
  for (const k of keys) {
    if (isDefaultKey(k) && !k.reverse) {
      const { sword, schar, eword, echar } = k;
      Object.assign(k, { ...gkey, sword, schar, eword, echar });
    }
  }
  if (keys.length === 0 && !isDefaultKey(gkey)) keys.push(gkey);
  for (const k of keys) {
    if (k.random) return yield* p.unsupported({ kind: 'flag', what: 'random sorting (R)' });
    const kinds = Number(k.numeric) + Number(k.generalNumeric) + Number(k.human) + Number(k.month) + Number(k.version || k.random || k.ignore !== undefined);
    if (kinds > 1) return yield* die(`options '-${keyOpts(k)}' are incompatible`);
  }
  const order: Order = { keys, tab, reverse: gkey.reverse, unique, stable };

  if (check !== undefined) {
    if (files.length > 1) return yield* die(`extra operand ${quoteaf(files[1] as string)} not allowed with -${check}`);
    if (output !== undefined) return yield* die(`options '-${check}o' are incompatible`);
  }

  // upstream: sort.c main, every input must be readable before anything is read.
  for (const f of files) {
    if (f === '-') continue;
    try {
      p.fs().access(f, ACCESS.R_OK);
    } catch (e) {
      if (!isFsError(e)) throw e;
      return yield* die(`cannot read: ${quotef(f)}: ${strerror(e.code)}`);
    }
  }
  const inputs: string[][] = [];
  for (const f of files) {
    const opened = openInput(p, f, 3);
    if (!opened.ok) return yield* die(`open failed: ${quotef(f)}: ${strerror(opened.error.code)}`);
    try {
      inputs.push(splitLines(yield* readRest(p, opened.fd)).map((l) => (l.endsWith('\n') ? l.slice(0, -1) : l)));
    } catch (e) {
      if (!isFsError(e)) throw e;
      return yield* die(`read failed: ${quotef(f === '-' ? 'standard input' : f)}: ${strerror(e.code)}`);
    } finally {
      if (opened.fd !== 0) p.close(opened.fd);
    }
  }

  if (check !== undefined) {
    // upstream: sort.c check — the first line out of order; with -u, equal lines are too.
    const lines = inputs[0] as string[];
    for (let i = 1; i < lines.length; i++) {
      const d = compareLines(lines[i - 1] as string, lines[i] as string, order);
      if (d > 0 || (unique && d === 0)) {
        if (check === 'c') yield* p.write(2, `${p.name}: ${files[0]}:${i + 1}: disorder: ${lines[i]}\n`);
        return 1;
      }
    }
    return 0;
  }

  let sorted: string[];
  if (merge) sorted = mergeInputs(inputs, order);
  else sorted = inputs.flat().sort((a, b) => compareLines(a, b, order));
  if (unique) {
    // The first line of each run of equal lines.
    const out: string[] = [];
    for (const l of sorted) if (out.length === 0 || compareLines(out[out.length - 1] as string, l, order) !== 0) out.push(l);
    sorted = out;
  }
  const text = sorted.map((l) => `${l}\n`).join('');
  if (output === undefined) {
    yield* p.write(1, text);
    return 0;
  }
  let fd: number;
  try {
    fd = p.open(output, { write: true, create: true, truncate: true });
  } catch (e) {
    if (!isFsError(e)) throw e;
    return yield* die(`open failed: ${quotef(output)}: ${strerror(e.code)}`);
  }
  try {
    yield* p.write(fd, text);
  } finally {
    p.close(fd);
  }
  return 0;
}

/** -m: inputs taken as sorted; the smallest head line first, the earlier input on ties. upstream: sort.c mergefps */
function mergeInputs(inputs: string[][], order: Order): string[] {
  const pos = inputs.map(() => 0);
  const out: string[] = [];
  for (;;) {
    let best = -1;
    for (let k = 0; k < inputs.length; k++) {
      const lines = inputs[k] as string[];
      if ((pos[k] as number) >= lines.length) continue;
      if (best < 0 || compareLines(lines[pos[k] as number] as string, (inputs[best] as string[])[pos[best] as number] as string, order) < 0) best = k;
    }
    if (best < 0) return out;
    out.push((inputs[best] as string[])[pos[best] as number] as string);
    pos[best] = (pos[best] as number) + 1;
  }
}

export const sortProgram: ProgramSpec = { name: 'sort', main };
