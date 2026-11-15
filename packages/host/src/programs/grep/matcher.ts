// Compiles grep's patterns into one JavaScript regular expression and finds matches the POSIX way.
//   upstream: grep 3.11 src/dfasearch.c GEAcompile (patterns checked one by one, then parsed
//             together), EGexecute (-w and -x), src/kwsearch.c (-F)
//
// Line selection only asks whether a match exists, where JavaScript's leftmost-first search and
// POSIX's leftmost-longest one agree. Where the matched text itself is shown (-o, --color), the
// longest match at the leftmost position is searched for explicitly when the pattern can match
// more than one length there (alternation, a repeated group, a back-reference, several patterns).

import { WORD } from './classes.ts';
import { fixedSource, translate, type DfaEvent, type Syntax } from './regex.ts';

export interface PatternLine {
  text: string;
  /** For patterns read with -f: the file and line, which prefix glibc's error messages. */
  origin?: { file: string; line: number };
}

export interface MatcherOptions {
  syntax: Syntax | 'fixed';
  icase: boolean;
  word: boolean;
  line: boolean;
}

export interface Match {
  start: number;
  end: number;
}

export interface Matcher {
  test(line: string): boolean;
  /** The leftmost-longest match that starts at or after `from` (UTF-16 offsets). */
  next(line: string, from: number): Match | undefined;
}

/** Diagnostics in the order grep prints them; without a matcher, grep exits with status 2. */
export interface CompileResult {
  matcher?: Matcher;
  diagnostics: { message: string; warning: boolean }[];
}

export function compilePatterns(patterns: readonly PatternLine[], opts: MatcherOptions): CompileResult {
  const diagnostics: { message: string; warning: boolean }[] = [];
  const sources: string[] = [];
  const events: DfaEvent[] = [];
  let offset = 0;
  let ambiguous = patterns.length > 1;
  let failed = false;
  for (const p of patterns) {
    if (opts.syntax === 'fixed') {
      sources.push(fixedSource(p.text));
      continue;
    }
    const r = translate(p.text, opts.syntax, offset);
    if (!r.ok) {
      // upstream: dfasearch.c regex_compile, "%s:%td: %s" for a pattern from a file.
      diagnostics.push({ message: p.origin ? `${p.origin.file}:${p.origin.line}: ${r.error}` : r.error, warning: false });
      failed = true;
      continue;
    }
    sources.push(r.value.source);
    events.push(...r.value.events);
    offset += r.value.groups;
    ambiguous ||= r.value.ambiguous;
  }
  if (failed) return { diagnostics };
  // The dfa parses all patterns after glibc accepted them; its first error ends the parse.
  for (const e of events) {
    diagnostics.push({ message: e.kind === 'warning' ? `warning: ${e.message}` : e.message, warning: e.kind === 'warning' });
    if (e.kind === 'error') return { diagnostics };
  }
  const alt = sources.length === 0 ? '(?!)' : sources.map((s) => `(?:${s})`).join('|');
  const source = opts.line ? `^(?:${alt})$` : opts.word ? `(?<!${WORD})(?:${alt})(?!${WORD})` : alt;
  return { matcher: makeMatcher(source, opts.icase ? 'iu' : 'u', ambiguous), diagnostics };
}

function makeMatcher(source: string, flags: string, ambiguous: boolean): Matcher {
  const tester = new RegExp(source, flags);
  const scanner = new RegExp(source, `${flags}g`);
  const anchored = new Map<number, RegExp>();
  /** A match from `start` that leaves exactly `k` code points of the line after it. */
  const endingBefore = (k: number): RegExp => {
    let re = anchored.get(k);
    if (!re) {
      re = new RegExp(`(?:${source})(?=[^]{${k}}$)`, `${flags}y`);
      anchored.set(k, re);
    }
    return re;
  };
  return {
    test: (line) => tester.test(line),
    next(line, from) {
      scanner.lastIndex = from;
      const m = scanner.exec(line);
      if (!m) return undefined;
      const start = m.index;
      let end = start + m[0].length;
      if (ambiguous && end < line.length) {
        // Try every longer end, longest first.
        const rest = [...line.slice(end)];
        let cut = 0;
        for (let k = 0; k < rest.length; k++) {
          const re = endingBefore(k);
          re.lastIndex = start;
          if (re.test(line)) {
            end = line.length - cut;
            break;
          }
          cut += (rest[rest.length - 1 - k] as string).length;
        }
      }
      return { start, end };
    },
  };
}
