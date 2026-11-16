// Printers of the core group's kinds other than Pod.
// upstream: pkg/printers/internalversion/printers.go printNode (getNodeInternalIP,
// getNodeExternalIP, findNodeRoles), printNamespace, printConfigMap, printSecret,
// printServiceAccount, printEvent, printEndpoints (formatEndpoints), printService
// (getServiceExternalIP, loadBalancerStatusStringer, makePortString).

import type { Json, JsonObject } from '../apimachinery/json.ts';
import { compareGoStrings, formatLabels } from '../apimachinery/labels.ts';
import { translateTimestampSince } from './duration.ts';
import { age, bool, formatEventSource, lower, nameOf, num, obj, objs, row, str, strMap, strs, type GenerateOptions } from './helpers.ts';
import type { TableRow } from './types.ts';

// upstream: printers.go constants labelNodeRolePrefix, nodeLabelRole, loadBalancerWidth.
const LABEL_NODE_ROLE_PREFIX = 'node-role.kubernetes.io/';
const NODE_LABEL_ROLE = 'kubernetes.io/role';
const LOAD_BALANCER_WIDTH = 16;

/** sets.String.List(): unique, sorted. */
const sortedSet = (xs: string[]): string[] => [...new Set(xs)].sort(compareGoStrings);

export function printNode(node: JsonObject, o: GenerateOptions): TableRow[] {
  const status = obj(node.status);
  const spec = obj(node.spec);
  const info = obj(status.nodeInfo);
  // conditionMap: the last condition of each type wins; only Ready is reported.
  let ready: JsonObject | undefined;
  for (const c of objs(status.conditions)) if (c.type === 'Ready') ready = c;
  const st: string[] = [];
  if (ready !== undefined) st.push(ready.status === 'True' ? 'Ready' : 'NotReady');
  if (st.length === 0) st.push('Unknown');
  if (bool(spec.unschedulable)) st.push('SchedulingDisabled');

  const roles = findNodeRoles(node).join(',') || '<none>';
  const cells: Json[] = [nameOf(node), st.join(','), roles, age(node, o), str(info.kubeletVersion)];
  if (o.wide) {
    const osImage = str(info.osImage) || '<unknown>';
    let kernelVersion = str(info.kernelVersion) || '<unknown>';
    const crVersion = str(info.containerRuntimeVersion) || '<unknown>';
    if (str(info.architecture) !== '') kernelVersion += ` (${str(info.architecture)})`;
    cells.push(nodeAddress(node, 'InternalIP'), nodeAddress(node, 'ExternalIP'), osImage, kernelVersion, crVersion);
  }
  return [row(node, cells)];
}

/** getNodeInternalIP / getNodeExternalIP: the first address of the type, or `<none>`. */
function nodeAddress(node: JsonObject, type: string): string {
  const a = objs(obj(node.status).addresses).find((x) => x.type === type);
  return a === undefined ? '<none>' : str(a.address);
}

/** findNodeRoles: `node-role.kubernetes.io/<role>` label keys and the `kubernetes.io/role` value. */
export function findNodeRoles(node: JsonObject): string[] {
  const roles: string[] = [];
  for (const [k, v] of Object.entries(strMap(obj(node.metadata).labels))) {
    if (k.startsWith(LABEL_NODE_ROLE_PREFIX)) {
      const role = k.slice(LABEL_NODE_ROLE_PREFIX.length);
      if (role.length > 0) roles.push(role);
    } else if (k === NODE_LABEL_ROLE && v !== '') roles.push(v);
  }
  return sortedSet(roles);
}

export function printNamespace(ns: JsonObject, o: GenerateOptions): TableRow[] {
  return [row(ns, [nameOf(ns), str(obj(ns.status).phase), age(ns, o)])];
}

export function printConfigMap(cm: JsonObject, o: GenerateOptions): TableRow[] {
  return [row(cm, [nameOf(cm), Object.keys(obj(cm.data)).length + Object.keys(obj(cm.binaryData)).length, age(cm, o)])];
}

export function printSecret(secret: JsonObject, o: GenerateOptions): TableRow[] {
  return [row(secret, [nameOf(secret), str(secret.type), Object.keys(obj(secret.data)).length, age(secret, o)])];
}

export function printServiceAccount(sa: JsonObject, o: GenerateOptions): TableRow[] {
  return [row(sa, [nameOf(sa), age(sa, o)])];
}

export function printEvent(ev: JsonObject, o: GenerateOptions): TableRow[] {
  const zero = (v: Json | undefined) => translateTimestampSince(v, o.now) === '<unknown>';
  let firstTimestamp = translateTimestampSince(ev.firstTimestamp, o.now);
  if (zero(ev.firstTimestamp)) firstTimestamp = translateTimestampSince(ev.eventTime, o.now);
  let lastTimestamp = translateTimestampSince(ev.lastTimestamp, o.now);
  if (zero(ev.lastTimestamp)) lastTimestamp = firstTimestamp;

  let count = num(ev.count);
  if (ev.series !== undefined && ev.series !== null) {
    const series = obj(ev.series);
    lastTimestamp = translateTimestampSince(series.lastObservedTime, o.now);
    count = num(series.count);
  } else if (count === 0) {
    // Singleton events don't have a count set in the new API.
    count = 1;
  }

  const involved = obj(ev.involvedObject);
  const target = str(involved.name).length > 0 ? `${lower(str(involved.kind))}/${str(involved.name)}` : lower(str(involved.kind));
  const message = str(ev.message).trim();
  const cells: Json[] = o.wide
    ? [lastTimestamp, str(ev.type), str(ev.reason), target, str(involved.fieldPath), formatEventSource(obj(ev.source), str(ev.reportingComponent), str(ev.reportingInstance)), message, firstTimestamp, count, nameOf(ev)]
    : [lastTimestamp, str(ev.type), str(ev.reason), target, message];
  return [row(ev, cells)];
}

/** net.JoinHostPort. */
const joinHostPort = (host: string, port: number): string => (host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`);

/** formatEndpoints with ports=nil: up to three host:port pairs, then "+ N more...". */
export function formatEndpoints(ep: JsonObject): string {
  const subsets = objs(ep.subsets);
  if (subsets.length === 0) return '<none>';
  const list: string[] = [];
  const max = 3;
  let more = false;
  let count = 0;
  for (const ss of subsets) {
    const addresses = objs(ss.addresses);
    const ports = objs(ss.ports);
    if (ports.length === 0) {
      // Headless services with no ports.
      count += addresses.length;
      for (const a of addresses) {
        if (list.length === max) {
          more = true;
          break;
        }
        list.push(str(a.ip));
      }
      continue;
    }
    for (const port of ports) {
      count += addresses.length;
      for (const a of addresses) {
        if (list.length === max) {
          more = true;
          break;
        }
        list.push(joinHostPort(str(a.ip), num(port.port)));
      }
    }
  }
  const ret = list.join(',');
  return more ? `${ret} + ${count - max} more...` : ret;
}

export function printEndpoints(ep: JsonObject, o: GenerateOptions): TableRow[] {
  return [row(ep, [nameOf(ep), formatEndpoints(ep), age(ep, o)])];
}

/** loadBalancerStatusStringer: ingress IPs or host names, sorted, cut to 16 characters unless wide. */
function loadBalancerStatusStringer(lb: JsonObject, wide: boolean): string {
  const result: string[] = [];
  for (const ing of objs(lb.ingress)) {
    if (str(ing.ip) !== '') result.push(str(ing.ip));
    else if (str(ing.hostname) !== '') result.push(str(ing.hostname));
  }
  let r = sortedSet(result).join(',');
  if (!wide && r.length > LOAD_BALANCER_WIDTH) r = `${r.slice(0, LOAD_BALANCER_WIDTH - 3)}...`;
  return r;
}

function getServiceExternalIP(svc: JsonObject, wide: boolean): string {
  const spec = obj(svc.spec);
  const externalIPs = strs(spec.externalIPs);
  switch (str(spec.type)) {
    case 'ClusterIP':
    case 'NodePort':
      return externalIPs.length > 0 ? externalIPs.join(',') : '<none>';
    case 'LoadBalancer': {
      const lbIps = loadBalancerStatusStringer(obj(obj(svc.status).loadBalancer), wide);
      if (externalIPs.length > 0) return [...(lbIps.length > 0 ? lbIps.split(',') : []), ...externalIPs].join(',');
      return lbIps.length > 0 ? lbIps : '<pending>';
    }
    case 'ExternalName':
      return str(spec.externalName);
  }
  return '<unknown>';
}

/** makePortString: port/protocol, or port:nodePort/protocol. */
export function makePortString(ports: JsonObject[]): string {
  return ports.map((p) => (num(p.nodePort) > 0 ? `${num(p.port)}:${num(p.nodePort)}/${str(p.protocol)}` : `${num(p.port)}/${str(p.protocol)}`)).join(',');
}

export function printService(svc: JsonObject, o: GenerateOptions): TableRow[] {
  const spec = obj(svc.spec);
  const clusterIPs = strs(spec.clusterIPs);
  const internalIP = clusterIPs.length > 0 ? (clusterIPs[0] as string) : '<none>';
  const externalIP = getServiceExternalIP(svc, o.wide);
  const svcPorts = makePortString(objs(spec.ports)) || '<none>';
  const cells: Json[] = [nameOf(svc), str(spec.type), internalIP, externalIP, svcPorts, age(svc, o)];
  if (o.wide) cells.push(formatLabels(strMap(spec.selector)));
  return [row(svc, cells)];
}
