// The kubelet's container log endpoint (GET /containerLogs/<namespace>/<pod>/<container>) and the
// reader behind it: which container's log a request means (the Pod's status: running, terminated,
// the previous instance), and the CRI log file read as the kubelet's ReadLogs reads it, with tail,
// since, the byte limit, timestamps and follow. A stream is plain data held by its reader (the
// API server's log request, apiserver/log.ts); following it means reading again when the log
// topic is published (runtime/logs.ts LOG_TOPIC).
//   upstream: pkg/kubelet/server/server.go getContainerLogs (the 400 that carries GetKubeletContainerLogs's error)
//   upstream: pkg/kubelet/kubelet_pods.go GetKubeletContainerLogs, validateContainerLogStatus
//   upstream: pkg/kubelet/kuberuntime/kuberuntime_container.go GetContainerLogs ("unable to retrieve
//             container logs for %v"), kuberuntime_logs.go ReadLogs (since from sinceSeconds or sinceTime)
//   upstream: staging/src/k8s.io/cri-client/pkg/logs/logs.go ReadLogs, parseCRILog, logWriter.write,
//             waitLogs, isContainerRunning; tail.go findTailLineStartIndex

import { daysFromCivil, type Ctx, type Millis } from '@simlab/kernel';
import { createFs, ROOT_CRED, utf8Length, type Fs } from '@simlab/host';
import { isObject, type Json, type JsonObject } from '../apimachinery/json.ts';
import { goQuote } from '../apimachinery/field.ts';
import { parseTime } from '../apimachinery/time.ts';
import { getContainer } from '../runtime/runtime.ts';

/** v1.PodLogOptions as the kubelet decodes them from the query. */
export interface ContainerLogOptions {
  follow: boolean;
  previous: boolean;
  timestamps: boolean;
  sinceSeconds?: number;
  /** RFC 3339, whole seconds (the wire form of metav1.Time). */
  sinceTime?: string;
  tailLines?: number;
  limitBytes?: number;
}

/** An open log stream: where the reader is in the file, and what is left of its limits. */
export interface LogStream {
  node: string;
  containerId: string;
  path: string;
  /** Read position in the file's text. */
  offset: number;
  follow: boolean;
  timestamps: boolean;
  /** Lines older than this are skipped: [ms, nanoseconds below the ms]. */
  since?: [Millis, number];
  /** Bytes still allowed (--limit-bytes); absent: no limit. */
  remain?: number;
  /** Lines still to write in limited mode (tail without follow); absent: no limit. */
  lines?: number;
  /** The last line written ended with a newline: the next one gets its timestamp. */
  newLine: boolean;
  done: boolean;
}

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});
const list = (v: Json | undefined): JsonObject[] => (Array.isArray(v) ? v.filter(isObject) : []);

function rootFs(ctx: Ctx, node: string): Fs {
  return createFs(ctx, node, { cred: ROOT_CRED, umask: 0o022 });
}

/**
 * validateContainerLogStatus: the container ID the request reads, or the error text the kubelet
 * answers with (HTTP 400, which the API server passes on as a BadRequest).
 */
export function containerForLogs(pod: JsonObject, container: string, previous: boolean): { id: string } | { error: string } {
  const name = str(obj(pod.metadata).name);
  const status = obj(pod.status);
  const statuses = [...list(status.containerStatuses), ...list(status.initContainerStatuses), ...list(status.ephemeralContainerStatuses)];
  const cs = statuses.find((s) => str(s.name) === container);
  const q = goQuote;
  if (!cs) return { error: `container ${q(container)} in pod ${q(name)} is not available` };
  const last = obj(obj(cs.lastState).terminated as Json);
  const hasLast = isObject(obj(cs.lastState).terminated as Json);
  const state = obj(cs.state);
  const waiting = isObject(state.waiting as Json) ? obj(state.waiting as Json) : undefined;
  const running = isObject(state.running as Json);
  const terminated = isObject(state.terminated as Json) ? obj(state.terminated as Json) : undefined;
  let id: string;
  if (previous) {
    if (!hasLast || str(last.containerID) === '') return { error: `previous terminated container ${q(container)} in pod ${q(name)} not found` };
    id = str(last.containerID);
  } else if (running) {
    id = str(cs.containerID);
  } else if (terminated) {
    // The next container did not start: its terminated state has no ID; the last one's log is read.
    if (str(terminated.containerID) === '') {
      if (hasLast && str(last.containerID) !== '') id = str(last.containerID);
      else return { error: `container ${q(container)} in pod ${q(name)} is terminated` };
    } else id = str(terminated.containerID);
  } else if (hasLast) {
    if (str(last.containerID) === '') return { error: `container ${q(container)} in pod ${q(name)} is terminated` };
    id = str(last.containerID);
  } else if (waiting) {
    // upstream: pkg/kubelet/images/types.go ErrImagePull, ErrImagePullBackOff
    const reason = str(waiting.reason);
    if (reason === 'ErrImagePull') return { error: `container ${q(container)} in pod ${q(name)} is waiting to start: image can't be pulled` };
    if (reason === 'ImagePullBackOff') return { error: `container ${q(container)} in pod ${q(name)} is waiting to start: trying and failing to pull image` };
    return { error: `container ${q(container)} in pod ${q(name)} is waiting to start: ${reason}` };
  } else {
    return { error: `container ${q(container)} in pod ${q(name)} is waiting to start - no logs yet` };
  }
  // kubecontainer.ParseContainerID: `<type>://<id>`
  const i = id.indexOf('://');
  return { id: i >= 0 ? id.slice(i + 3) : id };
}

/** filepath.EvalSymlinks's error for a missing component: `lstat <the first missing prefix>: …`. */
function missingPrefix(fs: Fs, path: string): string | undefined {
  let cur = '';
  for (const part of path.split('/').filter(Boolean)) {
    cur += `/${part}`;
    try {
      fs.lstat(cur);
    } catch {
      return cur;
    }
  }
  return undefined;
}

/** tail.go findTailLineStartIndex: the start of the last `n` complete lines (an unterminated last line is not counted). */
export function tailStart(text: string, n: number | undefined): number {
  if (n === undefined || n < 0) return 0;
  let cnt = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) cnt++;
  let start = 0;
  for (; cnt > n; cnt--) start = text.indexOf('\n', start) + 1;
  return start;
}

/** The kubelet's view of "now minus sinceSeconds", or sinceTime when that is later (kuberuntime_logs.go ReadLogs). */
function sinceOf(now: Millis, o: ContainerLogOptions): [Millis, number] | undefined {
  let since: Millis | undefined;
  if (o.sinceSeconds !== undefined) since = now - o.sinceSeconds * 1000;
  if (o.sinceTime !== undefined) {
    const t = parseTime(o.sinceTime, false);
    if ('micros' in t && (since === undefined || t.micros / 1000 > since)) since = t.micros / 1000;
  }
  return since === undefined ? undefined : [since, 0];
}

/**
 * GetKubeletContainerLogs from the container status on: the stream, or the error text of the
 * kubelet's 400 answer. `pod` is the Pod as the kubelet knows it (its status).
 */
export function openContainerLog(ctx: Ctx, node: string, pod: JsonObject, container: string, o: ContainerLogOptions): { stream: LogStream } | { error: string } {
  const c = containerForLogs(pod, container, o.previous);
  if ('error' in c) return c;
  const rc = getContainer(ctx, node, c.id);
  if (!rc) return { error: `unable to retrieve container logs for containerd://${c.id}` };
  const fs = rootFs(ctx, node);
  const missing = missingPrefix(fs, rc.logPath);
  if (missing !== undefined) return { error: `failed to try resolving symlinks in path ${goQuote(rc.logPath)}: lstat ${missing}: no such file or directory` };
  let text: string;
  try {
    text = fs.readFile(rc.logPath);
  } catch {
    // Opening a directory succeeds; reading it does not (EISDIR).
    const p = rc.logPath;
    if (o.tailLines !== undefined && o.tailLines >= 0) return { error: `failed to tail ${o.tailLines} lines of log file ${goQuote(p)}: read ${p}: is a directory` };
    return { error: `failed to read log file ${goQuote(p)}: read ${p}: is a directory` };
  }
  const since = sinceOf(ctx.now, o);
  const stream: LogStream = {
    node,
    containerId: c.id,
    path: rc.logPath,
    offset: tailStart(text, o.tailLines),
    follow: o.follow,
    timestamps: o.timestamps,
    newLine: true,
    done: false,
    ...(since ? { since } : {}),
    ...(o.limitBytes !== undefined ? { remain: o.limitBytes } : {}),
    // limitedMode: tail without follow stops after that many lines.
    ...(o.tailLines !== undefined && !o.follow ? { lines: o.tailLines } : {}),
  };
  return { stream };
}

interface CriLine {
  at: [Millis, number];
  stamp: string;
  stream: string;
  log: string;
}

const CRI = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}) (\S*) /;

/** parseCRILog: timestamp, stream, tag and content; undefined for a line that does not parse (skipped, as the kubelet logs and skips it). */
function parseCriLine(line: string): CriLine | undefined {
  const m = CRI.exec(line);
  if (!m) return undefined;
  const stream = m[9] as string;
  if (stream !== 'stdout' && stream !== 'stderr') return undefined;
  let rest = line.slice(m[0].length);
  const sp = rest.indexOf(' ');
  if (sp < 0) return undefined;
  const partial = (rest.slice(0, sp).split(':')[0] ?? '') === 'P';
  if (partial && rest.endsWith('\n')) rest = rest.slice(0, -1);
  const frac = ((m[7] ?? '') + '000000000').slice(0, 9);
  const zone = m[8] as string;
  const offsetMin = zone === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  const seconds = daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3])) * 86400 + Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6]);
  const ms = (seconds - offsetMin * 60) * 1000 + Number(frac.slice(0, 3));
  // timeFormatOut, RFC3339NanoFixed: nine digits, in the timestamp's own zone.
  const stamp = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${frac}${zone}`;
  return { at: [ms, Number(frac.slice(3))], stamp, stream, log: rest.slice(sp + 1) };
}

const before = (a: [Millis, number], b: [Millis, number]): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/** The longest prefix of `s` with at most `n` bytes of UTF-8. */
function cutBytes(s: string, n: number): string {
  let bytes = 0;
  let i = 0;
  for (const ch of s) {
    const b = utf8Length(ch);
    if (bytes + b > n) break;
    bytes += b;
    i += ch.length;
  }
  return s.slice(0, i);
}

/** Whether the container is running (isContainerRunning); a container the runtime no longer has is not. */
export function containerRunning(ctx: Ctx, s: LogStream): boolean {
  return getContainer(ctx, s.node, s.containerId)?.state === 'running';
}

/**
 * Reads what the file holds after the stream's position: ReadLogs up to the end of the file. The
 * stream is done when the reader returned (limits reached, the end of a non-following read, or
 * the end of the log of a container that is no longer running); otherwise it waits for more.
 */
export function readContainerLog(ctx: Ctx, s0: LogStream): { data: string; stream: LogStream } {
  const s: LogStream = { ...s0 };
  if (s.done) return { data: '', stream: s };
  let text: string;
  try {
    text = rootFs(ctx, s.node).readFile(s.path);
  } catch {
    // The file was removed while open: what it held stays readable through the open descriptor,
    // and nothing more is written to it.
    text = '';
  }
  let out = '';
  const finish = (): { data: string; stream: LogStream } => ({ data: out, stream: { ...s, done: true } });
  // A following reader decides whether more can come before it reads to the end (waitLogs checks
  // the container first; after it stopped, what is left is read and the stream ends).
  const ending = s.follow && !containerRunning(ctx, s);
  while (s.offset < text.length) {
    if (s.lines !== undefined && s.lines <= 0) return finish();
    const nl = text.indexOf('\n', s.offset);
    let line: string;
    if (nl < 0) {
      // An incomplete last line: a following reader waits for the rest; any other reads it and stops.
      if (s.follow) break;
      line = text.slice(s.offset);
      s.offset = text.length;
    } else {
      line = text.slice(s.offset, nl + 1);
      s.offset = nl + 1;
    }
    const msg = parseCriLine(line);
    if (!msg) continue;
    if (!(s.since && before(msg.at, s.since))) {
      let w = s.timestamps && s.newLine ? `${msg.stamp} ${msg.log}` : msg.log;
      let full = true;
      if (s.remain !== undefined && utf8Length(w) > s.remain) {
        w = cutBytes(w, s.remain);
        full = false;
      }
      out += w;
      if (s.remain !== undefined) {
        s.remain = full ? s.remain - utf8Length(w) : 0;
        if (s.remain <= 0) return finish();
      }
    }
    if (s.lines !== undefined) s.lines--;
    s.newLine = msg.log.length === 0 || msg.log.endsWith('\n');
    if (nl < 0) return finish();
  }
  if (!s.follow || ending || (s.lines !== undefined && s.lines <= 0)) return finish();
  return { data: out, stream: s };
}
