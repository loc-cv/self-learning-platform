// gnulib argmatch: an option argument that names one of a list of words, abbreviations allowed
// when they are unambiguous, and the "invalid argument" message with the list of valid words
// (synonyms, consecutive words with the same value, share a line).
//   upstream: gnulib lib/argmatch.c argmatch, argmatch_invalid, argmatch_valid, __xargmatch_internal
//   reference: coreutils 9.4 `ls --color=sometimes`, `ls --format=v` (ambiguous), `wc --total=x`,
//              captured 2026-11-16 (packages/host/transcripts/coreutils/ls-errors.t, wc.t)

import type { Op, ProcApi } from '../../proc/program.ts';
import { quote } from './quote.ts';

/** A word and the value it stands for. */
export interface ArgChoice<V> {
  name: string;
  value: V;
}

/** The choice `arg` selects: exact match, else a unique abbreviation; -1 invalid, -2 ambiguous. */
export function argmatch<V>(arg: string, choices: readonly ArgChoice<V>[]): ArgChoice<V> | -1 | -2 {
  const exact = choices.find((c) => c.name === arg);
  if (exact) return exact;
  const cands = choices.filter((c) => c.name.startsWith(arg));
  if (cands.length === 0) return -1;
  const first = cands[0] as ArgChoice<V>;
  return cands.every((c) => c.value === first.value) ? first : -2;
}

/** argmatch_invalid and argmatch_valid: the message lines, without the program name and "Try" line. */
export function argmatchError<V>(arg: string, context: string, problem: -1 | -2, choices: readonly ArgChoice<V>[]): string {
  let s = `${problem === -1 ? 'invalid' : 'ambiguous'} argument ${quote(arg)} for ${quote(context)}\nValid arguments are:`;
  choices.forEach((c, i) => {
    if (i === 0 || c.value !== (choices[i - 1] as ArgChoice<V>).value) s += `\n  - ${quote(c.name)}`;
    else s += `, ${quote(c.name)}`;
  });
  return s;
}

/**
 * XARGMATCH: the choice, or, for a bad argument, the message and the "Try" line printed and the
 * status returned (usage(EXIT_FAILURE) unless the program says otherwise).
 */
export function* xargmatch<V>(p: ProcApi, context: string, arg: string, choices: readonly ArgChoice<V>[], status = 1): Op<ArgChoice<V> | number> {
  const r = argmatch(arg, choices);
  if (typeof r !== 'number') return r;
  yield* p.write(2, `${p.name}: ${argmatchError(arg, context, r, choices)}\nTry '${p.name} --help' for more information.\n`);
  return status;
}
