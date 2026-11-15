// Searching one input: reading it as it arrives, selecting lines, context, and printing them the
// way grep does.
//   upstream: grep 3.11 src/grep.c grep (binary detection, NUL bytes as line ends), grepbuf,
//             prtext (context and the group separator), prpending, prline, print_line_head,
//             print_line_middle, print_line_tail, print_offset
//   reference: grep 3.11, captured 2026-11-16 (packages/host/transcripts/grep/*.t)

import type { Op, ProcApi } from '../../proc/program.ts';
import { isFsError, strerror } from '../../vfs/errno.ts';
import { utf8Length } from '../../text/utf8.ts';
import { sgrEnd, sgrStart, type Colors } from './colors.ts';
import type { Matcher } from './matcher.ts';

export interface SearchConfig {
  matcher: Matcher;
  invert: boolean;
  onlyMatching: boolean;
  countMatches: boolean;
  listFiles: 'none' | 'matching' | 'nonmatching';
  /** -q (or output to /dev/null): exit at the first selected line. */
  exitOnMatch: boolean;
  doneOnMatch: boolean;
  outQuiet: boolean;
  /** -1 when not given. */
  before: number;
  after: number;
  maxCount: number;
  lineNumbers: boolean;
  byteOffset: boolean;
  /** -Z: a NUL instead of the separator after a file name. */
  nullAfterName: boolean;
  eol: string;
  colors: Colors | undefined;
  groupSeparator: string | undefined;
  binaryFiles: 'binary' | 'text' | 'without-match';
  suppressErrors: boolean;
}

/** Buffered standard output, like stdio: a terminal (or --line-buffered) gets each line at once. */
export interface Output {
  write(s: string): void;
  /** Flushes when the buffer is full, or always when line buffered. */
  sync(): Op<void>;
  flush(): Op<void>;
  /** `grep: message` on standard error, after flushing standard output as error(3) does. */
  error(message: string): Op<void>;
}

/** stdio's buffer for a pipe or file: st_blksize, 4096 on Linux. */
const BUFSIZ = 4096;

export function createOutput(p: ProcApi, lineBuffered: boolean): Output {
  let buf = '';
  const flush = function* (): Op<void> {
    if (buf === '') return;
    const s = buf;
    buf = '';
    yield* p.write(1, s);
  };
  return {
    write(s) {
      buf += s;
    },
    *sync() {
      if (lineBuffered) {
        yield* flush();
        return;
      }
      // A full buffer is written out in whole blocks; the rest stays buffered.
      const blocks = Math.floor(utf8Length(buf) / BUFSIZ);
      if (blocks === 0) return;
      let bytes = 0;
      let cut = 0;
      for (const ch of buf) {
        const n = utf8Length(ch);
        if (bytes + n > blocks * BUFSIZ) break;
        bytes += n;
        cut += ch.length;
      }
      const s = buf.slice(0, cut);
      buf = buf.slice(cut);
      yield* p.write(1, s);
    },
    flush,
    *error(message) {
      yield* flush();
      yield* p.write(2, `${p.name}: ${message}\n`);
    },
  };
}

/** State shared by every input of one grep run. */
export interface RunState {
  /** Something was output (or would have been): the group separator is due before the next group. */
  used: boolean;
  errseen: boolean;
}

/** The descriptor of an input and the name grep uses for it in output and messages. */
export interface Input {
  fd: number;
  name: string;
  /** Whether the file name prefixes output lines. */
  withName: boolean;
}

/** Reads and searches one input; returns the number of selected lines. Ends the process on -q. */
export function* searchInput(p: ProcApi, cfg: SearchConfig, run: RunState, out: Output, input: Input): Op<number> {
  const { matcher, invert, eol } = cfg;
  const colors = cfg.colors;
  const sgr = (cap: string, text: string): string => (colors ? sgrStart(colors, cap) + text + sgrEnd(colors, cap) : text);
  const sep = (c: string): string => (colors ? sgr(colors.se, c) : c);

  let outQuiet = cfg.outQuiet;
  let doneOnMatch = cfg.doneOnMatch;
  let nulZapper = false;
  let nlinesFirstNull = -1;
  let nlines = 0;
  let outleft = cfg.maxCount;
  let pending = 0;
  /** Number of the last line output, or -1 when nothing of this input was output yet. */
  let lastout = -1;
  const beforeLines: { text: string; no: number; off: number }[] = [];
  let lineNo = 0;
  let offset = 0;
  let stop = false;

  const head = (no: number, off: number, s: ':' | '-'): string => {
    let h = '';
    if (input.withName) h += sgr(colors?.fn ?? '', input.name) + (cfg.nullAfterName ? '\0' : sep(s));
    if (cfg.lineNumbers) h += sgr(colors?.ln ?? '', String(no)) + sep(s);
    if (cfg.byteOffset) h += sgr(colors?.bn ?? '', String(off)) + sep(s);
    return h;
  };

  /** upstream: grep.c prline */
  const prline = (text: string, no: number, off: number, s: ':' | '-'): void => {
    const onlyMatching = cfg.onlyMatching;
    const matching = (s === ':') !== invert;
    const lineColor = colors ? ((s === ':') !== (invert && colors.rv) ? colors.sl : colors.cx) : '';
    const matchColor = colors ? (s === ':' ? colors.ms : colors.mc) : '';
    let o = onlyMatching ? '' : head(no, off, s);
    let beg = 0;
    if ((onlyMatching && matching) || (colors && (lineColor !== '' || matchColor !== ''))) {
      if (matching && (onlyMatching || matchColor !== '')) {
        // upstream: grep.c print_line_middle
        let cur = 0;
        let mid = -1;
        while (cur <= text.length) {
          const m = matcher.next(text, cur);
          if (!m || m.start >= text.length) break;
          const b = m.start;
          if (m.end === b) {
            // An empty match: move on by one character; the text before it is printed later.
            if (mid < 0) mid = cur;
            cur = b + ((text.codePointAt(b) as number) > 0xffff ? 2 : 1);
            continue;
          }
          if (onlyMatching) o += head(no, off + utf8Length(text.slice(0, b)), invert ? '-' : ':');
          else {
            if (colors) o += sgrStart(colors, lineColor);
            if (mid >= 0) {
              cur = mid;
              mid = -1;
            }
            o += text.slice(cur, b);
          }
          o += colors ? sgr(matchColor, text.slice(b, m.end)) : text.slice(b, m.end);
          if (onlyMatching) o += eol;
          cur = m.end;
        }
        beg = onlyMatching ? text.length : mid >= 0 ? mid : Math.min(cur, text.length);
      }
      if (!onlyMatching && colors && lineColor !== '') {
        // upstream: grep.c print_line_tail — a CR before the end of line stays uncolored.
        const tailEnd = text.endsWith('\r') ? text.length - 1 : text.length;
        if (tailEnd > beg) {
          o += sgr(lineColor, text.slice(beg, tailEnd));
          beg = tailEnd;
        }
      }
    }
    if (!onlyMatching) o += text.slice(beg) + eol;
    out.write(o);
    lastout = no;
  };

  /** upstream: grep.c prtext, for one selected line. */
  const prtext = (text: string, no: number, off: number): void => {
    if (!outQuiet) {
      const ctx = cfg.before > 0 ? beforeLines.slice(-cfg.before) : [];
      const firstNo = ctx.length > 0 ? (ctx[0] as { no: number }).no : no;
      if ((cfg.before >= 0 || cfg.after >= 0) && run.used && !(lastout >= 0 && firstNo === lastout + 1) && cfg.groupSeparator !== undefined) {
        out.write(sep(cfg.groupSeparator) + '\n');
      }
      for (const l of ctx) prline(l.text, l.no, l.off, '-');
      prline(text, no, off, ':');
    }
    beforeLines.length = 0;
    pending = outQuiet ? 0 : Math.max(0, cfg.after);
    run.used = true;
    outleft--;
  };

  const handleLine = function* (text: string): Op<void> {
    const no = ++lineNo;
    const off = offset;
    offset += utf8Length(text) + 1;
    if (outleft > 0 && cfg.matcher.test(text) !== invert) {
      nlines++;
      prtext(text, no, off);
      if (outleft <= 0 || doneOnMatch) {
        if (cfg.exitOnMatch) {
          yield* out.flush();
          p.exit(0);
        }
        outleft = 0;
      }
    } else if (pending > 0) {
      prline(text, no, off, '-');
      pending--;
      beforeLines.length = 0;
    } else if (cfg.before > 0 && !outQuiet) {
      beforeLines.push({ text, no, off });
      if (beforeLines.length > cfg.before) beforeLines.shift();
    }
    if (outleft <= 0 && pending <= 0) stop = true;
  };

  let buf = '';
  try {
    while (!stop) {
      const chunk = yield* p.read(input.fd, { max: 32768 });
      if (chunk === null) break;
      let data = chunk;
      // upstream: grep.c grep — a NUL byte makes the input binary (unless -a); from then on NUL
      // bytes end lines and the first selected line ends the search.
      if (cfg.binaryFiles !== 'text' && !nulZapper && eol === '\n' && data.includes('\0')) {
        if (cfg.binaryFiles === 'without-match') return 0;
        if (!cfg.countMatches) doneOnMatch = outQuiet = true;
        nlinesFirstNull = nlines;
        nulZapper = true;
      }
      if (nulZapper) data = data.replace(/\0/g, eol);
      buf += data;
      let start = 0;
      for (;;) {
        const k = buf.indexOf(eol, start);
        if (k < 0 || stop) break;
        yield* handleLine(buf.slice(start, k));
        start = k + 1;
      }
      buf = buf.slice(start);
      yield* out.sync();
    }
    // A last line without a line end is searched (and printed) as if it had one.
    if (!stop && buf !== '') yield* handleLine(buf);
  } catch (e) {
    if (!isFsError(e)) throw e;
    if (!cfg.suppressErrors) yield* out.error(`${input.name}: ${strerror(e.code)}`);
    run.errseen = true;
    return nlines;
  }
  if (!cfg.outQuiet && nlinesFirstNull >= 0 && nlinesFirstNull < nlines) yield* out.error(`${input.name}: binary file matches`);
  return nlines;
}
