// kubectl logs: the logs of a container in a Pod, of the first Pod of a workload, or of the Pods a
// selector finds, through the API server's pods/log subresource (apiserver/log.ts) and the node's
// kubelet (kubelet/logs.ts).
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/logs/logs.go NewCmdLogs (flags and defaults: tail
//             -1, max-log-requests 5, pod-running-timeout 20s), ToLogOptions (since rounded to whole
//             seconds, a selector's default tail of 10), Complete (argument count, the builder:
//             ResourceNames("pods", arg) or ResourceTypes("pods").LabelSelectorParam, "error from
//             server (NotFound): … in namespace …", "No resources found in … namespace."), Validate,
//             RunLogsContext (the --max-log-requests check)
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go GetPodRunningTimeoutFlag, UsageErrorf
//   upstream: staging/src/k8s.io/kubectl/pkg/util/util.go ParseRFC3339 (RFC3339Nano, then RFC3339's error)
//   upstream: Go src/time/time.go Duration.Round (halves away from zero)
//   fixtures/golden/v1.37.2/logs/before-the-kubelet.yaml

import type { Op } from '@simlab/host';
import { isObject, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import { formatTime, parseTime } from '../../../apimachinery/time.ts';
import type { PodLogOptions } from '../../../apiserver/log.ts';
import type { Invocation, Verb } from '../../cli/command.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import type { FlagDef } from '../../cli/flagset.ts';
import { parseGoDuration } from '../../cli/goduration.ts';
import { fail, openSession, overridesOf, request, resolveConfig, type Session } from '../../client/session.ts';
import { buildPlan } from '../../resource/builder.ts';
import { enhanceListError } from '../get.ts';
import { usageError } from '../helpers.ts';
import { parseYaml } from '../printing.ts';
import { consume } from './consume.ts';
import { goMapOrder, logsForObject, type LogObject } from './objects.ts';

const FLAGS: FlagDef[] = [
  { name: 'all-pods', kind: 'bool', default: false },
  { name: 'all-containers', kind: 'bool', default: false },
  { name: 'follow', shorthand: 'f', kind: 'bool', default: false },
  { name: 'timestamps', kind: 'bool', default: false },
  { name: 'limit-bytes', kind: 'int64', default: 0 },
  { name: 'previous', shorthand: 'p', kind: 'bool', default: false },
  { name: 'tail', kind: 'int64', default: -1 },
  { name: 'ignore-errors', kind: 'bool', default: false },
  { name: 'since-time', kind: 'string', default: '' },
  { name: 'since', kind: 'duration', default: '0s' },
  { name: 'container', shorthand: 'c', kind: 'string', default: '' },
  { name: 'pod-running-timeout', kind: 'duration', default: '20s' },
  { name: 'selector', shorthand: 'l', kind: 'string', default: '' },
  { name: 'max-log-requests', kind: 'int', default: 5 },
  { name: 'prefix', kind: 'bool', default: false },
];

const USAGE = 'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]';
const USAGE_ERR = `expected '${USAGE}'.\nPOD or TYPE/NAME is a required argument for the logs command`;
/** logs.go selectorTail */
const SELECTOR_TAIL = 10;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** A duration flag's value in nanoseconds (the flag parser has checked it). */
function durationNs(raw: unknown): bigint {
  const r = parseGoDuration(str(raw));
  return 'ns' in r ? r.ns : 0n;
}

/** Duration.Round(time.Second) in whole seconds. */
function roundSeconds(ns: bigint): number {
  const m = 1_000_000_000n;
  const neg = ns < 0n;
  const a = neg ? -ns : ns;
  const r = a % m;
  const q = a / m + (r + r < m ? 0n : 1n);
  return Number(neg ? -q : q);
}

/** The builder's object: a Pod, the PodList of a selector, or another kind with its Go type. */
function* fetchObject(s: Session, namespace: string, resourceArg: string, selector: string): Op<LogObject | KubectlError> {
  const plan = buildPlan(
    selector !== ''
      ? { args: ['pods'], namespace, allNamespaces: false, labelSelector: selector, singleResourceType: true }
      : { args: resourceArg === '' ? [] : [resourceArg.includes('/') ? resourceArg : `pods/${resourceArg}`], namespace, allNamespaces: false, singleResourceType: true },
  );
  if ('type' in plan) return plan;
  const visit = plan.visits[0];
  if (!visit) return messageError('expected a resource');
  const m = visit.mapping;
  if (visit.kind === 'list') {
    const r = yield* request(s, { verb: 'list', group: m.group, version: m.version, resource: m.resource, namespace: visit.namespace, options: { labelSelector: visit.labelSelector } });
    if (!r.ok) return 'notSimulated' in r ? { type: 'notSimulated', what: r.notSimulated } : { type: 'status', status: enhanceListError(r.status, visit) };
    const items = (Array.isArray((r.object as JsonObject).items) ? ((r.object as JsonObject).items as Json[]) : []).filter(isObject);
    if (items.length === 0) yield* s.p.write(2, `No resources found in ${namespace} namespace.\n`);
    return { kind: 'PodList', items: items.map((i) => ({ apiVersion: 'v1', kind: 'Pod', ...i })) };
  }
  if (visit.kind !== 'get') return messageError('expected a resource');
  const r = yield* request(s, { verb: 'get', group: m.group, version: m.version, resource: m.resource, ...(visit.namespace ? { namespace: visit.namespace } : {}), name: visit.name });
  if (!r.ok) {
    if ('notSimulated' in r) return { type: 'notSimulated', what: `the resource type "${m.resource}${m.group ? `.${m.group}` : ''}"` };
    let status = r.status;
    // Info.Get: an object not found outside default may be missing because its namespace is.
    // upstream: staging/src/k8s.io/cli-runtime/pkg/resource/visitor.go Info.Get
    if (status.reason === 'NotFound' && visit.namespace !== '' && visit.namespace !== 'default') {
      const ns = yield* request(s, { verb: 'get', group: '', version: 'v1', resource: 'namespaces', name: visit.namespace });
      if (!ns.ok && !('notSimulated' in ns) && ns.status.reason === 'NotFound') status = ns.status;
    }
    if (status.reason === 'NotFound') return messageError(`error from server (NotFound): ${status.message ?? ''} in namespace ${JSON.stringify(namespace)}`);
    return { type: 'status', status };
  }
  const o = r.object as JsonObject;
  if (m.group === '' && m.kind === 'Pod') return { kind: 'Pod', pod: o };
  // %T of the typed object the scheme decodes: *<version package>.<Kind>.
  return { kind: 'other', object: o, goType: `*${m.version}.${m.kind}` };
}

function* run(inv: Invocation): Op<number> {
  const { p, flags } = inv;
  const v = flags.values;
  const config = resolveConfig(p, overridesOf(v), parseYaml);
  if ('type' in config) return yield* fail(p, config);
  // Complete
  const containerSpecified = flags.changed.includes('container');
  const tailSpecified = flags.changed.includes('tail');
  const selector = str(v.selector);
  let container = str(v.container);
  let resourceArg = '';
  const args = inv.args;
  switch (args.length) {
    case 0:
      if (selector === '') return yield* fail(p, usageError('logs', USAGE_ERR));
      break;
    case 1:
      resourceArg = args[0] as string;
      if (selector !== '') return yield* fail(p, usageError('logs', 'only a selector (-l) or a POD name is allowed'));
      break;
    case 2:
      resourceArg = args[0] as string;
      container = args[1] as string;
      break;
    default:
      return yield* fail(p, usageError('logs', USAGE_ERR));
  }
  const allPods = v['all-pods'] === true;
  const prefix = v.prefix === true || allPods;
  const timeoutNs = durationNs(v['pod-running-timeout']);
  if (timeoutNs <= 0n) return yield* fail(p, messageError('--pod-running-timeout must be higher than zero'));
  const timeout = Number(timeoutNs / 1_000_000n);
  // ToLogOptions
  const options: PodLogOptions = { container, follow: v.follow === true, previous: v.previous === true, timestamps: v.timestamps === true };
  const sinceTimeRaw = str(v['since-time']);
  if (sinceTimeRaw !== '') {
    const t = parseTime(sinceTimeRaw, false);
    if ('error' in t) return yield* fail(p, messageError(t.error));
    // metav1.Time goes on the query string as RFC 3339, whole seconds.
    options.sinceTime = formatTime(t.micros);
  }
  const limitBytes = num(v['limit-bytes']);
  if (limitBytes !== 0) options.limitBytes = limitBytes;
  const sinceNs = durationNs(v.since);
  if (sinceNs !== 0n) options.sinceSeconds = roundSeconds(sinceNs);
  const tail = num(v.tail);
  if (selector !== '' && tail === -1 && !tailSpecified) options.tailLines = SELECTOR_TAIL;
  else if (tail !== -1) options.tailLines = tail;
  if (v['insecure-skip-tls-verify-backend'] === true) options.insecureSkipTLSVerifyBackend = true;
  // The builder (discovery and with it the connection come first).
  const s = yield* openSession(p, config);
  if (typeof s === 'number') return s;
  const object = yield* fetchObject(s, config.namespace, resourceArg, selector);
  if ('type' in object) return yield* fail(p, object);
  // Validate
  const allContainers = v['all-containers'] === true;
  if (sinceTimeRaw !== '' && sinceNs !== 0n) return yield* fail(p, messageError('at most one of `sinceTime` or `sinceSeconds` may be specified'));
  if (allContainers && container !== '') return yield* fail(p, messageError(`--all-containers=true should not be specified with container name ${container}`));
  if (containerSpecified && args.length === 2) return yield* fail(p, messageError('only one of -c or an inline [CONTAINER] arg is allowed'));
  if (limitBytes < 0) return yield* fail(p, messageError('--limit-bytes must be greater than 0'));
  if (options.sinceSeconds !== undefined && options.sinceSeconds < 0) return yield* fail(p, messageError('--since must be greater than 0'));
  if (options.tailLines !== undefined && options.tailLines < -1) return yield* fail(p, messageError('--tail must be greater than or equal to -1'));
  // RunLogsContext: under kubectl's interrupt handler from here on.
  p.trap(2, 'interrupt');
  let requests;
  try {
    requests = yield* logsForObject({ s, options, timeout, allContainers, allPods }, object);
  } catch (e) {
    if (e instanceof Error && e.name === 'Interrupted') return 1;
    throw e;
  }
  if (!Array.isArray(requests)) return yield* fail(p, requests);
  const follow = options.follow === true;
  const max = num(v['max-log-requests']);
  if (follow && requests.length > 1 && requests.length > max) {
    return yield* fail(
      p,
      messageError(`you are attempting to follow ${requests.length} log streams, but maximum allowed concurrency is ${max}, use --max-log-requests to increase the limit`),
    );
  }
  const ordered = goMapOrder(requests, p.random('kubectl.logs.requests'));
  const r = yield* consume(s, { follow, prefix, ignoreErrors: v['ignore-errors'] === true, timeout }, ordered);
  if (r === 'interrupted') return 1;
  if (r) return yield* fail(p, r);
  return 0;
}

export const logsVerb: Verb = {
  path: 'logs',
  flags: FLAGS,
  noEffect: {
    'insecure-skip-tls-verify-backend': 'the simulated kubelets serve valid certificates, so skipping their verification changes nothing',
  },
  run,
};
