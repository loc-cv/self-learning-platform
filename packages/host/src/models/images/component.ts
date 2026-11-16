// A stand-in for the control-plane and add-on binaries the cluster's own images run (coredns,
// kube-proxy, kube-apiserver, kube-controller-manager, kube-scheduler, etcd, and go-runner, the
// wrapper of the kube-* images) until each gets its own model (phase 27 and later). Temporary
// shortcut (STATUS.md): it runs until signaled, writes nothing (the real programs log a great
// deal), and exits 0 on SIGTERM or SIGINT. No gap is recorded per start: every cluster boots
// several of these, and the shortcut is listed once, in STATUS.md.

import type { ModelStep, ProgramModel } from '../types.ts';

export const componentModel: ProgramModel = {
  name: 'component',
  start: (): ModelStep => ({ next: { wait: true, state: null } }),
  resume: () => ({ next: { wait: true, state: null } }),
  signal(_p, _state, sig) {
    if (sig === 'SIGTERM' || sig === 'SIGINT') return { next: { exit: 0 } };
    return 'default';
  },
};
