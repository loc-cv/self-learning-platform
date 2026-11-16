// The API server's warnings for a Pod or a pod template: the `Warning` headers a create (and an
// update that changes a template's generation) answers with.
// upstream: pkg/api/pod/warnings.go GetWarningsForPod, GetWarningsForPodTemplate,
//   deprecatedAnnotations, warningsForPodSpecAndMeta, warningsForPodAffinityTerms,
//   warningsForWeightedPodAffinityTerms, warningsForOverlappingVirtualPaths, pathAndSource.String,
//   checkVolumeMappingForOverlap, checkForOverlap;
// pkg/api/node/util.go deprecatedNodeLabels, GetNodeLabelDeprecatedMessage,
//   GetWarningsForNodeSelectorTerm; pkg/api/persistentvolumeclaim/util.go
//   GetWarningsForPersistentVolumeClaimSpec; pkg/api/pod/util.go ApparmorFieldForAnnotation;
// pkg/apis/core/annotation_key_constants.go (the seccomp and AppArmor annotation keys and values).
//
// Go iterates the nodeSelector map in random order, so several deprecated keys warn in an order
// that varies between requests; here they warn in sorted key order.

import type { Path } from '../../../apimachinery/field.ts';
import { goQuote, newPath } from '../../../apimachinery/field.ts';
import { isValidLabelValue } from '../../../apimachinery/validation/names.ts';
import { getWarningsForIP } from '../../../apimachinery/validation/ip.ts';
import { jsonEqual, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import { parseQuantity, quantityString, scaledValue, MILLI } from '../../../apimachinery/quantity.ts';
import { arr, isSet, num, obj, objs, sortedKeys, str, strMap } from './util.ts';

const DEPRECATED_ANNOTATIONS: readonly { key: string; message: string }[] = [
  { key: 'scheduler.alpha.kubernetes.io/critical-pod', message: 'non-functional in v1.16+; use the "priorityClassName" field instead' },
  { key: 'security.alpha.kubernetes.io/sysctls', message: 'non-functional in v1.11+; use the "sysctls" field instead' },
  { key: 'security.alpha.kubernetes.io/unsafe-sysctls', message: 'non-functional in v1.11+; use the "sysctls" field instead' },
];

const DEPRECATED_NODE_LABELS: Readonly<Record<string, string>> = {
  'beta.kubernetes.io/arch': 'deprecated since v1.14; use "kubernetes.io/arch" instead',
  'beta.kubernetes.io/os': 'deprecated since v1.14; use "kubernetes.io/os" instead',
  'failure-domain.beta.kubernetes.io/region': 'deprecated since v1.17; use "topology.kubernetes.io/region" instead',
  'failure-domain.beta.kubernetes.io/zone': 'deprecated since v1.17; use "topology.kubernetes.io/zone" instead',
  'beta.kubernetes.io/instance-type': 'deprecated since v1.17; use "node.kubernetes.io/instance-type" instead',
  'app.kubernetes.io/created-by': 'deprecated since v1.9',
  'scheduler.alpha.kubernetes.io/preferAvoidPods': 'deprecated since v1.22; use Taints and Tolerations instead',
  'node-role.kubernetes.io/master': 'use "node-role.kubernetes.io/control-plane" instead',
};

/** Volume sources that are deprecated or removed, with the field name the warning's path uses. */
const DEPRECATED_VOLUMES: readonly { json: string; field: string; message: string }[] = [
  { json: 'photonPersistentDisk', field: 'photonPersistentDisk', message: 'deprecated in v1.11, non-functional in v1.16+' },
  // The GitRepoVolumeDriver gate is off by default in v1.37 (pkg/features/kube_features.go).
  { json: 'gitRepo', field: 'gitRepo', message: 'deprecated in v1.11, and disabled by default in v1.33+' },
  { json: 'scaleIO', field: 'scaleIO', message: 'deprecated in v1.16, non-functional in v1.22+' },
  { json: 'flocker', field: 'flocker', message: 'deprecated in v1.22, non-functional in v1.25+' },
  // v1's json tag is "storageos"; the warning names the Go field.
  { json: 'storageos', field: 'storageOS', message: 'deprecated in v1.22, non-functional in v1.25+' },
  { json: 'quobyte', field: 'quobyte', message: 'deprecated in v1.22, non-functional in v1.25+' },
  { json: 'glusterfs', field: 'glusterfs', message: 'deprecated in v1.25, non-functional in v1.26+' },
];
const DEPRECATED_VOLUMES_LATE: readonly { json: string; field: string; message: string }[] = [
  { json: 'cephfs', field: 'cephfs', message: 'deprecated in v1.28, non-functional in v1.31+' },
  { json: 'rbd', field: 'rbd', message: 'deprecated in v1.28, non-functional in v1.31+' },
];

const SECCOMP_POD_ANNOTATION = 'seccomp.security.alpha.kubernetes.io/pod';
const SECCOMP_CONTAINER_ANNOTATION_PREFIX = 'container.seccomp.security.alpha.kubernetes.io/';
const APPARMOR_CONTAINER_ANNOTATION_PREFIX = 'container.apparmor.security.beta.kubernetes.io/';

/** GetNodeLabelDeprecatedMessage */
export function getNodeLabelDeprecatedMessage(key: string): string | undefined {
  return Object.hasOwn(DEPRECATED_NODE_LABELS, key) ? DEPRECATED_NODE_LABELS[key] : undefined;
}

/** GetWarningsForNodeSelectorTerm */
function warningsForNodeSelectorTerm(term: JsonObject, checkLabelValue: boolean, path: Path): string[] {
  const warnings: string[] = [];
  objs(term.matchExpressions).forEach((e, i) => {
    const key = str(e.key);
    const msg = getNodeLabelDeprecatedMessage(key);
    if (msg !== undefined) warnings.push(`${path.child('matchExpressions').index(i).child('key').toString()}: ${key} is ${msg}`);
    if (checkLabelValue) {
      arr(e.values).forEach((v, index) => {
        for (const m of isValidLabelValue(str(v))) {
          warnings.push(`${path.child('matchExpressions').index(i).child('values').index(index).toString()}: ${str(v)} is invalid, ${m}`);
        }
      });
    }
  });
  return warnings;
}

/** A path under the template's path (nil for a Pod: the path starts at the child). */
function under(root: Path | undefined, name: string, ...more: string[]): Path {
  return root ? root.child(name, ...more) : newPath(name, ...more);
}

/**
 * Quantity.MilliValue() % 1000 != 0, and Quantity.String(), of a quantity the server decoded;
 * undefined for a whole number of bytes (or a value that would not have decoded).
 */
function fractionalBytes(v: Json | undefined): string | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const q = parseQuantity(String(v));
  if ('error' in q) return undefined;
  if (scaledValue(q, MILLI) % 1000n === 0n) return undefined;
  return quantityString(q);
}

function fractionalWarning(path: Path, v: Json | undefined): string[] {
  const s = fractionalBytes(v);
  return s === undefined ? [] : [`${path.toString()}: fractional byte value ${goQuote(s)} is invalid, must be an integer`];
}

/** GetWarningsForPersistentVolumeClaimSpec */
function pvcSpecWarnings(path: Path, spec: JsonObject): string[] {
  const resources = obj(spec.resources) ?? {};
  return [
    ...fractionalWarning(path.child('resources').child('requests').key('storage'), obj(resources.requests)?.storage),
    ...fractionalWarning(path.child('resources').child('limits').key('storage'), obj(resources.limits)?.storage),
  ];
}

/** ApparmorFieldForAnnotation, as the versioned JSON of an AppArmorProfile. */
function apparmorFieldForAnnotation(annotation: string): JsonObject | undefined {
  if (annotation === 'unconfined') return { type: 'Unconfined' };
  if (annotation === 'runtime/default') return { type: 'RuntimeDefault' };
  if (annotation.startsWith('localhost/')) {
    const profile = annotation.slice('localhost/'.length);
    if (profile !== '') return { type: 'Localhost', localhostProfile: profile };
  }
  return undefined;
}

/** podshelper.VisitContainersWithPath: init, regular, then ephemeral containers. */
function visitContainers(spec: JsonObject, path: Path, fn: (c: JsonObject, p: Path) => void): void {
  objs(spec.initContainers).forEach((c, i) => fn(c, path.child('initContainers').index(i)));
  objs(spec.containers).forEach((c, i) => fn(c, path.child('containers').index(i)));
  objs(spec.ephemeralContainers).forEach((c, i) => fn(c, path.child('ephemeralContainers').index(i)));
}

interface Port {
  name: string;
  hostPort: number;
  containerPort: number;
  protocol: string;
  hostIP: string;
}

function portOf(p: JsonObject): Port {
  return { name: str(p.name), hostPort: num(p.hostPort), containerPort: num(p.containerPort), protocol: str(p.protocol), hostIP: str(p.hostIP) };
}

/** fmt's %+v of the internal api.ContainerPort (field order of pkg/apis/core/types.go). */
function portString(p: Port): string {
  return `{Name:${p.name} HostPort:${p.hostPort} ContainerPort:${p.containerPort} Protocol:${p.protocol} HostIP:${p.hostIP}}`;
}

// ---- overlapping paths of projected and mapped volumes ----

interface PathAndSource {
  path: string;
  source: string;
}

function psString(ps: PathAndSource): string {
  return ps.source !== '' ? `${goQuote(ps.path)} (${ps.source})` : goQuote(ps.path);
}

/** strings.TrimRight(path, "/") */
const trimSlashes = (s: string): string => s.replace(/\/+$/, '');

function checkForOverlap(haystack: readonly PathAndSource[], needle: PathAndSource): PathAndSource[] {
  if (needle.path === '') return [];
  const result: PathAndSource[] = [];
  for (const item of haystack) {
    if (item.path === '') continue;
    if (item.path === needle.path && item.source === needle.source) result.push(item);
    else if (`${item.path}/`.startsWith(`${needle.path}/`)) result.push(item);
    else if (`${needle.path}/`.startsWith(`${item.path}/`)) result.push(item);
  }
  return result;
}

function checkVolumeMappingForOverlap(paths: readonly PathAndSource[]): string[] {
  const warnings: string[] = [];
  const all: PathAndSource[] = [];
  for (const p of paths) {
    const ps = { path: trimSlashes(p.path), source: p.source };
    for (const c of checkForOverlap(all, ps)) warnings.push(`${psString(ps)} with ${psString(c)}`);
    all.push(ps);
  }
  return warnings;
}

const extractPaths = (items: Json | undefined, source: string): PathAndSource[] => objs(items).map((i) => ({ path: str(i.path), source }));

/** The VolumeProjection fields of the internal type: a source with none of them is empty. */
const PROJECTION_FIELDS = ['secret', 'downwardAPI', 'configMap', 'serviceAccountToken', 'clusterTrustBundle', 'podCertificate'];

function projectionPaths(source: JsonObject): PathAndSource[] {
  const cm = obj(source.configMap);
  const secret = obj(source.secret);
  const downward = obj(source.downwardAPI);
  const token = obj(source.serviceAccountToken);
  const bundle = obj(source.clusterTrustBundle);
  const cert = obj(source.podCertificate);
  if (cm && Array.isArray(cm.items)) return extractPaths(cm.items, `ConfigMap ${goQuote(str(cm.name))}`);
  if (secret && Array.isArray(secret.items)) return extractPaths(secret.items, `Secret ${goQuote(str(secret.name))}`);
  if (downward && Array.isArray(downward.items)) return extractPaths(downward.items, 'DownwardAPI');
  if (token) return [{ path: str(token.path), source: 'ServiceAccountToken' }];
  if (bundle) {
    const name = isSet(bundle.name) ? str(bundle.name) : str(bundle.signerName);
    return [{ path: str(bundle.path), source: `ClusterTrustBundle ${goQuote(name)}` }];
  }
  if (cert) {
    const out: PathAndSource[] = [];
    if (str(cert.certificateChainPath) !== '') out.push({ path: str(cert.certificateChainPath), source: 'PodCertificate chain' });
    if (str(cert.keyPath) !== '') out.push({ path: str(cert.keyPath), source: 'PodCertificate key' });
    if (str(cert.credentialBundlePath) !== '') out.push({ path: str(cert.credentialBundlePath), source: 'PodCertificate credential bundle' });
    return out;
  }
  return [];
}

/** warningsForOverlappingVirtualPaths */
function warningsForOverlappingVirtualPaths(volumes: readonly JsonObject[]): string[] {
  const warnings: string[] = [];
  const mkWarn = (volName: string, volDesc: string, body: string) => `volume ${goQuote(volName)} (${volDesc}): overlapping paths: ${body}`;
  for (const v of volumes) {
    const name = str(v.name);
    const cm = obj(v.configMap);
    if (cm && Array.isArray(cm.items)) {
      for (const ol of checkVolumeMappingForOverlap(extractPaths(cm.items, ''))) warnings.push(mkWarn(name, `ConfigMap ${goQuote(str(cm.name))}`, ol));
    }
    const secret = obj(v.secret);
    if (secret && Array.isArray(secret.items)) {
      for (const ol of checkVolumeMappingForOverlap(extractPaths(secret.items, ''))) warnings.push(mkWarn(name, `Secret ${goQuote(str(secret.secretName))}`, ol));
    }
    const downward = obj(v.downwardAPI);
    if (downward && Array.isArray(downward.items)) {
      for (const ol of checkVolumeMappingForOverlap(extractPaths(downward.items, ''))) warnings.push(mkWarn(name, 'DownwardAPI', ol));
    }
    const projected = obj(v.projected);
    if (!projected) continue;
    const all: PathAndSource[] = [];
    for (const source of objs(projected.sources)) {
      if (!PROJECTION_FIELDS.some((f) => isSet(source[f]))) {
        warnings.push(`volume ${goQuote(name)} (Projected) has no sources provided`);
        continue;
      }
      for (const p of projectionPaths(source)) {
        const ps = { path: trimSlashes(p.path), source: p.source };
        for (const c of checkForOverlap(all, ps)) warnings.push(mkWarn(name, 'Projected', `${psString(ps)} with ${psString(c)}`));
        all.push(ps);
      }
    }
  }
  return warnings;
}

// ---- warningsForPodSpecAndMeta ----

function nullSelectorWarnings(terms: Json | undefined, path: Path, weighted: boolean): string[] {
  const warnings: string[] = [];
  objs(terms).forEach((t, i) => {
    const term = weighted ? (obj(t.podAffinityTerm) ?? {}) : t;
    if (!isSet(term.labelSelector)) {
      const p = weighted ? path.index(i).child('podAffinityTerm', 'labelSelector') : path.index(i).child('labelSelector');
      warnings.push(`${p.toString()}: a null labelSelector results in matching no pod`);
    }
  });
  return warnings;
}

function warningsForPodSpecAndMeta(root: Path | undefined, spec: JsonObject, meta: JsonObject): string[] {
  const warnings: string[] = [];
  const annotations = strMap(meta.annotations);
  const hasAnnotation = (k: string) => Object.hasOwn(annotations, k);
  const specPath = under(root, 'spec');

  // use of deprecated node labels in selectors/affinity/topology
  const nodeSelector = strMap(spec.nodeSelector);
  for (const k of sortedKeys(nodeSelector)) {
    const msg = getNodeLabelDeprecatedMessage(k);
    if (msg !== undefined) warnings.push(`${under(root, 'spec', 'nodeSelector').key(k).toString()}: ${msg}`);
  }
  const affinity = obj(spec.affinity);
  const nodeAffinity = obj(affinity?.nodeAffinity);
  if (nodeAffinity) {
    const required = obj(nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution);
    if (required) {
      const termPath = under(root, 'spec', 'affinity', 'nodeAffinity', 'requiredDuringSchedulingIgnoredDuringExecution', 'nodeSelectorTerms');
      objs(required.nodeSelectorTerms).forEach((t, i) => warnings.push(...warningsForNodeSelectorTerm(t, false, termPath.index(i))));
    }
    const preferredPath = under(root, 'spec', 'affinity', 'nodeAffinity', 'preferredDuringSchedulingIgnoredDuringExecution');
    objs(nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution).forEach((t, i) =>
      warnings.push(...warningsForNodeSelectorTerm(obj(t.preference) ?? {}, true, preferredPath.index(i).child('preference'))),
    );
  }
  objs(spec.topologySpreadConstraints).forEach((t, i) => {
    const path = under(root, 'spec', 'topologySpreadConstraints').index(i);
    const msg = getNodeLabelDeprecatedMessage(str(t.topologyKey));
    if (msg !== undefined) warnings.push(`${path.child('topologyKey').toString()}: ${str(t.topologyKey)} is ${msg}`);
    if (!isSet(t.labelSelector)) warnings.push(`${path.child('labelSelector').toString()}: a null labelSelector results in matching no pod`);
  });

  // use of deprecated annotations
  for (const d of DEPRECATED_ANNOTATIONS) {
    if (hasAnnotation(d.key)) warnings.push(`${under(root, 'metadata', 'annotations').key(d.key).toString()}: ${d.message}`);
  }

  // deprecated and removed volume plugins
  const volumes = objs(spec.volumes);
  volumes.forEach((v, i) => {
    const path = under(root, 'spec', 'volumes').index(i);
    for (const d of DEPRECATED_VOLUMES) if (isSet(v[d.json])) warnings.push(`${path.child(d.field).toString()}: ${d.message}`);
    const template = obj(obj(v.ephemeral)?.volumeClaimTemplate);
    if (template) warnings.push(...pvcSpecWarnings(path.child('ephemeral').child('volumeClaimTemplate').child('spec'), obj(template.spec) ?? {}));
    for (const d of DEPRECATED_VOLUMES_LATE) if (isSet(v[d.json])) warnings.push(`${path.child(d.field).toString()}: ${d.message}`);
  });
  warnings.push(...warningsForOverlappingVirtualPaths(volumes));

  // duplicate hostAliases (#91670, #58477)
  const hostAliases = objs(spec.hostAliases);
  if (hostAliases.length > 1) {
    const seen = new Set<string>();
    hostAliases.forEach((h, i) => {
      const ip = str(h.ip);
      if (seen.has(ip)) warnings.push(`${under(root, 'spec', 'hostAliases').index(i).child('ip').toString()}: duplicate ip ${goQuote(ip)}`);
      else seen.add(ip);
    });
  }

  // duplicate imagePullSecrets (#91629, #58477), and empty names (#99454)
  const pullSecrets = objs(spec.imagePullSecrets);
  if (pullSecrets.length > 1) {
    const seen = new Set<string>();
    pullSecrets.forEach((s, i) => {
      const name = str(s.name);
      if (seen.has(name)) warnings.push(`${under(root, 'spec', 'imagePullSecrets').index(i).child('name').toString()}: duplicate name ${goQuote(name)}`);
      else seen.add(name);
    });
  }
  pullSecrets.forEach((s, i) => {
    if (str(s.name) === '') warnings.push(`${under(root, 'spec', 'imagePullSecrets').index(i).child('name').toString()}: invalid empty name ""`);
  });

  // fractional memory/ephemeral-storage requests/limits (#79950, #49442, #18538)
  const overhead = obj(spec.overhead) ?? {};
  warnings.push(...fractionalWarning(under(root, 'spec', 'overhead').key('memory'), overhead.memory));
  warnings.push(...fractionalWarning(under(root, 'spec', 'overhead').key('ephemeral-storage'), overhead['ephemeral-storage']));

  // use of pod seccomp annotation without accompanying field
  const podSC = obj(spec.securityContext);
  if (!isSet(podSC?.seccompProfile) && hasAnnotation(SECCOMP_POD_ANNOTATION)) {
    warnings.push(`${under(root, 'metadata', 'annotations').key(SECCOMP_POD_ANNOTATION).toString()}: non-functional in v1.27+; use the "seccompProfile" field instead`);
  }
  const podAppArmor = obj(podSC?.appArmorProfile);

  visitContainers(spec, specPath, (c, p) => {
    const name = str(c.name);
    const sc = obj(c.securityContext);
    // use of container seccomp annotation without accompanying field
    if (!isSet(sc?.seccompProfile) && hasAnnotation(SECCOMP_CONTAINER_ANNOTATION_PREFIX + name)) {
      warnings.push(`${under(root, 'metadata', 'annotations').key(SECCOMP_CONTAINER_ANNOTATION_PREFIX + name).toString()}: non-functional in v1.27+; use the "seccompProfile" field instead`);
    }
    // use of container AppArmor annotation without accompanying field; Pods get theirs through
    // applyAppArmorVersionSkew instead.
    const key = APPARMOR_CONTAINER_ANNOTATION_PREFIX + name;
    if (root !== undefined && !isSet(sc?.appArmorProfile) && hasAnnotation(key)) {
      const fromAnnotation = apparmorFieldForAnnotation(annotations[key] as string);
      if (!podAppArmor || !fromAnnotation || !jsonEqual(podAppArmor, fromAnnotation)) {
        warnings.push(`${root.child('metadata', 'annotations').key(key).toString()}: deprecated since v1.30; use the "appArmorProfile" field instead`);
      }
    }
    // fractional memory/ephemeral-storage requests/limits
    const resources = obj(c.resources) ?? {};
    const limits = obj(resources.limits) ?? {};
    const requests = obj(resources.requests) ?? {};
    warnings.push(...fractionalWarning(p.child('resources', 'limits').key('memory'), limits.memory));
    warnings.push(...fractionalWarning(p.child('resources', 'requests').key('memory'), requests.memory));
    warnings.push(...fractionalWarning(p.child('resources', 'limits').key('ephemeral-storage'), limits['ephemeral-storage']));
    warnings.push(...fractionalWarning(p.child('resources', 'requests').key('ephemeral-storage'), requests['ephemeral-storage']));
    // duplicate containers[*].env (#86163, #93266, #58477)
    const env = objs(c.env);
    if (env.length > 1) {
      const seen = new Set<string>();
      env.forEach((item, i) => {
        const n = str(item.name);
        if (!seen.has(n)) {
          seen.add(n);
          return;
        }
        const ref = `$(${n})`;
        const value = str(item.value);
        const bad = isSet(item.valueFrom) || value === ref || !value.includes(ref);
        if (bad) warnings.push(`${p.child('env').index(i).toString()}: hides previous definition of ${goQuote(n)}, which may be dropped when using apply`);
      });
    }
  });

  // ports across all containers
  const allPorts = new Map<string, { field: Path; port: Port }[]>();
  visitContainers(spec, specPath, (c, p) => {
    objs(c.ports).forEach((raw, i) => {
      const port = portOf(raw);
      const field = p.child('ports').index(i);
      if (port.hostIP !== '' && port.hostPort === 0) warnings.push(`${field.toString()}: hostIP set without hostPort: ${portString(port)}`);
      const k = `${port.containerPort}/${port.protocol}`;
      const others = allPorts.get(k);
      if (!others) {
        allPorts.set(k, [{ field, port }]);
        return;
      }
      for (const other of others) {
        const a = port.hostIP === '';
        const b = other.port.hostIP === '';
        if (port.hostIP === other.port.hostIP && port.hostPort === other.port.hostPort) {
          warnings.push(`${field.toString()}: duplicate port definition with ${other.field.toString()}`);
        } else if (port.hostPort === 0 || other.port.hostPort === 0) {
          warnings.push(`${field.toString()}: overlapping port definition with ${other.field.toString()}`);
        } else if (port.hostPort === other.port.hostPort && (a || b) && !(a && b)) {
          warnings.push(`${field.toString()}: dangerously ambiguous port definition with ${other.field.toString()}`);
        }
      }
      others.push({ field, port });
    });
  });

  // port names of containers and sidecar containers
  const portNames = new Map<string, Path>();
  visitContainers(spec, specPath, (c, p) => {
    objs(c.ports).forEach((raw, i) => {
      const name = str(raw.name);
      if (name === '') return;
      const other = portNames.get(name);
      const field = p.child('ports').index(i);
      if (other) warnings.push(`${field.toString()}: duplicate port name ${goQuote(name)} with ${other.toString()}, services and probes that select ports by name will use ${other.toString()}`);
      else portNames.set(name, field);
    });
  });

  // negative terminationGracePeriodSeconds
  if (typeof spec.terminationGracePeriodSeconds === 'number' && spec.terminationGracePeriodSeconds < 0) {
    warnings.push(`${under(root, 'spec', 'terminationGracePeriodSeconds').toString()}: must be >= 0; negative values are invalid and will be treated as 1`);
  }

  if (affinity) {
    for (const kind of ['podAffinity', 'podAntiAffinity']) {
      const a = obj(affinity[kind]);
      if (!a) continue;
      warnings.push(...nullSelectorWarnings(a.requiredDuringSchedulingIgnoredDuringExecution, under(root, 'spec', 'affinity', kind, 'requiredDuringSchedulingIgnoredDuringExecution'), false));
      warnings.push(...nullSelectorWarnings(a.preferredDuringSchedulingIgnoredDuringExecution, under(root, 'spec', 'affinity', kind, 'preferredDuringSchedulingIgnoredDuringExecution'), true));
    }
  }

  // deprecated IP address formats
  const dnsConfig = obj(spec.dnsConfig);
  if (dnsConfig) arr(dnsConfig.nameservers).forEach((ns, i) => warnings.push(...getWarningsForIP(under(root, 'spec', 'dnsConfig', 'nameservers').index(i), str(ns))));
  hostAliases.forEach((h, i) => warnings.push(...getWarningsForIP(under(root, 'spec', 'hostAliases').index(i).child('ip'), str(h.ip))));

  return warnings;
}

/** GetWarningsForPod (the old Pod is not used by any warning). */
export function getWarningsForPod(pod: JsonObject): string[] {
  return warningsForPodSpecAndMeta(undefined, obj(pod.spec) ?? {}, obj(pod.metadata) ?? {});
}

/** GetWarningsForPodTemplate of the template at `path` (spec.template). */
export function getWarningsForPodTemplate(path: Path, template: JsonObject | undefined): string[] {
  if (!template) return [];
  return warningsForPodSpecAndMeta(path, obj(template.spec) ?? {}, obj(template.metadata) ?? {});
}
