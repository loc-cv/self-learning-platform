// Defaulting of Pods and pod templates on the versioned (v1) JSON.
// upstream: pkg/apis/core/v1/defaults.go (SetDefaults_Pod, SetDefaults_PodSpec, SetDefaults_Container,
// SetDefaults_Volume, SetDefaults_Probe, SetDefaults_HTTPGetAction, SetDefaults_*VolumeSource,
// SetDefaults_ObjectFieldSelector, SetDefaults_ServiceAccountTokenProjection,
// SetDefaults_ResourceList, SetDefaults_PodStatus, defaultHostNetworkPorts) and the order the
// generated SetObjectDefaults_Pod / SetObjectDefaults_PodTemplate call them in
// (pkg/apis/core/v1/zz_generated.defaults.go). A PodTemplateSpec embedded in a Deployment or a
// ReplicaSet gets the same walk minus SetDefaults_Pod (pkg/apis/apps/v1/zz_generated.defaults.go).
//
// Feature gates (v1.37.2 defaults, read from the oracle's kubernetes_feature_enabled metric):
// H2CContainerProbe is alpha and off, so httpGet.protocol is not defaulted; ImageVolume is on;
// PodLevelResourcesFixDefaulting is on, so pod-level requests are defaulted in PrepareForCreate,
// not here.

import { isObject, type Json, type JsonObject } from '../../../../apimachinery/json.ts';
import { parseQuantity, quantityString, roundUpQuantity, MILLI } from '../../../../apimachinery/quantity.ts';

const obj = (v: Json | undefined): JsonObject | undefined => (isObject(v) ? v : undefined);
const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const objs = (v: Json | undefined): JsonObject[] => arr(v).filter(isObject);
const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');

/** SetDefaults_ResourceList: every quantity rounded up to milli precision. */
export function defaultResourceList(list: Json | undefined): void {
  const l = obj(list);
  if (!l) return;
  for (const key of Object.keys(l)) {
    const v = l[key];
    if (typeof v !== 'string') continue;
    const q = parseQuantity(v);
    if ('error' in q) continue;
    const r = roundUpQuantity(q, MILLI);
    if (!r.exact) l[key] = quantityString(r.quantity);
  }
}

// The docker reference grammar. upstream: github.com/distribution/reference regexp.go (vendored by
// kubernetes, not in the sparse checkout): alphanumeric, separator, pathComponent, domainName,
// ipv6address, tag, digest; NameTotalLengthMax = 255.
const PATH_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*';
const DOMAIN_COMPONENT = '(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])';
const DOMAIN = `(?:(?:${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*|\\[(?:[a-fA-F0-9:]+)\\])(?::[0-9]+)?)`;
const NAME = `(?:${DOMAIN}/)?${PATH_COMPONENT}(?:/${PATH_COMPONENT})*`;
const REFERENCE = new RegExp(`^(${NAME})(?::([\\w][\\w.-]{0,127}))?(?:@([A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,}))?$`);

/**
 * The tag parsers.ParseImageName finds in an image reference: the explicit tag, "latest" when the
 * reference has neither tag nor digest, "" when it has only a digest or does not parse.
 * upstream: pkg/util/parsers/parsers.go ParseImageName (dockerref.ParseNormalizedNamed; the error is
 * ignored by SetDefaults_Container). ParseNormalizedNamed refuses 64-hex identifiers, uppercase
 * repository paths and names over 255 characters.
 */
export function imageTag(image: string): string {
  if (/^[a-f0-9]{64}$/.test(image)) return '';
  const m = REFERENCE.exec(image);
  if (!m) return '';
  const name = m[1] as string;
  if (name.length > 255) return '';
  const tag = m[2] ?? '';
  const digest = m[3] ?? '';
  if (tag === '' && digest === '') return 'latest';
  return tag;
}

/** SetDefaults_Container (also run for ephemeral containers). */
function defaultContainer(c: JsonObject): void {
  if (str(c.imagePullPolicy) === '') {
    // Ignore the parse error and assume it has been validated elsewhere, as upstream does.
    c.imagePullPolicy = imageTag(str(c.image)) === 'latest' ? 'Always' : 'IfNotPresent';
  }
  if (str(c.terminationMessagePath) === '') c.terminationMessagePath = '/dev/termination-log';
  if (str(c.terminationMessagePolicy) === '') c.terminationMessagePolicy = 'File';
}

function defaultProbe(p: JsonObject): void {
  // SetDefaults_Probe
  if (!p.timeoutSeconds) p.timeoutSeconds = 1;
  if (!p.periodSeconds) p.periodSeconds = 10;
  if (!p.successThreshold) p.successThreshold = 1;
  if (!p.failureThreshold) p.failureThreshold = 3;
  const http = obj(p.httpGet);
  if (http) defaultHTTPGetAction(http);
  const grpc = obj(p.grpc);
  if (grpc && grpc.service === undefined) grpc.service = '';
}

function defaultHTTPGetAction(a: JsonObject): void {
  if (str(a.path) === '') a.path = '/';
  if (str(a.scheme) === '') a.scheme = 'HTTP';
}

function defaultObjectFieldSelector(f: JsonObject): void {
  if (str(f.apiVersion) === '') f.apiVersion = 'v1';
}

/** The per-container walk of SetObjectDefaults_Pod: containers, init and ephemeral alike. */
function defaultContainerTree(c: JsonObject): void {
  defaultContainer(c);
  for (const p of objs(c.ports)) if (str(p.protocol) === '') p.protocol = 'TCP';
  for (const e of objs(c.env)) {
    const vf = obj(e.valueFrom);
    if (!vf) continue;
    const fr = obj(vf.fieldRef);
    if (fr) defaultObjectFieldSelector(fr);
    const fk = obj(vf.fileKeyRef);
    if (fk && fk.optional === undefined) fk.optional = false;
  }
  const res = obj(c.resources);
  if (res) {
    defaultResourceList(res.limits);
    defaultResourceList(res.requests);
  }
  for (const probe of ['livenessProbe', 'readinessProbe', 'startupProbe']) {
    const p = obj(c[probe]);
    if (p) defaultProbe(p);
  }
  const lc = obj(c.lifecycle);
  if (lc) {
    for (const h of ['postStart', 'preStop']) {
      const http = obj(obj(lc[h])?.httpGet);
      if (http) defaultHTTPGetAction(http);
    }
  }
}

const VOLUME_SOURCES = [
  'hostPath', 'emptyDir', 'gcePersistentDisk', 'awsElasticBlockStore', 'gitRepo', 'secret', 'nfs', 'iscsi', 'glusterfs',
  'persistentVolumeClaim', 'rbd', 'flexVolume', 'cinder', 'cephfs', 'flocker', 'downwardAPI', 'fc', 'azureFile', 'configMap',
  'vsphereVolume', 'quobyte', 'azureDisk', 'photonPersistentDisk', 'projected', 'portworxVolume', 'scaleIO', 'storageos', 'csi',
  'ephemeral', 'image',
];

/** SetDefaults_Volume and the volume source defaults SetObjectDefaults_Pod runs after it. */
function defaultVolume(v: JsonObject): void {
  // ptr.AllPtrFieldsNil(&obj.VolumeSource): a volume with no source is an emptyDir.
  if (!VOLUME_SOURCES.some((k) => v[k] !== undefined && v[k] !== null)) v.emptyDir = {};
  const image = obj(v.image);
  if (image && str(image.pullPolicy) === '') image.pullPolicy = imageTag(str(image.reference)) === 'latest' ? 'Always' : 'IfNotPresent';
  const hostPath = obj(v.hostPath);
  if (hostPath && hostPath.type === undefined) hostPath.type = '';
  const secret = obj(v.secret);
  if (secret && secret.defaultMode === undefined) secret.defaultMode = 0o644;
  const iscsi = obj(v.iscsi);
  if (iscsi && str(iscsi.iscsiInterface) === '') iscsi.iscsiInterface = 'default';
  const rbd = obj(v.rbd);
  if (rbd) {
    if (str(rbd.pool) === '') rbd.pool = 'rbd';
    if (str(rbd.user) === '') rbd.user = 'admin';
    if (str(rbd.keyring) === '') rbd.keyring = '/etc/ceph/keyring';
  }
  const downward = obj(v.downwardAPI);
  if (downward) {
    if (downward.defaultMode === undefined) downward.defaultMode = 0o644;
    for (const item of objs(downward.items)) {
      const fr = obj(item.fieldRef);
      if (fr) defaultObjectFieldSelector(fr);
    }
  }
  const cm = obj(v.configMap);
  if (cm && cm.defaultMode === undefined) cm.defaultMode = 0o644;
  const azureDisk = obj(v.azureDisk);
  if (azureDisk) {
    if (azureDisk.cachingMode === undefined) azureDisk.cachingMode = 'ReadWrite';
    if (azureDisk.fsType === undefined) azureDisk.fsType = 'ext4';
    if (azureDisk.readOnly === undefined) azureDisk.readOnly = false;
    if (azureDisk.kind === undefined) azureDisk.kind = 'Shared';
  }
  const projected = obj(v.projected);
  if (projected) {
    if (projected.defaultMode === undefined) projected.defaultMode = 0o644;
    for (const src of objs(projected.sources)) {
      for (const item of objs(obj(src.downwardAPI)?.items)) {
        const fr = obj(item.fieldRef);
        if (fr) defaultObjectFieldSelector(fr);
      }
      const sat = obj(src.serviceAccountToken);
      if (sat && sat.expirationSeconds === undefined) sat.expirationSeconds = 3600;
    }
  }
  const scaleIO = obj(v.scaleIO);
  if (scaleIO) {
    if (str(scaleIO.storageMode) === '') scaleIO.storageMode = 'ThinProvisioned';
    if (str(scaleIO.fsType) === '') scaleIO.fsType = 'xfs';
  }
  const pvcSpec = obj(obj(obj(v.ephemeral)?.volumeClaimTemplate)?.spec);
  if (pvcSpec) {
    // SetDefaults_PersistentVolumeClaimSpec
    if (pvcSpec.volumeMode === undefined) pvcSpec.volumeMode = 'Filesystem';
    const res = obj(pvcSpec.resources);
    if (res) {
      defaultResourceList(res.limits);
      defaultResourceList(res.requests);
    }
  }
}

/** SetDefaults_PodSpec: the fields every PodSpec gets, in a Pod or in a template. */
function setDefaultsPodSpec(spec: JsonObject): void {
  // DeprecatedServiceAccount is an alias for ServiceAccountName, the latter winning.
  if (str(spec.serviceAccountName) === '') {
    if (str(spec.serviceAccount) !== '') spec.serviceAccountName = spec.serviceAccount as string;
  }
  if (str(spec.serviceAccountName) !== '') spec.serviceAccount = spec.serviceAccountName as string;
  else delete spec.serviceAccount;
  if (str(spec.dnsPolicy) === '') spec.dnsPolicy = 'ClusterFirst';
  if (str(spec.restartPolicy) === '') spec.restartPolicy = 'Always';
  if (!isObject(spec.securityContext)) spec.securityContext = {};
  if (typeof spec.terminationGracePeriodSeconds !== 'number') spec.terminationGracePeriodSeconds = 30;
  if (str(spec.schedulerName) === '') spec.schedulerName = 'default-scheduler';
}

/** The PodSpec part of SetObjectDefaults_Pod / _PodTemplate, after SetDefaults_Pod. */
export function defaultPodSpec(spec: JsonObject): void {
  setDefaultsPodSpec(spec);
  for (const v of objs(spec.volumes)) defaultVolume(v);
  for (const c of objs(spec.initContainers)) defaultContainerTree(c);
  for (const c of objs(spec.containers)) defaultContainerTree(c);
  for (const c of objs(spec.ephemeralContainers)) defaultContainerTree(c);
  defaultResourceList(spec.overhead);
  const res = obj(spec.resources);
  if (res) {
    defaultResourceList(res.limits);
    defaultResourceList(res.requests);
  }
}

/** SetObjectDefaults_PodTemplate's walk of a PodTemplateSpec (also the apps kinds' template). */
export function defaultPodTemplateSpec(t: JsonObject): void {
  if (!isObject(t.spec)) t.spec = {};
  defaultPodSpec(t.spec as JsonObject);
}

/** SetDefaults_Pod: what only a Pod gets, before its PodSpec defaults. */
function setDefaultsPod(pod: JsonObject): void {
  const spec = pod.spec as JsonObject;
  // Enforced on Pod but not on PodSpec.
  if (typeof spec.terminationGracePeriodSeconds === 'number' && spec.terminationGracePeriodSeconds < 0) spec.terminationGracePeriodSeconds = 1;
  // Requests default to limits; only on a Pod, never on a template.
  for (const list of ['containers', 'initContainers']) {
    for (const c of objs(spec[list])) {
      const res = obj(c.resources);
      const limits = obj(res?.limits);
      if (!res || !limits) continue;
      if (!isObject(res.requests)) res.requests = {};
      const requests = res.requests as JsonObject;
      for (const k of Object.keys(limits)) if (!(k in requests)) requests[k] = limits[k] as Json;
    }
  }
  if (typeof spec.enableServiceLinks !== 'boolean') spec.enableServiceLinks = true;
  if (spec.hostNetwork === true) {
    for (const list of ['containers', 'initContainers']) {
      for (const c of objs(spec[list])) {
        for (const p of objs(c.ports)) if (!p.hostPort) p.hostPort = typeof p.containerPort === 'number' ? p.containerPort : 0;
      }
    }
  }
}

/** SetDefaults_PodStatus: podIP and podIPs kept in sync. */
function setDefaultsPodStatus(status: JsonObject): void {
  const podIP = str(status.podIP);
  const ips = objs(status.podIPs);
  if (podIP !== '' && ips.length === 0) status.podIPs = [{ ip: podIP }];
  else if (podIP === '' && ips.length > 0) status.podIP = str(ips[0]?.ip);
  else if (podIP !== '' && ips.length > 0 && str(ips[0]?.ip) !== podIP) status.podIPs = [{ ip: podIP }];
}

/** SetObjectDefaults_Pod. */
export function defaultPod(pod: JsonObject): void {
  if (!isObject(pod.spec)) pod.spec = {};
  setDefaultsPod(pod);
  defaultPodSpec(pod.spec as JsonObject);
  const status = obj(pod.status);
  if (!status) return;
  setDefaultsPodStatus(status);
  for (const list of ['initContainerStatuses', 'containerStatuses', 'ephemeralContainerStatuses']) {
    for (const cs of objs(status[list])) {
      defaultResourceList(cs.allocatedResources);
      const r = obj(cs.resources);
      if (r) {
        defaultResourceList(r.limits);
        defaultResourceList(r.requests);
      }
    }
  }
  defaultResourceList(status.allocatedResources);
  const r = obj(status.resources);
  if (r) {
    defaultResourceList(r.limits);
    defaultResourceList(r.requests);
  }
}
