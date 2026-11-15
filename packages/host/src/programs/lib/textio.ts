// Reading helpers shared by the text filters (head, tail, wc, sort, uniq, cut, tr, tee).

import type { Op, ProcApi } from '../../proc/program.ts';
import { UnsupportedError } from '../../vfs/errno.ts';
import { xargmatch } from './argmatch.ts';
import { getopt, type GetoptConfig } from './getopt.ts';
import type { Args } from './io.ts';

/**
 * `parseArgs` over an argument list the program has already edited (head and tail remove an
 * obsolete `-5` first argument before getopt sees the rest).
 */
export function* parseArgv(p: ProcApi, argv: readonly string[], cfg: GetoptConfig, usageStatus = 1): Op<Args | number> {
  const r = getopt(argv, { ...cfg, stopAtOperand: cfg.stopAtOperand || p.env['POSIXLY_CORRECT'] !== undefined });
  if (!r.ok) {
    if ('unsupported' in r) return yield* p.unsupported({ kind: 'flag', what: `the flag ${r.unsupported}` });
    yield* p.write(2, `${p.name}: ${r.error}\nTry '${p.name} --help' for more information.\n`);
    return usageStatus;
  }
  return {
    options: r.options,
    operands: r.operands,
    has: (id) => r.options.some((o) => o.id === id),
    value: (id) => [...r.options].reverse().find((o) => o.id === id)?.value,
    values: (id) => r.options.filter((o) => o.id === id).map((o) => o.value ?? ''),
  };
}

/**
 * read(2) on `fd`. A read the simulator cannot represent (the binary content of an executable
 * stub) ends the program with the `[sim]` notice; file system errors are thrown as `FsError`.
 */
export function* readSome(p: ProcApi, fd: number, opts: { line?: boolean; max?: number } = {}): Op<string | null> {
  try {
    return yield* p.read(fd, opts);
  } catch (e) {
    if (e instanceof UnsupportedError) return yield* p.unsupported({ kind: 'behavior', what: `reading ${e.what}` });
    throw e;
  }
}

/** Everything left on `fd`, through `readSome`. */
export function* readRest(p: ProcApi, fd: number): Op<string> {
  let out = '';
  for (;;) {
    const chunk = yield* readSome(p, fd);
    if (chunk === null) return out;
    out += chunk;
  }
}

/** Splits text into lines with their newlines; the last may lack one. */
export function splitLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Words an option argument may name, each with the value it selects; synonyms share a value. */
export type Choices<V extends string> = readonly (readonly [string, V])[];

/** XARGMATCH over `[word, value]` pairs; the shared implementation is lib/argmatch.ts. */
export function* chooseArg<V extends string>(p: ProcApi, context: string, arg: string, choices: Choices<V>): Op<{ value: V } | number> {
  const r = yield* xargmatch(p, context, arg, choices.map(([name, value]) => ({ name, value })));
  return typeof r === 'number' ? r : { value: r.value };
}
