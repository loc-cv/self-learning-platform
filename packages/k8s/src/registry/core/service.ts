// Service. upstream: pkg/registry/core/service/strategy.go (namespaced; PrepareForCreate clears
// status; PrepareForUpdate keeps the old status and drops type-dependent fields; create on update
// and unconditional update allowed; SelectableFields adds spec.clusterIP and spec.type; the status
// strategy keeps the old spec), pkg/registry/core/service/storage/storage.go (ReturnDeletedObject;
// BeginCreate/BeginUpdate allocation, AfterDelete release, the read Decorator: see
// service-alloc.ts), pkg/apis/core/v1/conversion.go (Service field labels).
// Bootstrap: what kube-apiserver creates for Services when it starts:
// pkg/controlplane/controller/defaultservicecidr (the `kubernetes` ServiceCIDR from
// --service-cluster-ip-range, then its Ready condition), pkg/controlplane/controller/
// kubernetesservice (the `kubernetes` Service: ClusterIP = first address of the range, port https
// 443 → --secure-port, ipFamilyPolicy SingleStack), pkg/controlplane/reconcilers (lease.go,
// endpointsadapter.go: the Endpoints with the skip-mirror label, then the EndpointSlice made from
// it). Checked against the v1.37.2 oracle: GET endpoints/kubernetes and endpointslices/kubernetes
// right after start give exactly these objects.

import type { Ctx } from '@simlab/kernel';
import { cloneJson, isObject, type JsonObject } from '../../apimachinery/json.ts';
import type { ApiServerConfig } from '../../apiserver/config.ts';
import { handle } from '../../apiserver/pipeline.ts';
import type { Strategy } from '../../apiserver/types.ts';
import { setObjectDefaultsService } from '../../apis/core/v1/defaults/service.ts';
import { getWarningsForService, serviceStatusWarnings, validateServiceCreate, validateServiceStatusUpdate, validateServiceUpdate } from '../../apis/core/validation/service.ts';
import { objectMetaFields } from '../meta.ts';
import { commitCreate, commitUpdate, decoratedOld, needsClusterIP, needsNodePort, planCreate, planUpdate, releaseAllocated, specOf } from './service-alloc.ts';
import { firstServiceIP } from './service-ipallocator.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : []);

/** dropTypeDependentFields: fields the old type needed and the new one does not, when unchanged. */
function dropTypeDependentFields(svc: JsonObject, oldSvc: JsonObject): void {
  const spec = specOf(svc);
  const old = specOf(oldSvc);
  const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
  if (needsClusterIP(old) && !needsClusterIP(spec)) {
    if (str(old.clusterIP) === str(spec.clusterIP) && sameList(strs(old.clusterIPs), strs(spec.clusterIPs))) {
      delete spec.clusterIP;
      delete spec.clusterIPs;
    }
    if (sameList(strs(old.ipFamilies), strs(spec.ipFamilies)) && Array.isArray(old.ipFamilies) === Array.isArray(spec.ipFamilies)) delete spec.ipFamilies;
    if (str(old.ipFamilyPolicy) === str(spec.ipFamilyPolicy)) delete spec.ipFamilyPolicy;
  }
  const nodePorts = (sp: JsonObject): number[] => (Array.isArray(sp.ports) ? sp.ports.filter(isObject).map((p) => (typeof p.nodePort === 'number' ? p.nodePort : 0)).filter((n) => n !== 0) : []);
  if (needsNodePort(old) && !needsNodePort(spec)) {
    const oldSet = new Set(nodePorts(old));
    if (nodePorts(spec).every((n) => oldSet.has(n))) for (const p of Array.isArray(spec.ports) ? spec.ports : []) if (isObject(p)) delete p.nodePort;
  }
  const needsHC = (sp: JsonObject): boolean => str(sp.type) === 'LoadBalancer' && str(sp.externalTrafficPolicy) === 'Local';
  if (needsHC(old) && !needsHC(spec) && (old.healthCheckNodePort ?? 0) === (spec.healthCheckNodePort ?? 0)) delete spec.healthCheckNodePort;
  if (str(old.type) === 'LoadBalancer' && str(spec.type) !== 'LoadBalancer') {
    if (typeof spec.allocateLoadBalancerNodePorts === 'boolean' && spec.allocateLoadBalancerNodePorts === old.allocateLoadBalancerNodePorts) delete spec.allocateLoadBalancerNodePorts;
    // canSetLoadBalancerClass && !canSetLoadBalancerClass && sameLoadBalancerClass
    if ((old.loadBalancerClass ?? null) === (spec.loadBalancerClass ?? null)) delete spec.loadBalancerClass;
  }
  const accessible = (sp: JsonObject): boolean => {
    const t = str(sp.type);
    return t === 'LoadBalancer' || t === 'NodePort' || (t === 'ClusterIP' && strs(sp.externalIPs).length > 0);
  };
  if (accessible(old) && !accessible(spec) && str(old.externalTrafficPolicy) === str(spec.externalTrafficPolicy)) delete spec.externalTrafficPolicy;
  if (str(spec.type) !== 'LoadBalancer') {
    const status = isObject(svc.status) ? svc.status : {};
    status.loadBalancer = {};
    svc.status = status;
  }
}

function create(ctx: Ctx, server: ApiServerConfig, group: string, resource: string, namespace: string | undefined, body: JsonObject): JsonObject | undefined {
  const r = handle(ctx, server, { verb: 'create', group, version: 'v1', resource, ...(namespace ? { namespace } : {}), body });
  return r.ok ? (r.object as JsonObject) : undefined;
}

/** The objects kube-apiserver creates for Services when it starts in an empty store. */
function bootstrap(ctx: Ctx, server: ApiServerConfig): void {
  const advertise = server.advertiseAddress;
  const securePort = server.securePort;
  const cidrs = server.serviceClusterIPRange.split(',').map((c) => c.trim());
  // defaultservicecidr: create, then syncStatus applies Ready=True.
  const cidr = create(ctx, server, 'networking.k8s.io', 'servicecidrs', undefined, { apiVersion: 'networking.k8s.io/v1', kind: 'ServiceCIDR', metadata: { name: 'kubernetes' }, spec: { cidrs } });
  if (cidr) {
    const now = isObject(cidr.metadata) ? cidr.metadata.creationTimestamp : undefined;
    const withStatus = cloneJson(cidr);
    withStatus.status = { conditions: [{ type: 'Ready', status: 'True', lastTransitionTime: now ?? null, reason: '', message: 'Kubernetes default Service CIDR is ready' }] };
    handle(ctx, server, { verb: 'update', group: 'networking.k8s.io', version: 'v1', resource: 'servicecidrs', subresource: 'status', name: 'kubernetes', body: withStatus });
  }
  // kubernetesservice: CreateOrUpdateMasterServiceIfNeeded.
  const serviceIP = firstServiceIP(server.serviceClusterIPRange);
  create(ctx, server, '', 'services', 'default', {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'kubernetes', namespace: 'default', labels: { provider: 'kubernetes', component: 'apiserver' } },
    spec: {
      ports: [{ protocol: 'TCP', port: 443, name: 'https', targetPort: securePort }],
      ...(serviceIP ? { clusterIP: serviceIP } : {}),
      ipFamilyPolicy: 'SingleStack',
      sessionAffinity: 'None',
      type: 'ClusterIP',
    },
  });
  // The lease endpoint reconciler: Endpoints (skip-mirror), then EnsureEndpointSliceFromEndpoints.
  const ports = [{ name: 'https', port: securePort, protocol: 'TCP' }];
  create(ctx, server, '', 'endpoints', 'default', {
    apiVersion: 'v1',
    kind: 'Endpoints',
    metadata: { name: 'kubernetes', namespace: 'default', labels: { 'endpointslice.kubernetes.io/skip-mirror': 'true' } },
    subsets: [{ addresses: [{ ip: advertise }], ports }],
  });
  create(ctx, server, 'discovery.k8s.io', 'endpointslices', 'default', {
    apiVersion: 'discovery.k8s.io/v1',
    kind: 'EndpointSlice',
    metadata: { name: 'kubernetes', namespace: 'default', labels: { 'kubernetes.io/service-name': 'kubernetes' } },
    addressType: advertise.includes(':') ? 'IPv6' : 'IPv4',
    endpoints: [{ addresses: [advertise], conditions: { ready: true } }],
    ports,
  });
}

export const serviceStrategy: Strategy = {
  group: '',
  resource: 'services',
  kind: 'Service',
  storage: 'services',
  storageVersion: 'v1',
  defaults: (obj) => setObjectDefaultsService(obj),
  prepareForCreate(obj) {
    obj.status = {};
  },
  prepareForUpdate(obj, old, s) {
    obj.status = cloneJson(old.status ?? {});
    dropTypeDependentFields(obj, decoratedOld(old, s));
  },
  // BeginCreate's allocation (planned, see service-alloc.ts) and its errors come first, alone.
  validate(obj, s) {
    const errs = planCreate(obj, s);
    return errs.length > 0 ? errs : validateServiceCreate(obj);
  },
  validateUpdate(obj, old, s) {
    const o = decoratedOld(old, s);
    const errs = planUpdate(obj, o, s);
    return errs.length > 0 ? errs : validateServiceUpdate(obj, o);
  },
  warningsOnCreate: (obj) => getWarningsForService(obj),
  warningsOnUpdate: (obj, _old, s) => (s.request.subresource === 'status' ? serviceStatusWarnings(obj) : getWarningsForService(obj)),
  // The read Decorator drops internalTrafficPolicy of an ExternalName Service; dropping it before
  // the write gives the same reads.
  canonicalize(obj) {
    const spec = specOf(obj);
    if (str(spec.type) === 'ExternalName') delete spec.internalTrafficPolicy;
  },
  allowCreateOnUpdate: true,
  allowUnconditionalUpdate: true,
  returnDeletedObject: true,
  fields: (o) => {
    const spec = isObject(o.spec) ? o.spec : {};
    return { ...objectMetaFields(o, true), 'spec.clusterIP': str(spec.clusterIP), 'spec.type': str(spec.type) };
  },
  convertFieldLabel(label, value) {
    if (['metadata.namespace', 'metadata.name', 'spec.clusterIP', 'spec.type'].includes(label)) return { label, value };
    return { error: `field label not supported: ${label}` };
  },
  status: {
    prepareForUpdate(obj, old) {
      obj.spec = cloneJson(old.spec ?? {});
    },
    validateUpdate: (obj, old) => validateServiceStatusUpdate(obj, old),
  },
  beforePersist: (obj, s) => commitCreate(obj, s),
  beforePersistUpdate: (obj, old, s) => commitUpdate(obj, decoratedOld(old, s), s),
  afterDelete(obj, s) {
    releaseAllocated(decoratedOld(obj, s), s);
  },
  bootstrap,
};
