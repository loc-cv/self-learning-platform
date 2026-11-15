// What running an executable file means: the checks of execve(2), then by content an executable
// stub (a registered program), a script with a `#!` interpreter line, or a text file without one,
// which the kernel refuses with ENOEXEC and a shell then runs as a shell script.
//   docs: execve(2) ("Interpreter scripts", ERRORS); bash(1) COMMAND EXECUTION ("If this execution
//         fails because the file is not in executable format … it is assumed to be a shell script")

import { FsError, isFsError, type Errno } from '../vfs/errno.ts';
import type { Fs } from '../vfs/fs.ts';

export type ExecTarget =
  | { kind: 'program'; program: string; argv: string[] }
  /** A text file without `#!`: ENOEXEC, which the shell turns into running it as a script. */
  | { kind: 'noexec'; path: string; argv: string[] }
  | { kind: 'error'; code: Errno }
  /** The `#!` interpreter cannot be executed: bash reports "bad interpreter". */
  | { kind: 'bad-interpreter'; interpreter: string; code: Errno };

/** Resolves `path` (as given, relative to the process's working directory) for execution with `argv`. */
export function resolveExec(fs: Fs, path: string, argv: readonly string[]): ExecTarget {
  let ino;
  try {
    ino = fs.checkExec(path);
  } catch (e) {
    if (isFsError(e)) return { kind: 'error', code: e.code };
    throw e;
  }
  if (ino.type === 'program') return { kind: 'program', program: ino.program, argv: [...argv] };
  if (ino.type !== 'file') return { kind: 'error', code: 'EACCES' };
  if (!ino.data.startsWith('#!')) return { kind: 'noexec', path, argv: [...argv] };
  // Linux: the rest of the first line after the interpreter path is one optional argument.
  const line = (ino.data.slice(2).split('\n')[0] ?? '').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  const m = /^(\S+)(?:[ \t]+(.*))?$/.exec(line);
  if (!m) return { kind: 'error', code: 'ENOEXEC' };
  const interpreter = m[1] as string;
  const optarg = m[2];
  let interp;
  try {
    interp = fs.checkExec(interpreter);
  } catch (e) {
    if (e instanceof FsError) return { kind: 'bad-interpreter', interpreter, code: e.code };
    throw e;
  }
  if (interp.type !== 'program') return { kind: 'bad-interpreter', interpreter, code: 'ENOEXEC' };
  return {
    kind: 'program',
    program: interp.program,
    argv: [interpreter, ...(optarg !== undefined && optarg !== '' ? [optarg] : []), path, ...argv.slice(1)],
  };
}
