// wc — print newline, word, and byte counts for each file. GNU coreutils 9.4.
//   docs: wc --help and wc(1) of coreutils 9.4
//   upstream: coreutils src/wc.c (wc, write_counts, get_input_fstatus, compute_number_width)
//   reference: coreutils 9.4 wc, captured 2026-11-16 (packages/host/transcripts/coreutils/wc.t)
//
// Column width: one count of one file is printed as it is; otherwise every column is as wide as
// the decimal size of all regular input files together, and at least 7 when an input is not a
// regular file (a pipe, a terminal, a directory). Files that cannot be stat'ed do not count.

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { getMachine } from '../../machine.ts';
import { utf8Length } from '../../utf8.ts';
import { isFsError, strerror } from '../../vfs/errno.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { openInput, parseArgs, warn } from '../lib/io.ts';
import { quotef } from '../lib/quote.ts';
import { chooseArg, readSome } from '../lib/textio.ts';
import { isPrint, isWordSpace, wcwidth } from '../lib/wcwidth.ts';

/** `wc --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: wc [OPTION]... [FILE]...\n  or:  wc [OPTION]... --files0-from=F\nPrint newline, word, and byte counts for each FILE, and a total line if\nmore than one FILE is specified.  A word is a non-zero-length sequence of\nprintable characters delimited by white space.\n\nWith no FILE, or when FILE is -, read standard input.\n\nThe options below may be used to select which counts are printed, always in\nthe following order: newline, word, character, byte, maximum line length.\n  -c, --bytes            print the byte counts\n  -m, --chars            print the character counts\n  -l, --lines            print the newline counts\n      --files0-from=F    read input from the files specified by\n                           NUL-terminated names in file F;\n                           If F is - then read names from standard input\n  -L, --max-line-length  print the maximum display width\n  -w, --words            print the word counts\n      --total=WHEN       when to print a line with total counts;\n                           WHEN can be: auto, always, only, never\n      --help        display this help and exit\n      --version     output version information and exit\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/wc>\nor available locally via: info '(coreutils) wc invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'c', long: 'bytes' },
  { short: 'm', long: 'chars' },
  { short: 'l', long: 'lines' },
  { long: 'files0-from', arg: 'required', supported: false },
  { short: 'L', long: 'max-line-length' },
  { short: 'w', long: 'words' },
  { long: 'total', arg: 'required' },
  { long: 'help' },
  { long: 'version' },
];

type TotalMode = 'auto' | 'always' | 'only' | 'never';
const TOTAL_CHOICES = (['auto', 'always', 'only', 'never'] as const).map((m) => [m, m] as const);

interface Counts {
  lines: number;
  words: number;
  chars: number;
  bytes: number;
  maxLength: number;
}

/** Counting state carried across reads. upstream: wc.c wc, the multibyte loop */
interface Counter extends Counts {
  inWord: boolean;
  linepos: number;
}

function count(c: Counter, text: string): void {
  c.bytes += utf8Length(text);
  for (const ch of text) {
    c.chars++;
    switch (ch) {
      case '\n':
      case '\r':
      case '\f':
        if (ch === '\n') c.lines++;
        if (c.linepos > c.maxLength) c.maxLength = c.linepos;
        c.linepos = 0;
        c.inWord = false;
        continue;
      case '\t':
        c.linepos += 8 - (c.linepos % 8);
        c.inWord = false;
        continue;
      case ' ':
        c.linepos++;
        c.inWord = false;
        continue;
      case '\v':
        c.inWord = false;
        continue;
    }
    if (isWordSpace(ch)) {
      c.linepos += isPrint(ch) ? wcwidth(ch) : 0;
      c.inWord = false;
      continue;
    }
    // A non-printable character neither starts nor ends a word.
    if (!isPrint(ch)) continue;
    c.linepos += wcwidth(ch);
    if (!c.inWord) c.words++;
    c.inWord = true;
  }
}

/** fstat(2)/stat(2) of an input as wc's width computation needs it; undefined when it fails. */
function inputStat(p: ProcApi, name: string): { regular: boolean; size: number } | undefined {
  if (name !== '-') {
    try {
      const s = p.fs().stat(name);
      return { regular: s.type === 'file', size: s.size };
    } catch (e) {
      if (isFsError(e)) return undefined;
      throw e;
    }
  }
  const fd = p.fd(0);
  if (fd?.kind !== 'file') return { regular: false, size: 0 };
  const m = getMachine(p.ctx, p.machine);
  const ino = m.files[fd.file]?.inode;
  const i = ino === undefined ? undefined : m.vfs.inodes[ino];
  if (i?.type === 'file') return { regular: true, size: utf8Length(i.data) };
  if (i?.type === 'program') return { regular: true, size: i.size };
  return { regular: i?.type === 'generated' && i.device === undefined, size: 0 };
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP);
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  let total: TotalMode = 'auto';
  const totalArg = args.value('total');
  if (totalArg !== undefined) {
    const r = yield* chooseArg(p, '--total', totalArg, TOTAL_CHOICES);
    if (typeof r === 'number') return r;
    total = r.value;
  }
  const show = { lines: args.has('lines'), words: args.has('words'), chars: args.has('chars'), bytes: args.has('bytes'), maxLength: args.has('max-line-length') };
  if (!show.lines && !show.words && !show.chars && !show.bytes && !show.maxLength) show.lines = show.words = show.bytes = true;
  const shown = (['lines', 'words', 'chars', 'bytes', 'maxLength'] as const).filter((k) => show[k]);

  const operands = args.operands;
  const files = operands.length > 0 ? operands : ['-'];
  // upstream: wc.c get_input_fstatus and compute_number_width.
  let width = 1;
  if (total !== 'only' && !(files.length === 1 && shown.length === 1)) {
    let minimum = 1;
    let regularTotal = 0;
    for (const f of files) {
      const s = inputStat(p, f);
      if (!s) continue;
      if (s.regular) regularTotal += s.size;
      else minimum = 7;
    }
    width = Math.max(String(regularTotal).length, minimum);
  }
  const line = (c: Counts, name: string | undefined): string =>
    `${shown.map((k) => String(c[k]).padStart(width)).join(' ')}${name === undefined ? '' : ` ${name.includes('\n') ? quotef(name) : name}`}\n`;

  const sum: Counts = { lines: 0, words: 0, chars: 0, bytes: 0, maxLength: 0 };
  let status = 0;
  for (const name of files) {
    const opened = openInput(p, name, 3);
    if (!opened.ok) {
      yield* warn(p, `${quotef(name)}: ${strerror(opened.error.code)}`);
      status = 1;
      continue;
    }
    const c: Counter = { lines: 0, words: 0, chars: 0, bytes: 0, maxLength: 0, inWord: false, linepos: 0 };
    try {
      for (;;) {
        const chunk = yield* readSome(p, opened.fd);
        if (chunk === null) break;
        count(c, chunk);
      }
    } catch (e) {
      if (!isFsError(e)) throw e;
      yield* warn(p, `${quotef(name)}: ${strerror(e.code)}`);
      status = 1;
    } finally {
      if (opened.fd !== 0) p.close(opened.fd);
    }
    if (c.linepos > c.maxLength) c.maxLength = c.linepos;
    if (total !== 'only') yield* p.write(1, line(c, operands.length > 0 ? name : undefined));
    sum.lines += c.lines;
    sum.words += c.words;
    sum.chars += c.chars;
    sum.bytes += c.bytes;
    sum.maxLength = Math.max(sum.maxLength, c.maxLength);
  }
  if (total === 'always' || (total === 'auto' && files.length > 1)) yield* p.write(1, line(sum, 'total'));
  else if (total === 'only') yield* p.write(1, line(sum, undefined));
  return status;
}

export const wcProgram: ProgramSpec = { name: 'wc', main };
