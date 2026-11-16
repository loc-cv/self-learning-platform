// Container logs in the node's filesystem, as the kubelet lays them out and containerd writes them:
// /var/log/pods/<namespace>_<pod>_<uid>/<container>/<restartCount>.log in the CRI log format, one
// line per line of output: `<RFC 3339 nano time> <stream> <tag> <text>`. `kubectl logs` (phase 07a),
// `crictl logs` and `cat` read the same bytes.
//
// upstream: pkg/kubelet/kuberuntime/helpers.go BuildPodLogsDirectory, BuildContainerLogsDirectory,
// buildContainerLogsPath (`<restartCount>.log`); pkg/kubelet/kuberuntime/logs/logs.go (the format
// the kubelet parses: timestamp, stream, P/F tag, content). docs/ARCHITECTURE.md §4.8.

import type { Ctx, Millis } from '@simlab/kernel';
import { createFs, ROOT_CRED, type Fs } from '@simlab/host';
import { civilFromMillis } from '@simlab/kernel';

export const POD_LOGS_ROOT = '/var/log/pods';

export function podLogsDirectory(namespace: string, name: string, uid: string): string {
  return `${POD_LOGS_ROOT}/${namespace}_${name}_${uid}`;
}

export function containerLogPath(namespace: string, name: string, uid: string, container: string, restartCount: number): string {
  return `${podLogsDirectory(namespace, name, uid)}/${container}/${restartCount}.log`;
}

function rootFs(ctx: Ctx, node: string): Fs {
  return createFs(ctx, node, { cred: ROOT_CRED, umask: 0o022 });
}

function mkdirs(fs: Fs, path: string): void {
  let cur = '';
  for (const p of path.split('/').filter(Boolean)) {
    cur += `/${p}`;
    try {
      fs.stat(cur);
    } catch {
      fs.mkdir(cur, 0o755);
    }
  }
}

/**
 * Go's time.RFC3339Nano in UTC: nine fractional digits with trailing zeros removed. The virtual
 * clock has milliseconds; `subMs` adds the nanoseconds below them.
 */
export function rfc3339Nano(ms: Millis, subMs: number): string {
  const c = civilFromMillis(ms);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const frac = `${String(c.ms).padStart(3, '0')}${String(subMs).padStart(6, '0')}`.replace(/0+$/, '');
  return `${String(c.year).padStart(4, '0')}-${p2(c.month)}-${p2(c.day)}T${p2(c.hour)}:${p2(c.minute)}:${p2(c.second)}${frac ? `.${frac}` : ''}Z`;
}

/**
 * Creates the empty log file of a new container: the kubelet makes the directories 0755
 * (kuberuntime_sandbox.go, kuberuntime_container.go), containerd opens the file
 * O_CREATE|O_APPEND|O_WRONLY 0640 (pkg/cri/server/helpers_linux.go).
 */
export function createLogFile(ctx: Ctx, node: string, path: string): void {
  const fs = rootFs(ctx, node);
  mkdirs(fs, path.slice(0, path.lastIndexOf('/')));
  fs.writeFile(path, '', { mode: 0o640 });
}

export const CONTAINER_LOGS_ROOT = '/var/log/containers';

/**
 * The legacy symlink /var/log/containers/<pod>_<namespace>_<container>-<id>.log, made after a
 * successful start (pkg/kubelet/kuberuntime/legacy.go legacyLogSymlink, kuberuntime_container.go).
 */
export function legacyLogSymlink(namespace: string, pod: string, container: string, id: string): string {
  const name = `${pod}_${namespace}_${container}-${id}`;
  // The file name is cut to 255 bytes including the `.log` suffix.
  return `${CONTAINER_LOGS_ROOT}/${name.slice(0, 251)}.log`;
}

export function createLegacySymlink(ctx: Ctx, node: string, link: string, target: string): void {
  const fs = rootFs(ctx, node);
  mkdirs(fs, CONTAINER_LOGS_ROOT);
  try {
    fs.symlink(target, link);
  } catch {
    // exists already
  }
}

/**
 * Appends lines of one stream, each stamped with the time it was written: `F` for a line whose
 * newline arrived, `P` for what was left without one when the stream closed
 * (containerd pkg/cri/io/logger.go redirectLogs; lines over 16 KiB are not produced by any model).
 */
export function appendLogLines(ctx: Ctx, node: string, path: string, stream: 'stdout' | 'stderr', lines: string[], tag: 'F' | 'P' = 'F', clock?: LogClock): LogClock | undefined {
  if (lines.length === 0) return clock;
  const fs = rootFs(ctx, node);
  const rnd = ctx.random('k8s.runtime.log-time');
  let text = '';
  let c = clock;
  for (const line of lines) {
    // A real clock never runs backwards: within one millisecond each line is later than the last.
    const sub = c && c.at === ctx.now ? Math.min(999_999, c.sub + 1 + rnd.int(Math.max(1, Math.floor((999_999 - c.sub) / 8)))) : rnd.int(500_000);
    c = { at: ctx.now, sub };
    text += `${rfc3339Nano(ctx.now, sub)} ${stream} ${tag} ${line.replace(/\r$/, '')}\n`;
  }
  try {
    fs.writeFile(path, text, { append: true });
  } catch {
    // The directory was removed (Pod deleted): containerd's write fails and the output is lost.
  }
  return c;
}

/** The last stamp written to a container's log: ms of the virtual clock and the nanoseconds below. */
export interface LogClock {
  at: Millis;
  sub: number;
}

/** Removes a Pod's log directory (the kubelet does so when the Pod is gone). */
export function removePodLogs(ctx: Ctx, node: string, namespace: string, name: string, uid: string): void {
  const fs = rootFs(ctx, node);
  const rm = (path: string): void => {
    let st;
    try {
      st = fs.lstat(path);
    } catch {
      return;
    }
    if (st.type === 'dir') {
      for (const e of fs.readdir(path)) rm(`${path}/${e}`);
      fs.rmdir(path);
    } else fs.unlink(path);
  };
  rm(podLogsDirectory(namespace, name, uid));
}

/** Removes one container's log file (container garbage collection). */
export function removeLogFile(ctx: Ctx, node: string, path: string): void {
  try {
    rootFs(ctx, node).unlink(path);
  } catch {
    // already gone
  }
}
