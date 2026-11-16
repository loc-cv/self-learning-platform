// Reading the log requests: one after another (sequentialConsumeRequest), or all at once when
// following more than one (parallelConsumeRequest, lines interleaved as they arrive). Each request
// is consumeWithRetry: without -f one attempt; with -f a poll every second until the stream opens,
// printing each API error to standard error, for at most --pod-running-timeout. A stream is read
// line by line (DefaultConsumeRequest buffers up to each newline, so prefixes and parallel streams
// never split a line), and a following stream waits in virtual time on the log topic: lines appear
// as the container writes them, and the stream ends when the container has stopped and its log is
// read, when the kubelet goes away, or on Ctrl-C (kubectl's interrupt handler: status 1).
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/logs/logs.go RunLogsContext, parallelConsumeRequest,
//             sequentialConsumeRequest, consumeWithRetry, addPrefixIfNeeded, DefaultConsumeRequest,
//             prefixingWriter
//   upstream: staging/src/k8s.io/apimachinery/pkg/util/wait/poll.go PollUntilContextTimeout (interval
//             1s, immediate), loop.go loopConditionUntilContext (the deadline ends it with ctx.Err():
//             "context deadline exceeded")
//   upstream: staging/src/k8s.io/kubectl/pkg/util/interrupt/interrupt.go (SIGINT: os.Exit(1))

import type { Op } from '@simlab/host';
import type { Millis } from '@simlab/kernel';
import type { Status } from '../../../apimachinery/errors.ts';
import { openPodLog, readPodLog } from '../../../apiserver/log.ts';
import type { LogStream } from '../../../kubelet/logs.ts';
import { LOG_TOPIC } from '../../../runtime/logs.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import type { Session } from '../../client/session.ts';
import type { LogRequest } from './objects.ts';

export interface ConsumeOptions {
  follow: boolean;
  prefix: boolean;
  ignoreErrors: boolean;
  /** --pod-running-timeout, ms. */
  timeout: Millis;
}

type State =
  | { kind: 'open'; at: Millis }
  /** The poll's deadline passed: the request fails with ctx.Err(). */
  | { kind: 'expire'; at: Millis }
  | { kind: 'stream'; stream: LogStream; buf: string }
  | { kind: 'done' };

interface Consumer {
  req: LogRequest;
  prefix: string;
  deadline: Millis;
  state: State;
}

/** What one step produced: standard output, standard error, and the error that ends the command. */
interface Step {
  out: string;
  err: string;
  fail?: KubectlError;
}

const CONTAINER_FROM_FIELD_PATH = /spec\.(?:initContainers|containers|ephemeralContainers){(.+)}/;

/** addPrefixIfNeeded: `[pod/<name>/<container>] ` before each line, with --prefix. */
function prefixFor(o: ConsumeOptions, r: LogRequest): string {
  if (!o.prefix || r.fieldPath === '' || r.pod === '') return '';
  const m = CONTAINER_FROM_FIELD_PATH.exec(r.fieldPath);
  return `[pod/${r.pod}/${m ? (m[1] as string) : ''}] `;
}

/** The complete lines of `buf` with their prefix, and what is left after the last newline. */
function lines(buf: string, prefix: string, flush: boolean): { text: string; rest: string } {
  let text = '';
  let start = 0;
  for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n', start)) {
    text += prefix + buf.slice(start, nl + 1);
    start = nl + 1;
  }
  let rest = buf.slice(start);
  if (flush && rest !== '') {
    text += prefix + rest;
    rest = '';
  }
  return { text, rest };
}

const statusError = (status: Status): KubectlError => ({ type: 'status', status });

/** Advances one consumer as far as it can go at this instant. */
function step(s: Session, o: ConsumeOptions, c: Consumer): Step {
  const now = s.p.now;
  const res: Step = { out: '', err: '' };
  if (c.state.kind === 'expire' && c.state.at <= now) {
    c.state = { kind: 'done' };
    res.fail = messageError('context deadline exceeded');
    return res;
  }
  if (c.state.kind === 'open' && c.state.at <= now) {
    const at = c.state.at;
    const r = openPodLog(s.p.ctx, s.server, c.req.namespace, c.req.pod, c.req.options);
    if ('notSimulated' in r) {
      c.state = { kind: 'done' };
      res.fail = { type: 'notSimulated', what: r.notSimulated };
      return res;
    }
    if ('status' in r) {
      const message = r.status.message ?? '';
      if (o.ignoreErrors) {
        // Written to the command's output (internalErrOut), not to standard error.
        res.out = `error: ${message}\n`;
        c.state = { kind: 'done' };
        return res;
      }
      if (!o.follow) {
        c.state = { kind: 'done' };
        res.fail = statusError(r.status);
        return res;
      }
      // An API error is retried at the next tick; the deadline wins a tie.
      res.err = `${message}\n`;
      const next = at + 1000;
      c.state = next < c.deadline ? { kind: 'open', at: next } : { kind: 'expire', at: c.deadline };
      return res;
    }
    if ('empty' in r) {
      c.state = { kind: 'done' };
      return res;
    }
    c.state = { kind: 'stream', stream: r.stream, buf: '' };
  }
  if (c.state.kind === 'stream') {
    const r = readPodLog(s.p.ctx, c.state.stream);
    const { text, rest } = lines(c.state.buf + r.data, c.prefix, r.stream.done);
    res.out += text;
    c.state = r.stream.done ? { kind: 'done' } : { kind: 'stream', stream: r.stream, buf: rest };
  }
  return res;
}

/** Waits for the next log write or the earliest retry; false when interrupted (Ctrl-C). */
function* waitNext(s: Session, consumers: Consumer[]): Op<boolean> {
  const p = s.p;
  let at: Millis | undefined;
  for (const c of consumers) if ((c.state.kind === 'open' || c.state.kind === 'expire') && (at === undefined || c.state.at < at)) at = c.state.at;
  try {
    if (at === undefined) yield* p.wait(LOG_TOPIC);
    else yield* p.wait(LOG_TOPIC, Math.max(0, at - p.now));
  } catch (e) {
    if (e instanceof Error && e.name === 'Interrupted') return false;
    throw e;
  }
  return true;
}

/** Consumes `requests` (already in the map's order); returns the error that ends the command, 'interrupted', or undefined. */
export function* consume(s: Session, o: ConsumeOptions, requests: LogRequest[]): Op<KubectlError | 'interrupted' | undefined> {
  const p = s.p;
  const start = p.now;
  const make = (req: LogRequest): Consumer => ({ req, prefix: prefixFor(o, req), deadline: start + o.timeout, state: { kind: 'open', at: start } });
  const parallel = o.follow && requests.length > 1;
  const groups: Consumer[][] = parallel ? [requests.map(make)] : requests.map((r) => [make(r)]);
  for (const group of groups) {
    // Each request of a sequential read starts its own poll when its turn comes.
    for (const c of group) {
      c.deadline = p.now + o.timeout;
      if (c.state.kind === 'open') c.state = { kind: 'open', at: p.now };
    }
    for (;;) {
      let out = '';
      let err = '';
      let fail: KubectlError | undefined;
      for (const c of group) {
        const r = step(s, o, c);
        out += r.out;
        err += r.err;
        if (r.fail && !fail) fail = r.fail;
        if (fail) break;
      }
      if (out !== '') yield* p.write(1, out);
      if (err !== '') yield* p.write(2, err);
      if (fail) return fail;
      if (group.every((c) => c.state.kind === 'done')) break;
      if (!(yield* waitNext(s, group))) return 'interrupted';
    }
  }
  return undefined;
}
