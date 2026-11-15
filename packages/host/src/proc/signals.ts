// Signal numbers on Linux x86_64.
// upstream: Linux v6.8 include/uapi/asm-generic/signal.h (the workstation's
// /usr/include/asm-generic/signal.h); names as `kill -l` prints them in bash 5.2.21, captured 2026-11-16.

export const SIGHUP = 1;
export const SIGINT = 2;
export const SIGQUIT = 3;
export const SIGKILL = 9;
export const SIGPIPE = 13;
export const SIGTERM = 15;
export const SIGCHLD = 17;
export const SIGCONT = 18;
export const SIGSTOP = 19;
export const SIGTSTP = 20;

const NAMES: Record<number, string> = {
  1: 'HUP', 2: 'INT', 3: 'QUIT', 4: 'ILL', 5: 'TRAP', 6: 'ABRT', 7: 'BUS', 8: 'FPE', 9: 'KILL',
  10: 'USR1', 11: 'SEGV', 12: 'USR2', 13: 'PIPE', 14: 'ALRM', 15: 'TERM', 16: 'STKFLT',
  17: 'CHLD', 18: 'CONT', 19: 'STOP', 20: 'TSTP', 21: 'TTIN', 22: 'TTOU', 23: 'URG', 24: 'XCPU',
  25: 'XFSZ', 26: 'VTALRM', 27: 'PROF', 28: 'WINCH', 29: 'IO', 30: 'PWR', 31: 'SYS',
};

/** `INT` for 2; undefined for a number that is not a classic signal. */
export function signalName(n: number): string | undefined {
  return NAMES[n];
}

/** The exit status a shell reports for a process killed by signal `n` (bash(1), EXIT STATUS). */
export function statusOfSignal(n: number): number {
  return 128 + n;
}

/**
 * strsignal(3) text, which bash prints for a foreground job killed by a signal.
 * reference: glibc 2.39 strsignal via Python 3.12.3 signal.strsignal, captured 2026-11-16
 */
const DESCRIPTIONS: Record<number, string> = {
  1: 'Hangup', 2: 'Interrupt', 3: 'Quit', 4: 'Illegal instruction', 5: 'Trace/breakpoint trap',
  6: 'Aborted', 7: 'Bus error', 8: 'Floating point exception', 9: 'Killed', 10: 'User defined signal 1',
  11: 'Segmentation fault', 12: 'User defined signal 2', 13: 'Broken pipe', 14: 'Alarm clock',
  15: 'Terminated', 16: 'Stack fault', 17: 'Child exited', 18: 'Continued', 19: 'Stopped (signal)',
  20: 'Stopped', 21: 'Stopped (tty input)', 22: 'Stopped (tty output)', 23: 'Urgent I/O condition',
  24: 'CPU time limit exceeded', 25: 'File size limit exceeded', 26: 'Virtual timer expired',
  27: 'Profiling timer expired', 28: 'Window changed', 29: 'I/O possible', 30: 'Power failure',
  31: 'Bad system call',
};

export function strsignal(n: number): string {
  return DESCRIPTIONS[n] ?? `Unknown signal ${n}`;
}
