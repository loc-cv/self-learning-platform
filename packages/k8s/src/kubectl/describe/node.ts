// describe node.
//   upstream: staging/src/k8s.io/kubectl/pkg/describe/describe.go describeNode, findNodeRoles
//             (node-role.kubernetes.io/<role> labels and kubernetes.io/role), describeNodeLease,
//             describeNodeResource, getPodsTotalRequestsAndLimits, describeNodeResourceSlices (not
//             reached: the simulator stores no ResourceSlices), DescribeEvents
//   upstream: staging/src/k8s.io/kubectl/pkg/util/resource/resource.go IsHugePageResourceName,
//             IsStandardContainerResourceName
//   The percentages are int64(float64(a) / float64(b) * 100): truncated toward zero; Go converts a
//   non-finite float to the most negative int64 on amd64.

import type { Millis } from '@simlab/kernel';
import type { Json, JsonObject } from '../../apimachinery/json.ts';
import { compareGoStrings } from '../../apimachinery/labels.ts';
import { addQuantities as addQ, milliValue, quantityString, value, type Quantity } from '../../apimachinery/quantity.ts';
import { describeEvents, goSorted, meta, obj, objs, printAnnotationsMultiline, printLabelsMultiline, printNodeTaintsMultiline, strMap, translateSince } from './common.ts';
import { podLimits, podRequests, resourceList, ZERO, type ResourceList } from './resources.ts';
import { b, LEVEL_0, LEVEL_1, rfc1123z, s, tabbedString, type PrefixWriter } from './writer.ts';

const ROLE_PREFIX = 'node-role.kubernetes.io/';
const ROLE_LABEL = 'kubernetes.io/role';

function findNodeRoles(node: JsonObject): string[] {
  const roles = new Set<string>();
  for (const [k, v] of Object.entries(strMap(meta(node).labels))) {
    if (k.startsWith(ROLE_PREFIX)) {
      const role = k.slice(ROLE_PREFIX.length);
      if (role !== '') roles.add(role);
    } else if (k === ROLE_LABEL && v !== '') roles.add(v);
  }
  return goSorted([...roles]);
}

/** What the node Lease GET answered: the Lease, or the error's text. */
export type LeaseResult = { lease: JsonObject } | { error: string };

function describeNodeLease(lease: JsonObject, w: PrefixWriter): void {
  const spec = obj(lease.spec);
  w.write(LEVEL_0, 'Lease:\n');
  w.write(LEVEL_1, `HolderIdentity:\t${typeof spec.holderIdentity === 'string' ? spec.holderIdentity : '<unset>'}\n`);
  w.write(LEVEL_1, `AcquireTime:\t${typeof spec.acquireTime === 'string' ? rfc1123z(spec.acquireTime) : '<unset>'}\n`);
  w.write(LEVEL_1, `RenewTime:\t${typeof spec.renewTime === 'string' ? rfc1123z(spec.renewTime) : '<unset>'}\n`);
}

/** int64(float64(a) / float64(b) * 100) */
function percent(a: number, b: number): string {
  const f = (a / b) * 100;
  return Number.isFinite(f) ? String(Math.trunc(f) + 0) : '-9223372036854775808';
}

const q = (list: ResourceList | undefined, name: string): Quantity => list?.[name] ?? ZERO;
const qs = (x: Quantity): string => quantityString(x);

function describeNodeResource(pods: JsonObject[], node: JsonObject, w: PrefixWriter, now: Millis): void {
  w.write(LEVEL_0, `Non-terminated Pods:\t(${pods.length} in total)\n`);
  w.write(LEVEL_1, 'Namespace\tName\t\tCPU Requests\tCPU Limits\tMemory Requests\tMemory Limits\tAge\n');
  w.write(LEVEL_1, '---------\t----\t\t------------\t----------\t---------------\t-------------\t---\n');
  const status = obj(node.status);
  const allocJson: Json | undefined = Object.keys(obj(status.allocatable)).length > 0 ? status.allocatable : status.capacity;
  const allocatable = resourceList(allocJson) ?? {};
  const allocCpu = milliValue(q(allocatable, 'cpu'));
  const allocMem = value(q(allocatable, 'memory'));
  for (const pod of pods) {
    const req = podRequests(pod, true);
    const limit = podLimits(pod, true);
    const [cpuReq, cpuLimit, memReq, memLimit] = [q(req, 'cpu'), q(limit, 'cpu'), q(req, 'memory'), q(limit, 'memory')];
    w.write(
      LEVEL_1,
      `${s(meta(pod).namespace)}\t${s(meta(pod).name)}\t\t${qs(cpuReq)} (${percent(milliValue(cpuReq), allocCpu)}%)\t${qs(cpuLimit)} (${percent(milliValue(cpuLimit), allocCpu)}%)\t${qs(memReq)} (${percent(value(memReq), allocMem)}%)\t${qs(memLimit)} (${percent(value(memLimit), allocMem)}%)\t${translateSince(meta(pod).creationTimestamp, now)}\n`,
    );
  }
  w.write(LEVEL_0, 'Allocated resources:\n  (Total limits may be over 100 percent, i.e., overcommitted.)\n');
  w.write(LEVEL_1, 'Resource\tRequests\tLimits\n');
  w.write(LEVEL_1, '--------\t--------\t------\n');
  // getPodsTotalRequestsAndLimits: spec resources only
  const reqs: ResourceList = {};
  const limits: ResourceList = {};
  const add = (into: ResourceList, l: ResourceList) => {
    for (const [name, x] of Object.entries(l)) into[name] = name in into ? addQ(into[name] as Quantity, x) : x;
  };
  for (const pod of pods) {
    add(reqs, podRequests(pod, false));
    add(limits, podLimits(pod, false));
  }
  const frac = (x: Quantity, alloc: number, unit: (y: Quantity) => number) => (alloc !== 0 ? percent(unit(x), alloc) : '0');
  const row = (name: string, unit: (y: Quantity) => number, alloc: number) =>
    w.write(LEVEL_1, `${name}\t${qs(q(reqs, name))} (${frac(q(reqs, name), alloc, unit)}%)\t${qs(q(limits, name))} (${frac(q(limits, name), alloc, unit)}%)\n`);
  row('cpu', milliValue, allocCpu);
  row('memory', value, allocMem);
  row('ephemeral-storage', value, value(q(allocatable, 'ephemeral-storage')));
  const ext: string[] = [];
  const huge: string[] = [];
  for (const name of Object.keys(allocatable)) {
    if (name.startsWith('hugepages-')) huge.push(name);
    else if (!['cpu', 'memory', 'ephemeral-storage'].includes(name) && name !== 'pods') ext.push(name);
  }
  for (const name of huge.sort(compareGoStrings)) row(name, value, value(q(allocatable, name)));
  for (const name of ext.sort(compareGoStrings)) w.write(LEVEL_1, `${name}\t${qs(q(reqs, name))}\t${qs(q(limits, name))}\n`);
}

/** describeNode; `pods` is the Node's non-terminated Pods. */
export function describeNode(node: JsonObject, pods: JsonObject[], events: JsonObject[] | undefined, lease: LeaseResult, now: Millis): string {
  const m = meta(node);
  const spec = obj(node.spec);
  const status = obj(node.status);
  return tabbedString((w) => {
    w.write(LEVEL_0, `Name:\t${s(m.name)}\n`);
    const roles = findNodeRoles(node);
    w.write(LEVEL_0, `Roles:\t${roles.length > 0 ? roles.join(',') : '<none>'}\n`);
    printLabelsMultiline(w, 'Labels', m.labels);
    printAnnotationsMultiline(w, 'Annotations', m.annotations);
    w.write(LEVEL_0, `CreationTimestamp:\t${rfc1123z(m.creationTimestamp)}\n`);
    printNodeTaintsMultiline(w, 'Taints', spec.taints);
    w.write(LEVEL_0, `Unschedulable:\t${b(spec.unschedulable)}\n`);
    if ('lease' in lease) describeNodeLease(lease.lease, w);
    else w.write(LEVEL_0, `Lease:\tFailed to get lease: ${lease.error}\n`);
    const conditions = objs(status.conditions);
    if (conditions.length > 0) {
      w.write(LEVEL_0, 'Conditions:\n  Type\tStatus\tLastHeartbeatTime\tLastTransitionTime\tReason\tMessage\n');
      w.write(LEVEL_1, '----\t------\t-----------------\t------------------\t------\t-------\n');
      for (const c of conditions) {
        w.write(LEVEL_1, `${s(c.type)} \t${s(c.status)} \t${rfc1123z(c.lastHeartbeatTime)} \t${rfc1123z(c.lastTransitionTime)} \t${s(c.reason)} \t${s(c.message)}\n`);
      }
    }
    w.write(LEVEL_0, 'Addresses:\n');
    for (const a of objs(status.addresses)) w.write(LEVEL_1, `${s(a.type)}:\t${s(a.address)}\n`);
    const printResourceList = (list: Json | undefined) => {
      const l = resourceList(list) ?? {};
      for (const name of goSorted(Object.keys(l))) w.write(LEVEL_0, `  ${name}:\t${qs(l[name] as Quantity)}\n`);
    };
    if (Object.keys(obj(status.capacity)).length > 0) {
      w.write(LEVEL_0, 'Capacity:\n');
      printResourceList(status.capacity);
    }
    if (Object.keys(obj(status.allocatable)).length > 0) {
      w.write(LEVEL_0, 'Allocatable:\n');
      printResourceList(status.allocatable);
    }
    const info = obj(status.nodeInfo);
    w.write(LEVEL_0, 'System Info:\n');
    w.write(LEVEL_0, `  Machine ID:\t${s(info.machineID)}\n`);
    w.write(LEVEL_0, `  System UUID:\t${s(info.systemUUID)}\n`);
    w.write(LEVEL_0, `  Boot ID:\t${s(info.bootID)}\n`);
    w.write(LEVEL_0, `  Kernel Version:\t${s(info.kernelVersion)}\n`);
    w.write(LEVEL_0, `  OS Image:\t${s(info.osImage)}\n`);
    w.write(LEVEL_0, `  Operating System:\t${s(info.operatingSystem)}\n`);
    w.write(LEVEL_0, `  Architecture:\t${s(info.architecture)}\n`);
    w.write(LEVEL_0, `  Container Runtime Version:\t${s(info.containerRuntimeVersion)}\n`);
    w.write(LEVEL_0, `  Kubelet Version:\t${s(info.kubeletVersion)}\n`);
    if (s(spec.podCIDR) !== '') w.write(LEVEL_0, `PodCIDR:\t${s(spec.podCIDR)}\n`);
    const cidrs = Array.isArray(spec.podCIDRs) ? spec.podCIDRs.map((x) => (typeof x === 'string' ? x : '')) : [];
    if (cidrs.length > 0) w.write(LEVEL_0, `PodCIDRs:\t${cidrs.join(',')}\n`);
    if (s(spec.providerID) !== '') w.write(LEVEL_0, `ProviderID:\t${s(spec.providerID)}\n`);
    describeNodeResource(pods, node, w, now);
    if (events) describeEvents(events, w, now);
  });
}
