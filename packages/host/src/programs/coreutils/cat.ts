// cat — concatenate files and print on the standard output. GNU coreutils 9.4.
//   docs: cat --help and cat(1) of coreutils 9.4
//   reference: coreutils 9.4 cat, captured 2026-11-16 (packages/host/transcripts/coreutils/cat.t)
// Streams standard input line by line, so `tail -f`-like producers flow through it.

import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { isFsError, strerror } from '../../vfs/errno.ts';
import { openInput, parseArgs, warn } from '../lib/io.ts';
import { quotef } from '../lib/quote.ts';
import { utf8Bytes } from '../../text/utf8.ts';
import type { OptionSpec } from '../lib/getopt.ts';

/** `cat --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: cat [OPTION]... [FILE]...\nConcatenate FILE(s) to standard output.\n\nWith no FILE, or when FILE is -, read standard input.\n\n  -A, --show-all           equivalent to -vET\n  -b, --number-nonblank    number nonempty output lines, overrides -n\n  -e                       equivalent to -vE\n  -E, --show-ends          display $ at end of each line\n  -n, --number             number all output lines\n  -s, --squeeze-blank      suppress repeated empty output lines\n  -t                       equivalent to -vT\n  -T, --show-tabs          display TAB characters as ^I\n  -u                       (ignored)\n  -v, --show-nonprinting   use ^ and M- notation, except for LFD and TAB\n      --help        display this help and exit\n      --version     output version information and exit\n\nExamples:\n  cat f - g  Output f's contents, then standard input, then g's contents.\n  cat        Copy standard input to standard output.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/cat>\nor available locally via: info '(coreutils) cat invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'A', long: 'show-all' },
  { short: 'b', long: 'number-nonblank' },
  { short: 'e', id: 'e' },
  { short: 'E', long: 'show-ends' },
  { short: 'n', long: 'number' },
  { short: 's', long: 'squeeze-blank' },
  { short: 't', id: 't' },
  { short: 'T', long: 'show-tabs' },
  { short: 'u', id: 'u' },
  { short: 'v', long: 'show-nonprinting' },
  { long: 'help' },
  { long: 'version' },
];

/** -v: ^X for control bytes, M- for bytes with the high bit, except newline and tab. upstream: coreutils src/cat.c */
function showNonprinting(s: string, tabs: boolean): string {
  let out = '';
  for (const ch of s) {
    if (ch === '\n') {
      out += ch;
      continue;
    }
    if (ch === '\t') {
      out += tabs ? '^I' : '\t';
      continue;
    }
    for (const b of utf8Bytes(ch)) {
      let c = b;
      if (c >= 128) {
        out += 'M-';
        c -= 128;
      }
      if (c < 32) out += `^${String.fromCharCode(c + 64)}`;
      else if (c === 127) out += '^?';
      else out += String.fromCharCode(c);
    }
  }
  return out;
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP);
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  let numberAll = false;
  let numberNonblank = false;
  let ends = false;
  let tabs = false;
  let nonprinting = false;
  let squeeze = false;
  for (const o of args.options) {
    switch (o.id) {
      case 'show-all':
        nonprinting = ends = tabs = true;
        break;
      case 'number-nonblank':
        numberNonblank = true;
        break;
      case 'e':
        nonprinting = ends = true;
        break;
      case 'show-ends':
        ends = true;
        break;
      case 'number':
        numberAll = true;
        break;
      case 'squeeze-blank':
        squeeze = true;
        break;
      case 't':
        nonprinting = tabs = true;
        break;
      case 'show-tabs':
        tabs = true;
        break;
      case 'show-nonprinting':
        nonprinting = true;
        break;
    }
  }
  const plain = !numberAll && !numberNonblank && !ends && !tabs && !nonprinting && !squeeze;
  let lineNo = 0;
  let prevBlank = false;
  // A line number is printed at the start of each output line, which may span reads.
  let atLineStart = true;

  const render = function* (chunk: string): Op<void> {
    if (plain) {
      yield* p.write(1, chunk);
      return;
    }
    let out = '';
    for (const line of chunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const complete = line.endsWith('\n');
      const body = complete ? line.slice(0, -1) : line;
      const blank = atLineStart && body === '' && complete;
      if (squeeze && blank && prevBlank) continue;
      if (atLineStart) {
        prevBlank = blank;
        // upstream: coreutils src/cat.c, the line number is printed as "%6d\t".
        if (numberAll && !(numberNonblank && blank)) out += `${String(++lineNo).padStart(6)}\t`;
        else if (numberNonblank && !blank) out += `${String(++lineNo).padStart(6)}\t`;
      }
      let text = nonprinting ? showNonprinting(body, tabs) : tabs ? body.replace(/\t/g, '^I') : body;
      if (complete) text += ends ? '$\n' : '\n';
      out += text;
      atLineStart = complete;
    }
    yield* p.write(1, out);
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
        const chunk = yield* p.read(opened.fd, plain ? {} : { line: true });
        if (chunk === null) break;
        yield* render(chunk);
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

export const catProgram: ProgramSpec = { name: 'cat', main };
