// Helpers every program uses: argument parsing with GNU usage errors, messages in the
// `program: message` form, and reading input files or standard input.

import type { Op, ProcApi } from '../../proc/program.ts';
import { isFsError, strerror, UnsupportedError, type FsError } from '../../vfs/errno.ts';
import { getopt, type GetoptConfig, type ParsedOption } from './getopt.ts';

export interface Args {
  options: ParsedOption[];
  operands: string[];
  has(id: string): boolean;
  /** The last value given for `id`. */
  value(id: string): string | undefined;
  values(id: string): string[];
}

/**
 * Parses argv[1..]. A usage error prints glibc's message and coreutils' "Try '… --help'" line and
 * returns `usageStatus`; an unsupported option ends the program with the `[sim]` notice.
 */
export function* parseArgs(p: ProcApi, cfg: GetoptConfig, usageStatus = 1): Op<Args | number> {
  const env = p.env;
  const r = getopt(p.argv.slice(1), { ...cfg, stopAtOperand: cfg.stopAtOperand || env['POSIXLY_CORRECT'] !== undefined });
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

/** Writes `program: message` and a newline to standard error. */
export function* warn(p: ProcApi, message: string): Op<void> {
  yield* p.write(2, `${p.name}: ${message}\n`);
}

/** Prints a usage error with the "Try" line. */
export function* usageError(p: ProcApi, message: string, status = 1): Op<number> {
  yield* p.write(2, `${p.name}: ${message}\nTry '${p.name} --help' for more information.\n`);
  return status;
}

/** Everything readable from descriptor `fd` until end of file. */
export function* readAll(p: ProcApi, fd: number): Op<string> {
  let out = '';
  for (;;) {
    const chunk = yield* p.read(fd);
    if (chunk === null) return out;
    out += chunk;
  }
}

/** The next line from `fd`, with its newline (the last line may lack one), or null at end of file. */
export function* readLine(p: ProcApi, fd: number): Op<string | null> {
  return yield* p.read(fd, { line: true });
}

export type FileContent = { ok: true; data: string } | { ok: false; error: FsError };

/** Reads a file as the process; an unsupported file (an executable stub) ends the program with a notice. */
export function* readFile(p: ProcApi, path: string): Op<FileContent> {
  try {
    return { ok: true, data: p.fs().readFile(path) };
  } catch (e) {
    if (isFsError(e)) return { ok: false, error: e };
    if (e instanceof UnsupportedError) return yield* p.unsupported({ kind: 'behavior', what: `reading ${e.what}` });
    throw e;
  }
}

/** `program: name: strerror` for an operand that could not be read. */
export function errorText(e: FsError): string {
  return strerror(e.code);
}

/**
 * Opens operand `path` for reading as descriptor `fd` (`-` is standard input, which is left as
 * it is). Returns an error instead of throwing.
 */
export function openInput(p: ProcApi, path: string, fd: number): { ok: true; fd: number } | { ok: false; error: FsError } {
  if (path === '-') return { ok: true, fd: 0 };
  try {
    p.openAt(fd, path, { read: true });
    return { ok: true, fd };
  } catch (e) {
    if (isFsError(e)) return { ok: false, error: e };
    throw e;
  }
}
