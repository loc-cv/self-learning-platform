// head — output the first part of files. GNU coreutils 9.4.
//   docs: head --help and head(1) of coreutils 9.4
//   upstream: coreutils src/head.c (main's obsolete-option parse, string_to_integer, head_lines,
//             elide_tail_lines_pipe, write_header)
//   reference: coreutils 9.4 head, captured 2026-11-16 (packages/host/transcripts/coreutils/head.t)
// Streams its input: `head -n 1` reads one line and exits, so the writer upstream gets SIGPIPE.

import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { utf8Length } from '../../utf8.ts';
import { isFsError, strerror } from '../../vfs/errno.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { openInput, usageError, warn } from '../lib/io.ts';
import { splitOctets } from '../lib/octets.ts';
import { quote, quoteaf } from '../lib/quote.ts';
import { parseArgv, readSome, splitLines } from '../lib/textio.ts';
import { EOVERFLOW_TEXT, toCount, xstrtoumax } from '../lib/xstrtol.ts';

/** `head --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: head [OPTION]... [FILE]...\nPrint the first 10 lines of each FILE to standard output.\nWith more than one FILE, precede each with a header giving the file name.\n\nWith no FILE, or when FILE is -, read standard input.\n\nMandatory arguments to long options are mandatory for short options too.\n  -c, --bytes=[-]NUM       print the first NUM bytes of each file;\n                             with the leading '-', print all but the last\n                             NUM bytes of each file\n  -n, --lines=[-]NUM       print the first NUM lines instead of the first 10;\n                             with the leading '-', print all but the last\n                             NUM lines of each file\n  -q, --quiet, --silent    never print headers giving file names\n  -v, --verbose            always print headers giving file names\n  -z, --zero-terminated    line delimiter is NUL, not newline\n      --help        display this help and exit\n      --version     output version information and exit\n\nNUM may have a multiplier suffix:\nb 512, kB 1000, K 1024, MB 1000*1000, M 1024*1024,\nGB 1000*1000*1000, G 1024*1024*1024, and so on for T, P, E, Z, Y, R, Q.\nBinary prefixes can be used, too: KiB=K, MiB=M, and so on.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/head>\nor available locally via: info '(coreutils) head invocation'\n";

const DIGITS = '0123456789';

const OPTIONS: OptionSpec[] = [
  { short: 'c', long: 'bytes', arg: 'required' },
  { short: 'n', long: 'lines', arg: 'required' },
  { short: 'q', long: 'quiet', id: 'quiet' },
  { long: 'silent', id: 'quiet' },
  { short: 'v', long: 'verbose' },
  { short: 'z', long: 'zero-terminated', supported: false },
  { long: 'help' },
  { long: 'version' },
  // upstream: head.c, digits are in the getopt string only to diagnose `-5` after the first argument.
  ...[...DIGITS].map((d): OptionSpec => ({ short: d, id: `digit` })),
];

/** The multiplier suffixes head accepts. upstream: head.c string_to_integer */
export const HEAD_SUFFIXES = 'bkKmMGTPEZYRQ0';

type Count = { ok: true; n: number } | { ok: false; message: string };

/** upstream: head.c string_to_integer (xdectoumax with "invalid number of lines/bytes"). */
function parseCount(s: string, lines: boolean): Count {
  const what = lines ? 'invalid number of lines' : 'invalid number of bytes';
  const r = xstrtoumax(s, HEAD_SUFFIXES);
  if (r.kind === 'ok') return { ok: true, n: toCount(r.value) };
  return { ok: false, message: r.kind === 'overflow' ? `${what}: ${quote(s)}: ${EOVERFLOW_TEXT}` : `${what}: ${quote(s)}` };
}

interface Settings {
  lines: boolean;
  n: number;
  elide: boolean;
  headers: 'auto' | 'always' | 'never';
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const argv = p.argv.slice(1);
  const st: Settings = { lines: true, n: 10, elide: false, headers: 'auto' };
  // upstream: head.c main, "-NUM[bcklmqvz]" as the first argument is the obsolete form.
  const first = argv[0];
  if (first !== undefined && /^-[0-9]/.test(first)) {
    const m = /^-([0-9]+)(.*)$/.exec(first) as RegExpExecArray;
    let digits = m[1] as string;
    let multiplier = '';
    for (const c of m[2] as string) {
      if (c === 'c') {
        st.lines = false;
        multiplier = '';
      } else if (c === 'b' || c === 'k' || c === 'm') {
        st.lines = false;
        multiplier = c;
      } else if (c === 'l') st.lines = true;
      else if (c === 'q') st.headers = 'never';
      else if (c === 'v') st.headers = 'always';
      else if (c === 'z') return yield* p.unsupported({ kind: 'flag', what: 'the flag -z' });
      else return yield* usageError(p, `invalid trailing option -- ${c}`);
    }
    digits += multiplier;
    const n = parseCount(digits, st.lines);
    if (!n.ok) {
      yield* warn(p, n.message);
      return 1;
    }
    st.n = n.n;
    argv.shift();
  }
  const args = yield* parseArgv(p, argv, { options: OPTIONS });
  if (typeof args === 'number') return args;
  for (const o of args.options) {
    switch (o.id) {
      case 'bytes':
      case 'lines': {
        let v = o.value as string;
        st.lines = o.id === 'lines';
        st.elide = false;
        if (v.startsWith('-')) {
          st.elide = true;
          v = v.slice(1);
        }
        const n = parseCount(v, st.lines);
        if (!n.ok) {
          yield* warn(p, n.message);
          return 1;
        }
        st.n = n.n;
        break;
      }
      case 'quiet':
        st.headers = 'never';
        break;
      case 'verbose':
        st.headers = 'always';
        break;
      case 'digit':
        return yield* usageError(p, `invalid trailing option -- ${o.name.slice(1)}`);
      case 'help':
        yield* p.write(1, HELP);
        return 0;
      case 'version':
        return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
    }
  }

  const files = args.operands.length > 0 ? args.operands : ['-'];
  const headers = st.headers === 'always' || (st.headers === 'auto' && files.length > 1);
  let firstHeader = true;
  let status = 0;
  for (const name of files) {
    const opened = openInput(p, name, 3);
    if (!opened.ok) {
      yield* warn(p, `cannot open ${quoteaf(name)} for reading: ${strerror(opened.error.code)}`);
      status = 1;
      continue;
    }
    const shown = name === '-' ? 'standard input' : name;
    if (headers) {
      // upstream: head.c write_header, a blank line before every header but the first.
      yield* p.write(1, `${firstHeader ? '' : '\n'}==> ${shown} <==\n`);
      firstHeader = false;
    }
    try {
      yield* head(p, opened.fd, st);
    } catch (e) {
      if (!isFsError(e)) throw e;
      yield* warn(p, `error reading ${quoteaf(shown)}: ${strerror(e.code)}`);
      status = 1;
    } finally {
      if (opened.fd !== 0) p.close(opened.fd);
    }
  }
  return status;
}

function* head(p: ProcApi, fd: number, st: Settings): Op<void> {
  if (st.lines && !st.elide) {
    for (let left = st.n; left > 0; left--) {
      const line = yield* readSome(p, fd, { line: true });
      if (line === null) return;
      yield* p.write(1, line);
    }
    return;
  }
  if (!st.lines && !st.elide) {
    let left = st.n;
    while (left > 0) {
      const chunk = yield* readSome(p, fd);
      if (chunk === null) return;
      const size = utf8Length(chunk);
      if (size <= left) {
        yield* p.write(1, chunk);
        left -= size;
      } else {
        yield* p.write(1, splitOctets(chunk, left)[0]);
        return;
      }
    }
    return;
  }
  if (st.lines) {
    // All but the last N lines: a line is written once N newer lines are held back.
    // upstream: head.c elide_tail_lines_pipe
    const held: string[] = [];
    for (;;) {
      const chunk = yield* readSome(p, fd);
      if (chunk === null) return;
      // A line is complete only with its newline; an unfinished one waits for the rest.
      const last = held.length > 0 && !(held[held.length - 1] as string).endsWith('\n') ? (held.pop() as string) : '';
      held.push(...splitLines(last + chunk));
      // The last line counts even without its newline; only it can be unfinished, so with N ≥ 1
      // every line written here is complete. With N = 0 everything passes through.
      let out = '';
      if (st.n === 0) out = held.splice(0).join('');
      else while (held.length > st.n) out += held.shift() as string;
      yield* p.write(1, out);
    }
  }
  // All but the last N bytes.
  let data = '';
  for (;;) {
    const chunk = yield* readSome(p, fd);
    if (chunk === null) break;
    data += chunk;
  }
  const size = utf8Length(data);
  if (size > st.n) yield* p.write(1, splitOctets(data, size - st.n)[0]);
}

export const headProgram: ProgramSpec = { name: 'head', main };
