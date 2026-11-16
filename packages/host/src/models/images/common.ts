// Facts and helpers the models of the official images' programs share: the environment, the
// clock in the programs' formats, the shell an entrypoint script runs under, and what the node
// gives every container (kernel release, open-files limit).

import { civilFromMillis, type Civil, type Millis } from '@simlab/kernel';
import { execNotFound, shellVariant, type ShellVariant } from '../sh/variant.ts';
import type { ModelStep, Output, OutputStream, ProcessInput } from '../types.ts';

/** getenv(3): the first entry with this name, as glibc and musl scan environ. */
export function getenv(p: ProcessInput, name: string): string | undefined {
  return p.env.find(([k]) => k === name)?.[1];
}

/** Containers run in UTC: no TZ, no /etc/localtime in these images, so localtime is gmtime. */
export function utc(t: Millis): Civil {
  return civilFromMillis(t);
}

export const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export const line = (stream: OutputStream, text: string, after?: Millis): Output => (after ? { after, stream, text: `${text}\n` } : { stream, text: `${text}\n` });

/**
 * The release `uname -r` gives inside every container: the node's kernel, as
 * packages/k8s/src/topology/nodes.ts NODE_INFO.kernelVersion reports it (D-033). Repeated here
 * because the host package cannot import the Kubernetes plugin; keep the two equal.
 */
export const NODE_KERNEL_RELEASE = '6.8.0-88-generic';

/**
 * RLIMIT_NOFILE (soft:hard) of a container's processes. The CRI plugin removes the OCI default
 * spec's rlimits when the runtime has no base spec (upstream containerd v1.7.28:
 * pkg/cri/server/container_create_linux.go containerSpec → pkg/cri/opts/spec_opts.go:165
 * WithoutDefaultSecuritySettings, "Remove default rlimits"), so the process keeps containerd's,
 * which containerd.service sets with LimitNOFILE=infinity (containerd.service at the same tag).
 * systemd cannot raise RLIMIT_NOFILE above fs.nr_open and settles on its own hard limit, which
 * on Ubuntu 24.04 (systemd 255) is 1048576.
 * reference: /proc/1/limits and /proc/sys/fs/nr_open on the workstation (systemd 255.4, Ubuntu
 * 24.04 base), read 2026-11-16: "Max open files 1048576 1048576". Assumes the node runs
 * containerd under the upstream unit file, as the kubeadm installation docs do.
 */
export const CONTAINER_NOFILE = { soft: 1048576, hard: 1048576 } as const;

/** The shell `#!/bin/sh` (or `#!/bin/bash`) names in this image. */
export function scriptShell(p: ProcessInput, interpreter = '/bin/sh'): ShellVariant {
  return shellVariant(p.which(interpreter)?.variant ?? 'dash');
}

/**
 * A script's `exec cmd args…` on line `lineNo`: the program replaces the shell, or, when no such
 * file exists, the shell's own error and status 127 (dash, ash and bash all exit 127).
 */
export function scriptExec(p: ProcessInput, shell: ShellVariant, lineNo: number, argv: string[], output: Output[] = [], after?: Millis): ModelStep {
  const cmd = argv[0];
  if (cmd === undefined) return { ...(output.length ? { output } : {}), next: { exit: 0, ...(after ? { after } : {}) } };
  const exe = p.which(cmd);
  if (!exe) {
    return {
      output: [...output, { ...(after ? { after } : {}), stream: 'stderr', text: execNotFound(shell, p.exe.path, lineNo, cmd) }],
      next: { exit: 127, ...(after ? { after } : {}) },
    };
  }
  return { ...(output.length ? { output } : {}), next: { exec: { exe, argv }, ...(after ? { after } : {}) } };
}

/** Delay until an absolute time, never negative. */
export const until = (at: Millis, now: Millis): Millis => Math.max(0, at - now);
