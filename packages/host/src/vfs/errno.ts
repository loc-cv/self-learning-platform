// Error numbers the VFS raises. Names and numbers follow Linux (asm-generic/errno-base.h and
// errno.h); the messages are glibc's strerror text. Programs print messages from these, in their
// own format (`ls: cannot access 'x': No such file or directory`).
// reference: glibc 2.39 (Ubuntu GLIBC 2.39-0ubuntu8.12) os.strerror via Python 3.12.3, LANG=C.UTF-8, captured 2026-11-15

export const ERRNO = {
  EPERM: { errno: 1, message: 'Operation not permitted' },
  ENOENT: { errno: 2, message: 'No such file or directory' },
  EIO: { errno: 5, message: 'Input/output error' },
  ENOEXEC: { errno: 8, message: 'Exec format error' },
  EBADF: { errno: 9, message: 'Bad file descriptor' },
  EACCES: { errno: 13, message: 'Permission denied' },
  EBUSY: { errno: 16, message: 'Device or resource busy' },
  EEXIST: { errno: 17, message: 'File exists' },
  EXDEV: { errno: 18, message: 'Invalid cross-device link' },
  ENOTDIR: { errno: 20, message: 'Not a directory' },
  EISDIR: { errno: 21, message: 'Is a directory' },
  EINVAL: { errno: 22, message: 'Invalid argument' },
  ETXTBSY: { errno: 26, message: 'Text file busy' },
  ENOSPC: { errno: 28, message: 'No space left on device' },
  EROFS: { errno: 30, message: 'Read-only file system' },
  EMLINK: { errno: 31, message: 'Too many links' },
  ENAMETOOLONG: { errno: 36, message: 'File name too long' },
  ENOTEMPTY: { errno: 39, message: 'Directory not empty' },
  ELOOP: { errno: 40, message: 'Too many levels of symbolic links' },
} as const;

export type Errno = keyof typeof ERRNO;

export function strerror(code: Errno): string {
  return ERRNO[code].message;
}

/**
 * A failed file system call. Not world state: it is thrown to the caller, which reports it the way
 * the real program would.
 */
export class FsError extends Error {
  readonly code: Errno;
  readonly errno: number;
  readonly syscall: string;
  readonly path: string;
  constructor(code: Errno, syscall: string, path: string) {
    super(`${syscall} ${JSON.stringify(path)}: ${code} (${ERRNO[code].message})`);
    this.name = 'FsError';
    this.code = code;
    this.errno = ERRNO[code].errno;
    this.syscall = syscall;
    this.path = path;
  }
}

/**
 * The simulator cannot do this (binary content of an executable stub, a generated file with no
 * write support). Callers turn it into a `[sim]` notice and a gap record (docs/FIDELITY.md §4);
 * it must never be shown as if it were a real error.
 */
export class UnsupportedError extends Error {
  readonly what: string;
  constructor(what: string) {
    super(`not simulated: ${what}`);
    this.name = 'UnsupportedError';
    this.what = what;
  }
}

export function isFsError(e: unknown, code?: Errno): e is FsError {
  return e instanceof FsError && (code === undefined || e.code === code);
}
