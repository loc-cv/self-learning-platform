// registry.k8s.io/pause: the Pod sandbox's init. It writes nothing, waits for signals for ever
// and reaps the zombies of processes that shared its PID namespace.
//
// upstream: kubernetes v1.37.2 build/pause/linux/pause.c (main, sigdown, sigreap). SIGINT and
// SIGTERM run sigdown: psignal(signo, "Shutting down, got signal") and exit(0). The binary is
// linked statically against glibc (build/pause/Makefile: $(TRIPLE)-gcc -static), whose psignal
// prints "<msg>: <strsignal>\n" on stderr.
// reference: glibc 2.39 psignal(15, …) and psignal(2, …) on the workstation, 2026-11-16:
// "Shutting down, got signal: Terminated", "Shutting down, got signal: Interrupt".

import type { ModelStep, ProgramModel } from '../types.ts';

const STRSIGNAL = { SIGTERM: 'Terminated', SIGINT: 'Interrupt' } as const;

export const pauseModel: ProgramModel = {
  name: 'pause',
  start(p): ModelStep {
    // `-v` prints "pause.c v<TAG>-<git describe>", a build-time string the capture does not have.
    if (p.argv.slice(1).some((a) => a.toLowerCase() === '-v')) return { gaps: [{ what: 'pause -v', detail: 'the build version string was not captured' }], next: { exit: 0 } };
    // "Not an error because pause sees use outside of infra containers."
    const output = p.pid !== 1 ? [{ stream: 'stderr' as const, text: 'Warning: pause should be the first process\n' }] : [];
    return { ...(output.length ? { output } : {}), next: { wait: true, state: null } };
  },
  resume: () => ({ next: { wait: true, state: null } }),
  signal(_p, _state, sig) {
    if (sig === 'SIGTERM' || sig === 'SIGINT') return { output: [{ stream: 'stderr', text: `Shutting down, got signal: ${STRSIGNAL[sig]}\n` }], next: { exit: 0 } };
    // No handler for anything else: the default action (ignored for PID 1).
    return 'default';
  },
};
