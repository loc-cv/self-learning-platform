// The filter plugins of the default profile that the simulator models, with their reason strings
// and status codes. Queueing hints are in hints.ts.
//
// upstream (pkg/scheduler/framework/plugins/):
//   nodeunschedulable/node_unschedulable.go Filter, ErrReasonUnschedulable
//   nodename/node_name.go Filter, Fits, ErrReason
//   tainttoleration/taint_toleration.go Filter ("node(s) had untolerated taint(s)")
//   nodeaffinity/node_affinity.go PreFilter (Skip; matchFields metadata.name narrowing;
//     errReasonConflict), Filter, ErrReasonPod
//   nodeports/node_ports.go PreFilter (Skip without host ports), Filter, fitsPorts, ErrReason;
//     kube-scheduler/framework/types.go HostPortInfo.CheckConflict
//   noderesources/fit.go PreFilter (computePodResourceRequest), Filter, fitsRequest

import type { ApiObject } from '../../apiserver/store.ts';
import { findUntoleratedTaint, matchesRequiredNodeAffinity, requiredNodeAffinityTerms, taintsOf, tolerationsOf, tolerationsTolerateTaint } from '../helpers.ts';
import { arr, podRequests, type ResourceList } from '../resources.ts';
import { hostPorts } from '../snapshot.ts';
import { status, SUCCESS, type CycleState, type FilterPlugin, type HostPort, type NodeInfo, type Status } from '../types.ts';
import { isObject } from '../../apimachinery/json.ts';
import { specOf, str } from '../util.ts';

export const ERR_REASON_UNSCHEDULABLE = 'node(s) were unschedulable';
export const ERR_REASON_NODE_NAME = "node(s) didn't match the requested node name";
export const ERR_REASON_UNTOLERATED_TAINT = 'node(s) had untolerated taint(s)';
export const ERR_REASON_NODE_AFFINITY = "node(s) didn't match Pod's node affinity/selector";
export const ERR_REASON_AFFINITY_CONFLICT = 'pod affinity terms conflict';
export const ERR_REASON_NODE_PORTS = "node(s) didn't have free ports for the requested pod ports";

/** v1.TaintNodeUnschedulable. */
export const TAINT_NODE_UNSCHEDULABLE = 'node.kubernetes.io/unschedulable';

export const nodeUnschedulable: FilterPlugin = {
  name: 'NodeUnschedulable',
  filter(_state, pod, node) {
    if (specOf(node.node).unschedulable !== true) return SUCCESS;
    // A Pod that tolerates the unschedulable taint also tolerates .spec.unschedulable.
    if (tolerationsTolerateTaint(tolerationsOf(pod), { key: TAINT_NODE_UNSCHEDULABLE, value: '', effect: 'NoSchedule' })) return SUCCESS;
    return status('UnschedulableAndUnresolvable', ERR_REASON_UNSCHEDULABLE);
  },
};

export const nodeName: FilterPlugin = {
  name: 'NodeName',
  filter(_state, pod, node) {
    const want = str(specOf(pod).nodeName);
    return want === '' || want === node.name ? SUCCESS : status('UnschedulableAndUnresolvable', ERR_REASON_NODE_NAME);
  },
};

export const taintToleration: FilterPlugin = {
  name: 'TaintToleration',
  filter(_state, pod, node) {
    const t = findUntoleratedTaint(taintsOf(node.node), tolerationsOf(pod));
    return t ? status('UnschedulableAndUnresolvable', ERR_REASON_UNTOLERATED_TAINT) : SUCCESS;
  },
};

export const nodeAffinity: FilterPlugin = {
  name: 'NodeAffinity',
  preFilter(_state, pod) {
    const terms = requiredNodeAffinityTerms(pod);
    const ns = specOf(pod).nodeSelector;
    // nil versus empty: an empty nodeSelector map is not nil in Go, but the API server drops it.
    if (terms === undefined && !isObject(ns)) return { status: status('Skip') };
    if (terms === undefined || terms.length === 0) return { status: SUCCESS };
    let names: Set<string> | undefined;
    for (const t of terms) {
      let termNames: Set<string> | undefined;
      for (const r of arr(t.matchFields)) {
        if (str(r.key) !== 'metadata.name' || str(r.operator) !== 'In') continue;
        const s = new Set((Array.isArray(r.values) ? r.values : []).filter((v): v is string => typeof v === 'string'));
        termNames = termNames === undefined ? s : new Set([...termNames].filter((x) => s.has(x)));
      }
      // A term without a metadata.name requirement leaves every node eligible: terms are ORed.
      if (termNames === undefined) return { status: SUCCESS };
      names = new Set([...(names ?? []), ...termNames]);
    }
    if (names !== undefined && names.size === 0) return { status: status('UnschedulableAndUnresolvable', ERR_REASON_AFFINITY_CONFLICT) };
    if (names !== undefined && names.size > 0) return { status: SUCCESS, result: { nodeNames: [...names] } };
    return { status: SUCCESS };
  },
  filter(_state, pod, node) {
    return matchesRequiredNodeAffinity(pod, node.node) ? SUCCESS : status('UnschedulableAndUnresolvable', ERR_REASON_NODE_AFFINITY);
  },
};

/** upstream: HostPortInfo.CheckConflict. */
export function portConflict(used: HostPort[], want: HostPort): boolean {
  if (want.port <= 0) return false;
  const same = (u: HostPort) => u.protocol === want.protocol && u.port === want.port;
  if (want.ip === '0.0.0.0') return used.some(same);
  return used.some((u) => same(u) && (u.ip === '0.0.0.0' || u.ip === want.ip));
}

const PORTS_KEY = 'PreFilterNodePorts';

export const nodePorts: FilterPlugin = {
  name: 'NodePorts',
  preFilter(state, pod) {
    const ports = hostPorts(pod);
    if (ports.length === 0) return { status: status('Skip') };
    state[PORTS_KEY] = ports;
    return { status: SUCCESS };
  },
  filter(state, _pod, node) {
    const want = (state[PORTS_KEY] ?? []) as HostPort[];
    return want.some((p) => portConflict(node.usedPorts, p)) ? status('Unschedulable', ERR_REASON_NODE_PORTS) : SUCCESS;
  },
};

const FIT_KEY = 'PreFilterNodeResourcesFit';

/** Resource names fitsRequest checks as scalar resources: everything but the native four. */
const NATIVE = new Set(['cpu', 'memory', 'ephemeral-storage', 'pods']);

export interface InsufficientResource {
  resourceName: string;
  reason: string;
  requested: number;
  used: number;
  capacity: number;
  unresolvable: boolean;
}

/** upstream: fitsRequest (scalar resources are visited in Go map order; the message sorts reasons anyway). */
export function fitsRequest(req: ResourceList, node: NodeInfo): InsufficientResource[] {
  const out: InsufficientResource[] = [];
  const alloc = node.allocatable;
  const used = node.requested;
  const allowedPods = alloc.pods ?? 0;
  if (node.pods.length + 1 > allowedPods) {
    out.push({ resourceName: 'pods', reason: 'Too many pods', requested: 1, used: node.pods.length, capacity: allowedPods, unresolvable: false });
  }
  const cpu = req.cpu ?? 0;
  const memory = req.memory ?? 0;
  const eph = req['ephemeral-storage'] ?? 0;
  const scalars = Object.keys(req).filter((k) => !NATIVE.has(k) && (req[k] as number) !== 0).sort();
  if (cpu === 0 && memory === 0 && eph === 0 && scalars.length === 0) return out;
  const check = (name: string, reason: string, r: number): void => {
    const a = alloc[name] ?? 0;
    const u = used[name] ?? 0;
    if (r > 0 && r > a - u) out.push({ resourceName: name, reason, requested: r, used: u, capacity: a, unresolvable: r > a });
  };
  check('cpu', 'Insufficient cpu', cpu);
  check('memory', 'Insufficient memory', memory);
  check('ephemeral-storage', 'Insufficient ephemeral-storage', eph);
  for (const name of scalars) check(name, `Insufficient ${name}`, req[name] as number);
  return out;
}

export const nodeResourcesFit: FilterPlugin = {
  name: 'NodeResourcesFit',
  preFilter(state, pod) {
    state[FIT_KEY] = podRequests(pod);
    return { status: SUCCESS };
  },
  filter(state, pod, node): Status {
    const req = (state[FIT_KEY] as ResourceList | undefined) ?? podRequests(pod);
    const insufficient = fitsRequest(req, node);
    if (insufficient.length === 0) return SUCCESS;
    const code = insufficient.some((i) => i.unresolvable) ? 'UnschedulableAndUnresolvable' : 'Unschedulable';
    return status(code, ...insufficient.map((i) => i.reason));
  },
};

/** The filters in the default profile's order (default_plugins.go). */
export const FILTERS: readonly FilterPlugin[] = [nodeUnschedulable, nodeName, taintToleration, nodeAffinity, nodePorts, nodeResourcesFit];

export type { CycleState, ApiObject };
