// describe pod, and the parts of it the workload describers reuse (containers, volumes, the Pod
// template).
//   upstream: staging/src/k8s.io/kubectl/pkg/describe/describe.go describePod, printController,
//             describePodIPs, describeTopologySpreadConstraints, describeVolumes and the
//             print*VolumeSource functions it calls, describeSchedulingGroup, describeContainers,
//             describeContainersLabel, describeContainerBasicInfo, describeContainerPorts,
//             describeContainerHostPorts, describeContainerCommand, describeResources,
//             describeContainerState, describeContainerProbe, describeContainerVolumes
//             (SortableVolumeMounts, SortableVolumeDevices), describeContainerEnvVars,
//             describeContainerEnvFrom, DescribeProbe, EnvValueRetriever, describeStatus,
//             DescribePodTemplate
//   upstream: staging/src/k8s.io/kubectl/pkg/util/qos/qos.go GetPodQOS (the API server's
//             status.qosClass first)
//   upstream: staging/src/k8s.io/kubectl/pkg/util/resource/resource.go ExtractContainerResourceValue,
//             convertResource*ToString (ceil of value / divisor)
//   upstream: staging/src/k8s.io/apimachinery/pkg/runtime/conversion.go
//             DefaultMetaV1FieldSelectorConversion: kubectl's scheme registers no field label
//             conversions for Pods, so a fieldRef env value resolves only for metadata.name and
//             metadata.namespace (EnvValueRetriever returns "" for anything else)
//   upstream: Go src/net/url/url.go URL.String, EscapedPath (encodePath); src/net/ipsock.go
//             JoinHostPort

import type { Millis } from '@simlab/kernel';
import { isObject, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { compareGoStrings, formatLabelSelector } from '../../apimachinery/labels.ts';
import { milliValue, parseQuantity, quantityString, value, type Quantity } from '../../apimachinery/quantity.ts';
import { getPodQOS } from '../../apis/core/helper/qos.ts';
import { sortBy } from '../../controllers/controller_utils.ts';
import { describeEvents, meta, obj, objs, strMap, printAnnotationsMultiline, printLabelsMultiline, printPodTolerationsMultiline, sortedResourceNames, translateSince } from './common.ts';
import { notSimulated } from './errors.ts';
import { b, byteLength, byteSlice, d, LEVEL_0, LEVEL_1, LEVEL_2, LEVEL_3, printBool, rfc1123z, s, stringOrNone, tabbedString, utf8Encode, type PrefixWriter } from './writer.ts';

/** describePod */
export function describePod(pod: JsonObject, events: JsonObject[] | undefined, now: Millis): string {
  const m = meta(pod);
  const spec = obj(pod.spec);
  const status = obj(pod.status);
  return tabbedString((w) => {
    w.write(LEVEL_0, `Name:\t${s(m.name)}\n`);
    w.write(LEVEL_0, `Namespace:\t${s(m.namespace)}\n`);
    if (typeof spec.priority === 'number') w.write(LEVEL_0, `Priority:\t${spec.priority}\n`);
    if (s(spec.priorityClassName) !== '') w.write(LEVEL_0, `Priority Class Name:\t${s(spec.priorityClassName)}\n`);
    if (s(spec.runtimeClassName) !== '') w.write(LEVEL_0, `Runtime Class Name:\t${s(spec.runtimeClassName)}\n`);
    if (s(spec.serviceAccountName) !== '') w.write(LEVEL_0, `Service Account:\t${s(spec.serviceAccountName)}\n`);
    if (s(spec.nodeName) === '') w.write(LEVEL_0, 'Node:\t<none>\n');
    else w.write(LEVEL_0, `Node:\t${s(spec.nodeName)}/${s(status.hostIP)}\n`);
    if (typeof status.startTime === 'string') w.write(LEVEL_0, `Start Time:\t${rfc1123z(status.startTime)}\n`);
    printLabelsMultiline(w, 'Labels', m.labels);
    printAnnotationsMultiline(w, 'Annotations', m.annotations);
    if (typeof m.deletionTimestamp === 'string' && status.phase !== 'Failed' && status.phase !== 'Succeeded') {
      w.write(LEVEL_0, `Status:\tTerminating (lasts ${translateSince(m.deletionTimestamp, now)})\n`);
      w.write(LEVEL_0, `Termination Grace Period:\t${d(m.deletionGracePeriodSeconds)}s\n`);
    } else {
      w.write(LEVEL_0, `Status:\t${s(status.phase)}\n`);
    }
    if (s(status.reason) !== '') w.write(LEVEL_0, `Reason:\t${s(status.reason)}\n`);
    if (s(status.message) !== '') w.write(LEVEL_0, `Message:\t${s(status.message)}\n`);
    const seccomp = obj(obj(spec.securityContext).seccompProfile);
    if (isObject(obj(spec.securityContext).seccompProfile)) {
      w.write(LEVEL_0, `SeccompProfile:\t${s(seccomp.type)}\n`);
      if (seccomp.type === 'Localhost') w.write(LEVEL_0, `LocalhostProfile:\t${s(seccomp.localhostProfile)}\n`);
    }
    w.write(LEVEL_0, `IP:\t${s(status.podIP)}\n`);
    describePodIPs(status, w, '');
    const controlledBy = printController(pod);
    if (controlledBy !== '') w.write(LEVEL_0, `Controlled By:\t${controlledBy}\n`);
    if (s(status.nominatedNodeName) !== '') w.write(LEVEL_0, `NominatedNodeName:\t${s(status.nominatedNodeName)}\n`);
    if (isObject(spec.resources)) {
      w.write(LEVEL_0, 'Resources:\n');
      describeResources(spec.resources, w, LEVEL_1);
    }
    if (objs(spec.initContainers).length > 0) describeContainers('Init Containers', objs(spec.initContainers), objs(status.initContainerStatuses), pod, w, '');
    describeContainers('Containers', objs(spec.containers), objs(status.containerStatuses), pod, w, '');
    if (objs(spec.ephemeralContainers).length > 0) describeContainers('Ephemeral Containers', objs(spec.ephemeralContainers), objs(status.ephemeralContainerStatuses), pod, w, '');
    const conditions = objs(status.conditions);
    const gates = objs(spec.readinessGates);
    if (gates.length > 0) {
      w.write(LEVEL_0, 'Readiness Gates:\n  Type\tStatus\n');
      for (const g of gates) {
        const c = conditions.find((x) => x.type === g.conditionType);
        w.write(LEVEL_1, `${s(g.conditionType)} \t${c ? s(c.status) : '<none>'} \n`);
      }
    }
    if (conditions.length > 0) {
      w.write(LEVEL_0, 'Conditions:\n  Type\tStatus\n');
      for (const c of conditions) w.write(LEVEL_1, `${s(c.type)} \t${s(c.status)} \n`);
    }
    describeVolumes(objs(spec.volumes), w, '');
    w.write(LEVEL_0, `QoS Class:\t${getPodQOS(pod)}\n`);
    printLabelsMultiline(w, 'Node-Selectors', spec.nodeSelector);
    printPodTolerationsMultiline(w, 'Tolerations', spec.tolerations);
    describeTopologySpreadConstraints(objs(spec.topologySpreadConstraints), w, '');
    if (isObject(spec.schedulingGroup)) describeSchedulingGroup(spec.schedulingGroup, w, '');
    if (events) describeEvents(events, w, now);
  });
}

/** printController: `<Kind>/<name>` of the controller owner reference. */
export function printController(o: JsonObject): string {
  const ref = objs(meta(o).ownerReferences).find((r) => r.controller === true);
  return ref ? `${s(ref.kind)}/${s(ref.name)}` : '';
}

function describePodIPs(status: JsonObject, w: PrefixWriter, space: string): void {
  const ips = objs(status.podIPs);
  if (ips.length === 0) {
    w.write(LEVEL_0, `${space}IPs:\t<none>\n`);
    return;
  }
  w.write(LEVEL_0, `${space}IPs:\n`);
  for (const ip of ips) w.write(LEVEL_1, `IP:\t${s(ip.ip)}\n`);
}

function describeTopologySpreadConstraints(tscs: JsonObject[], w: PrefixWriter, space: string): void {
  if (tscs.length === 0) return;
  const sorted = sortBy([...tscs], (a, c) => compareGoStrings(s(a.topologyKey), s(c.topologyKey)) < 0);
  w.write(LEVEL_0, `${space}Topology Spread Constraints:\t`);
  sorted.forEach((tsc, i) => {
    if (i !== 0) {
      w.write(LEVEL_0, space);
      w.write(LEVEL_0, '\t');
    }
    w.write(LEVEL_0, `${s(tsc.topologyKey)}:`);
    w.write(LEVEL_0, s(tsc.whenUnsatisfiable));
    w.write(LEVEL_0, ` when max skew ${d(tsc.maxSkew)} is exceeded`);
    if (isObject(tsc.labelSelector)) w.write(LEVEL_0, ` for selector ${formatLabelSelector(tsc.labelSelector)}`);
    w.write(LEVEL_0, '\n');
  });
}

function describeSchedulingGroup(group: JsonObject, w: PrefixWriter, space: string): void {
  w.write(LEVEL_0, `${space}SchedulingGroup:\n`);
  w.write(LEVEL_1, `PodGroupName:\t${s(group.podGroupName)}\n`);
}

const optional = (v: Json | undefined): string => (isObject(v) && v.optional === true ? 'true' : 'false');

/** describeVolumes: the volume sources the simulator's Pods can use; others print a notice. */
export function describeVolumes(volumes: JsonObject[], w: PrefixWriter, space: string): void {
  if (volumes.length === 0) {
    w.write(LEVEL_0, `${space}Volumes:\t<none>\n`);
    return;
  }
  w.write(LEVEL_0, `${space}Volumes:\n`);
  for (const v of volumes) {
    w.write(LEVEL_1, `${space !== '' ? ' ' : ''}${s(v.name)}:\n`);
    if (isObject(v.hostPath)) {
      const hp = v.hostPath;
      w.write(LEVEL_2, `Type:\tHostPath (bare host directory volume)\n    Path:\t${s(hp.path)}\n    HostPathType:\t${typeof hp.type === 'string' ? hp.type : '<none>'}\n`);
    } else if (isObject(v.emptyDir)) {
      const ed = v.emptyDir;
      const limit = typeof ed.sizeLimit === 'string' ? parseQuantity(ed.sizeLimit) : undefined;
      const sizeLimit = limit && !('error' in limit) && limit.unscaled > 0n ? quantityString(limit) : '<unset>';
      w.write(LEVEL_2, `Type:\tEmptyDir (a temporary directory that shares a pod's lifetime)\n    Medium:\t${s(ed.medium)}\n    SizeLimit:\t${sizeLimit}\n`);
    } else if (isObject(v.gitRepo)) {
      w.write(LEVEL_2, `Type:\tGitRepo (a volume that is pulled from git when the pod is created)\n    Repository:\t${s(v.gitRepo.repository)}\n    Revision:\t${s(v.gitRepo.revision)}\n`);
    } else if (isObject(v.secret)) {
      w.write(LEVEL_2, `Type:\tSecret (a volume populated by a Secret)\n    SecretName:\t${s(v.secret.secretName)}\n    Optional:\t${optional(v.secret)}\n`);
    } else if (isObject(v.configMap)) {
      w.write(LEVEL_2, `Type:\tConfigMap (a volume populated by a ConfigMap)\n    Name:\t${s(v.configMap.name)}\n    Optional:\t${optional(v.configMap)}\n`);
    } else if (isObject(v.nfs)) {
      w.write(LEVEL_2, `Type:\tNFS (an NFS mount that lasts the lifetime of a pod)\n    Server:\t${s(v.nfs.server)}\n    Path:\t${s(v.nfs.path)}\n    ReadOnly:\t${b(v.nfs.readOnly)}\n`);
    } else if (isObject(v.persistentVolumeClaim)) {
      const c = v.persistentVolumeClaim;
      w.write(LEVEL_2, `Type:\tPersistentVolumeClaim (a reference to a PersistentVolumeClaim in the same namespace)\n    ClaimName:\t${s(c.claimName)}\n    ReadOnly:\t${b(c.readOnly)}\n`);
    } else if (isObject(v.downwardAPI)) {
      w.write(LEVEL_2, 'Type:\tDownwardAPI (a volume populated by information about the pod)\n    Items:\n');
      for (const item of objs(v.downwardAPI.items)) {
        if (isObject(item.fieldRef)) w.write(LEVEL_3, `${s(item.fieldRef.fieldPath)} -> ${s(item.path)}\n`);
        if (isObject(item.resourceFieldRef)) w.write(LEVEL_3, `${s(item.resourceFieldRef.resource)} -> ${s(item.path)}\n`);
      }
    } else if (isObject(v.projected)) {
      w.write(LEVEL_2, 'Type:\tProjected (a volume that contains injected data from multiple sources)\n');
      for (const src of objs(v.projected.sources)) {
        if (isObject(src.secret)) w.write(LEVEL_2, `SecretName:\t${s(src.secret.name)}\n    Optional:\t${optional(src.secret)}\n`);
        else if (isObject(src.downwardAPI)) w.write(LEVEL_2, 'DownwardAPI:\ttrue\n');
        else if (isObject(src.configMap)) w.write(LEVEL_2, `ConfigMapName:\t${s(src.configMap.name)}\n    Optional:\t${optional(src.configMap)}\n`);
        else if (isObject(src.serviceAccountToken)) w.write(LEVEL_2, `TokenExpirationSeconds:\t${d(src.serviceAccountToken.expirationSeconds)}\n`);
      }
    } else if (isObject(v.csi)) {
      const c = v.csi;
      w.write(LEVEL_2, `Type:\tCSI (a Container Storage Interface (CSI) volume source)\n    Driver:\t${s(c.driver)}\n    FSType:\t${s(c.fsType)}\n    ReadOnly:\t${b(c.readOnly)}\n`);
      printCSIAttributes(w, 'VolumeAttributes', c.volumeAttributes);
    } else if (isObject(v.image)) {
      w.write(LEVEL_2, `Type:\tImage (a container image or OCI artifact)\n    Reference:\t${s(v.image.reference)}\n    PullPolicy:\t${s(v.image.pullPolicy)}\n`);
    } else {
      const kind = Object.keys(v).find((k) => k !== 'name');
      notSimulated(`describing a ${kind ?? 'volume'} volume`);
    }
  }
}

/** printCSIPersistentVolumeAttributesMultilineIndent with no indent and nothing skipped. */
function printCSIAttributes(w: PrefixWriter, title: string, attributes: Json | undefined): void {
  w.write(LEVEL_2, `${title}:\t`);
  const m = strMap(attributes);
  const keys = Object.keys(m).sort(compareGoStrings);
  if (keys.length === 0) {
    w.writeLine('<none>');
    return;
  }
  keys.forEach((key, i) => {
    if (i !== 0) {
      w.write(LEVEL_2, '');
      w.write(LEVEL_2, '\t');
    }
    // len(line) > maxAnnotationLen cuts bytes
    const line = `${key}=${m[key] as string}`;
    w.write(LEVEL_2, byteLength(line) > 140 ? `${byteSlice(line, 140)}...\n` : `${line}\n`);
  });
}

// ---- containers ----

/** describeContainers; `pod` is undefined in a Pod template (no statuses, no env resolution). */
export function describeContainers(label: string, containers: JsonObject[], statuses: JsonObject[], pod: JsonObject | undefined, w: PrefixWriter, space: string): void {
  w.write(LEVEL_0, `${space}${label}:${containers.length === 0 ? ' <none>' : ''}\n`);
  for (const c of containers) {
    const status = statuses.find((x) => x.name === c.name);
    describeContainerBasicInfo(c, status, space, w);
    describeContainerCommand(c, w);
    if (status) describeContainerState(status, w);
    describeResources(c.resources, w, LEVEL_2);
    describeContainerProbe(c, w);
    if (objs(c.envFrom).length > 0) describeContainerEnvFrom(c, w);
    describeContainerEnvVars(c, pod, w);
    describeContainerVolumes(c, w);
  }
}

function describeContainerBasicInfo(c: JsonObject, status: JsonObject | undefined, space: string, w: PrefixWriter): void {
  w.write(LEVEL_1, `${space !== '' ? ' ' : ''}${s(c.name)}:\n`);
  if (status) w.write(LEVEL_2, `Container ID:\t${s(status.containerID)}\n`);
  w.write(LEVEL_2, `Image:\t${s(c.image)}\n`);
  if (status) w.write(LEVEL_2, `Image ID:\t${s(status.imageID)}\n`);
  const ports = objs(c.ports);
  const portString = ports.map((p) => `${d(p.containerPort)}/${s(p.protocol)}${s(p.name) !== '' ? ` (${s(p.name)})` : ''}`).join(', ');
  if (portString.includes(',')) w.write(LEVEL_2, `Ports:\t${portString}\n`);
  else w.write(LEVEL_2, `Port:\t${stringOrNone(portString)}\n`);
  const hostPortString = ports.map((p) => `${d(p.hostPort)}/${s(p.protocol)}${s(p.name) !== '' ? ` (${s(p.name)})` : ''}`).join(', ');
  if (hostPortString.includes(',')) w.write(LEVEL_2, `Host Ports:\t${hostPortString}\n`);
  else w.write(LEVEL_2, `Host Port:\t${stringOrNone(hostPortString)}\n`);
  const sc = obj(c.securityContext);
  if (isObject(sc.seccompProfile)) {
    w.write(LEVEL_2, `SeccompProfile:\t${s(sc.seccompProfile.type)}\n`);
    if (sc.seccompProfile.type === 'Localhost') w.write(LEVEL_3, `LocalhostProfile:\t${s(sc.seccompProfile.localhostProfile)}\n`);
  }
}

function describeContainerCommand(c: JsonObject, w: PrefixWriter): void {
  const lines = (v: Json | undefined) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : '')) : []);
  const command = lines(c.command);
  if (command.length > 0) {
    w.write(LEVEL_2, 'Command:\n');
    for (const x of command) for (const l of x.split('\n')) w.write(LEVEL_3, `${l}\n`);
  }
  const args = lines(c.args);
  if (args.length > 0) {
    w.write(LEVEL_2, 'Args:\n');
    for (const x of args) for (const l of x.split('\n')) w.write(LEVEL_3, `${l}\n`);
  }
}

/** describeResources: limits then requests, names in byte order. */
export function describeResources(resources: Json | undefined, w: PrefixWriter, level: number): void {
  if (!isObject(resources)) return;
  for (const kind of ['limits', 'requests'] as const) {
    const list = obj(resources[kind]);
    const names = sortedResourceNames(list);
    if (names.length > 0) w.write(level, kind === 'limits' ? 'Limits:\n' : 'Requests:\n');
    for (const name of names) w.write(level + 1, `${name}:\t${quantityText(list[name])}\n`);
  }
}

function quantityText(v: Json | undefined): string {
  const q = parseQuantity(typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '0');
  return 'error' in q ? s(v) : quantityString(q);
}

function describeContainerState(status: JsonObject, w: PrefixWriter): void {
  describeStatus('State', obj(status.state), w);
  if (isObject(obj(status.lastState).terminated)) describeStatus('Last State', obj(status.lastState), w);
  w.write(LEVEL_2, `Ready:\t${printBool(status.ready)}\n`);
  w.write(LEVEL_2, `Restart Count:\t${d(status.restartCount)}\n`);
}

function describeStatus(name: string, state: JsonObject, w: PrefixWriter): void {
  if (isObject(state.running)) {
    w.write(LEVEL_2, `${name}:\tRunning\n`);
    w.write(LEVEL_3, `Started:\t${rfc1123z(state.running.startedAt)}\n`);
  } else if (isObject(state.waiting)) {
    w.write(LEVEL_2, `${name}:\tWaiting\n`);
    if (s(state.waiting.reason) !== '') w.write(LEVEL_3, `Reason:\t${s(state.waiting.reason)}\n`);
  } else if (isObject(state.terminated)) {
    const t = state.terminated;
    w.write(LEVEL_2, `${name}:\tTerminated\n`);
    if (s(t.reason) !== '') w.write(LEVEL_3, `Reason:\t${s(t.reason)}\n`);
    if (s(t.message) !== '') w.write(LEVEL_3, `Message:\t${s(t.message)}\n`);
    w.write(LEVEL_3, `Exit Code:\t${d(t.exitCode)}\n`);
    if (typeof t.signal === 'number' && t.signal > 0) w.write(LEVEL_3, `Signal:\t${t.signal}\n`);
    w.write(LEVEL_3, `Started:\t${rfc1123z(t.startedAt)}\n`);
    w.write(LEVEL_3, `Finished:\t${rfc1123z(t.finishedAt)}\n`);
  } else {
    w.write(LEVEL_2, `${name}:\tWaiting\n`);
  }
}

function describeContainerProbe(c: JsonObject, w: PrefixWriter): void {
  if (isObject(c.livenessProbe)) w.write(LEVEL_2, `Liveness:\t${describeProbe(c.livenessProbe)}\n`);
  if (isObject(c.readinessProbe)) w.write(LEVEL_2, `Readiness:\t${describeProbe(c.readinessProbe)}\n`);
  if (isObject(c.startupProbe)) w.write(LEVEL_2, `Startup:\t${describeProbe(c.startupProbe)}\n`);
}

/** IntOrString.String() */
const intOrString = (v: Json | undefined): string => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '0');

/** net.JoinHostPort */
const joinHostPort = (host: string, port: string): string => (host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`);

// url.shouldEscape(c, encodePath): unreserved characters and $&+,/:;=@ stay.
const pathEscape = (p: string): string => {
  let out = '';
  for (const ch of p) {
    if (/^[A-Za-z0-9\-._~$&+,/:;=@]$/.test(ch)) out += ch;
    else for (const c of utf8Encode(ch)) out += `%${c.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
};

/** DescribeProbe */
export function describeProbe(probe: JsonObject): string {
  const attrs = `delay=${d(probe.initialDelaySeconds)}s timeout=${d(probe.timeoutSeconds)}s period=${d(probe.periodSeconds)}s successThreshold=${d(probe.successThreshold)} failureThreshold=${d(probe.failureThreshold)}`;
  if (isObject(probe.exec)) {
    const cmd = Array.isArray(probe.exec.command) ? probe.exec.command.map((x) => (typeof x === 'string' ? x : '')) : [];
    return `exec [${cmd.join(' ')}] ${attrs}`;
  }
  if (isObject(probe.httpGet)) {
    const g = probe.httpGet;
    const scheme = s(g.scheme).toLowerCase();
    const port = intOrString(g.port);
    const host = port.length > 0 ? joinHostPort(s(g.host), port) : s(g.host);
    const path = pathEscape(s(g.path));
    // URL.String: "scheme:" then "//host" when there is a host or a path, then the path
    let url = scheme !== '' ? `${scheme}:` : '';
    if (scheme !== '' || host !== '') if (host !== '' || path !== '') url += `//${host}`;
    if (path !== '' && !path.startsWith('/') && host !== '') url += '/';
    url += path;
    return `http-get ${url} ${attrs}`;
  }
  if (isObject(probe.tcpSocket)) return `tcp-socket ${s(probe.tcpSocket.host)}:${intOrString(probe.tcpSocket.port)} ${attrs}`;
  if (isObject(probe.grpc)) return `grpc <pod>:${d(probe.grpc.port)} ${s(probe.grpc.service)} ${attrs}`;
  return `unknown ${attrs}`;
}

function describeContainerVolumes(c: JsonObject, w: PrefixWriter): void {
  const mounts = objs(c.volumeMounts);
  const none = mounts.length === 0 ? '\t<none>' : '';
  w.write(LEVEL_2, `Mounts:${none}\n`);
  for (const m of sortBy([...mounts], (a, x) => compareGoStrings(s(a.mountPath), s(x.mountPath)) < 0)) {
    const flags = [m.readOnly === true ? 'ro' : 'rw'];
    if (s(m.subPath) !== '') flags.push(`path=${JSON.stringify(s(m.subPath))}`);
    w.write(LEVEL_3, `${s(m.mountPath)} from ${s(m.name)} (${flags.join(',')})\n`);
  }
  const devices = objs(c.volumeDevices);
  if (devices.length > 0) {
    w.write(LEVEL_2, `Devices:${none}\n`);
    for (const dev of sortBy([...devices], (a, x) => compareGoStrings(s(a.devicePath), s(x.devicePath)) < 0)) w.write(LEVEL_3, `${s(dev.devicePath)} from ${s(dev.name)}\n`);
  }
}

/** EnvValueRetriever: only metadata.name and metadata.namespace convert in kubectl's scheme. */
function envFieldValue(pod: JsonObject | undefined, fieldPath: string): string {
  if (!pod) return '';
  if (fieldPath === 'metadata.name') return s(meta(pod).name);
  if (fieldPath === 'metadata.namespace') return s(meta(pod).namespace);
  return '';
}

function quantityOrZero(v: Json | undefined): Quantity | undefined {
  if (v === undefined) return undefined;
  const q = parseQuantity(typeof v === 'number' ? String(v) : s(v));
  return 'error' in q ? undefined : q;
}

/** ExtractContainerResourceValue: ceil(value / divisor), divisor 1 when unset or zero. */
function containerResourceValue(fs: JsonObject, c: JsonObject): string | undefined {
  const div = quantityOrZero(fs.divisor);
  const divisor = div && div.unscaled !== 0n ? div : (parseQuantity('1') as Quantity);
  const r = obj(c.resources);
  const resource = s(fs.resource);
  const pick = (kind: 'limits' | 'requests', name: string) => quantityOrZero(obj(r[kind])[name]);
  const cpu = (q: Quantity | undefined) => String(Math.ceil((q ? milliValue(q) : 0) / milliValue(divisor)));
  const units = (q: Quantity | undefined) => String(Math.ceil((q ? value(q) : 0) / value(divisor)));
  const [kind, name] = resource.startsWith('limits.') ? (['limits', resource.slice(7)] as const) : resource.startsWith('requests.') ? (['requests', resource.slice(9)] as const) : [undefined, ''];
  if (!kind) return undefined;
  if (name === 'cpu') return cpu(pick(kind, name));
  if (name === 'memory' || name === 'ephemeral-storage' || name.startsWith('hugepages-')) return units(pick(kind, name));
  return undefined;
}

function describeContainerEnvVars(c: JsonObject, pod: JsonObject | undefined, w: PrefixWriter): void {
  const env = objs(c.env);
  w.write(LEVEL_2, `Environment:${env.length === 0 ? '\t<none>' : ''}\n`);
  for (const e of env) {
    if (!isObject(e.valueFrom)) {
      s(e.value)
        .split('\n')
        .forEach((line, i) => w.write(LEVEL_3, i === 0 ? `${s(e.name)}:\t${line}\n` : `\t${line}\n`));
      continue;
    }
    const vf = e.valueFrom;
    if (isObject(vf.fieldRef)) {
      // resolverFn is nil in a Pod template
      const v = pod ? envFieldValue(pod, s(vf.fieldRef.fieldPath)) : '';
      w.write(LEVEL_3, `${s(e.name)}:\t${v} (${s(vf.fieldRef.apiVersion)}:${s(vf.fieldRef.fieldPath)})\n`);
    } else if (isObject(vf.resourceFieldRef)) {
      let v = containerResourceValue(vf.resourceFieldRef, c) ?? '';
      const resource = s(vf.resourceFieldRef.resource);
      if (v === '0' && (resource === 'limits.cpu' || resource === 'limits.memory')) v = 'node allocatable';
      w.write(LEVEL_3, `${s(e.name)}:\t${v} (${resource})\n`);
    } else if (isObject(vf.secretKeyRef)) {
      const r = vf.secretKeyRef;
      w.write(LEVEL_3, `${s(e.name)}:\t<set to the key '${s(r.key)}' in secret '${s(r.name)}'>\tOptional: ${optional(r)}\n`);
    } else if (isObject(vf.configMapKeyRef)) {
      const r = vf.configMapKeyRef;
      w.write(LEVEL_3, `${s(e.name)}:\t<set to the key '${s(r.key)}' of config map '${s(r.name)}'>\tOptional: ${optional(r)}\n`);
    }
  }
}

function describeContainerEnvFrom(c: JsonObject, w: PrefixWriter): void {
  const envFrom = objs(c.envFrom);
  w.write(LEVEL_2, `Environment Variables from:${envFrom.length === 0 ? '\t<none>' : ''}\n`);
  for (const e of envFrom) {
    let from = '';
    let name = '';
    let opt = 'false';
    if (isObject(e.configMapRef)) {
      from = 'ConfigMap';
      name = s(e.configMapRef.name);
      opt = optional(e.configMapRef);
    } else if (isObject(e.secretRef)) {
      from = 'Secret';
      name = s(e.secretRef.name);
      opt = optional(e.secretRef);
    }
    if (s(e.prefix) === '') w.write(LEVEL_3, `${name}\t${from}\tOptional: ${opt}\n`);
    else w.write(LEVEL_3, `${name}\t${from} with prefix '${s(e.prefix)}'\tOptional: ${opt}\n`);
  }
}

/** DescribePodTemplate */
export function describePodTemplate(template: Json | undefined, w: PrefixWriter): void {
  w.write(LEVEL_0, 'Pod Template:\n');
  if (!isObject(template)) {
    w.write(LEVEL_1, '<unset>');
    return;
  }
  const m = obj(template.metadata);
  const spec = obj(template.spec);
  printLabelsMultiline(w, '  Labels', m.labels);
  if (isObject(m.annotations) && Object.keys(m.annotations).length > 0) printAnnotationsMultiline(w, '  Annotations', m.annotations);
  if (s(spec.serviceAccountName) !== '') w.write(LEVEL_1, `Service Account:\t${s(spec.serviceAccountName)}\n`);
  if (objs(spec.initContainers).length > 0) describeContainers('Init Containers', objs(spec.initContainers), [], undefined, w, '  ');
  describeContainers('Containers', objs(spec.containers), [], undefined, w, '  ');
  describeVolumes(objs(spec.volumes), w, '  ');
  describeTopologySpreadConstraints(objs(spec.topologySpreadConstraints), w, '  ');
  if (s(spec.priorityClassName) !== '') w.write(LEVEL_1, `Priority Class Name:\t${s(spec.priorityClassName)}\n`);
  printLabelsMultiline(w, '  Node-Selectors', spec.nodeSelector);
  printPodTolerationsMultiline(w, '  Tolerations', spec.tolerations);
  if (isObject(spec.schedulingGroup)) describeSchedulingGroup(spec.schedulingGroup, w, '  ');
}
