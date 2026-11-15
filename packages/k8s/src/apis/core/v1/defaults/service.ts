// Service defaulting.
// upstream: pkg/apis/core/v1/defaults.go SetDefaults_Service; zz_generated.defaults.go
// SetObjectDefaults_Service (SetDefaults_Service, then the protocol of every port again);
// pkg/api/service/util.go ExternallyAccessible, ExternalPolicyLocal, NeedsHealthCheck (not in the
// sparse checkout: checked against the v1.37.2 oracle: a ClusterIP Service with externalIPs gets
// externalTrafficPolicy Cluster, one without does not).

import { isObject, type Json, type JsonObject } from '../../../../apimachinery/json.ts';

/** v1.DefaultClientIPServiceAffinitySeconds (pkg/apis/core/types.go: 3 hours). */
export const DEFAULT_CLIENT_IP_SERVICE_AFFINITY_SECONDS = 10800;

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const specOf = (svc: JsonObject): JsonObject => {
  if (!isObject(svc.spec)) svc.spec = {};
  return svc.spec as JsonObject;
};

/** ExternallyAccessible: LoadBalancer, NodePort, or ClusterIP with external IPs. */
export function externallyAccessible(spec: JsonObject): boolean {
  const type = str(spec.type);
  return type === 'LoadBalancer' || type === 'NodePort' || (type === 'ClusterIP' && Array.isArray(spec.externalIPs) && spec.externalIPs.length > 0);
}

/** NeedsHealthCheck: a LoadBalancer whose external traffic policy is Local. */
export function needsHealthCheck(spec: JsonObject): boolean {
  if (str(spec.type) !== 'LoadBalancer') return false;
  return externallyAccessible(spec) && str(spec.externalTrafficPolicy) === 'Local';
}

/** SetObjectDefaults_Service. */
export function setObjectDefaultsService(svc: JsonObject): void {
  const spec = specOf(svc);
  if (str(spec.sessionAffinity) === '') spec.sessionAffinity = 'None';
  if (spec.sessionAffinity === 'None') delete spec.sessionAffinityConfig;
  if (spec.sessionAffinity === 'ClientIP') {
    const cfg = spec.sessionAffinityConfig;
    const clientIP = isObject(cfg) ? cfg.clientIP : undefined;
    const timeout = isObject(clientIP) ? clientIP.timeoutSeconds : undefined;
    if (timeout === undefined || timeout === null) spec.sessionAffinityConfig = { clientIP: { timeoutSeconds: DEFAULT_CLIENT_IP_SERVICE_AFFINITY_SECONDS } };
  }
  if (str(spec.type) === '') spec.type = 'ClusterIP';
  const ports = Array.isArray(spec.ports) ? spec.ports : [];
  for (const p of ports) {
    if (!isObject(p)) continue;
    if (str(p.protocol) === '') p.protocol = 'TCP';
    // intstr.FromInt32(0) or intstr.FromString(""): the port itself.
    if (p.targetPort === undefined || p.targetPort === null || p.targetPort === 0 || p.targetPort === '') p.targetPort = typeof p.port === 'number' ? p.port : 0;
  }
  if (externallyAccessible(spec) && str(spec.externalTrafficPolicy) === '') spec.externalTrafficPolicy = 'Cluster';
  const type = str(spec.type);
  if ((spec.internalTrafficPolicy === undefined || spec.internalTrafficPolicy === null) && (type === 'NodePort' || type === 'LoadBalancer' || type === 'ClusterIP')) {
    spec.internalTrafficPolicy = 'Cluster';
  }
  if (type === 'LoadBalancer' && (spec.allocateLoadBalancerNodePorts === undefined || spec.allocateLoadBalancerNodePorts === null)) spec.allocateLoadBalancerNodePorts = true;
  if (type === 'LoadBalancer') {
    const status = isObject(svc.status) ? svc.status : undefined;
    const lb = status && isObject(status.loadBalancer) ? status.loadBalancer : undefined;
    const ingress = lb && Array.isArray(lb.ingress) ? lb.ingress : [];
    for (const ing of ingress) {
      if (isObject(ing) && str(ing.ip) !== '' && (ing.ipMode === undefined || ing.ipMode === null)) ing.ipMode = 'VIP';
    }
  }
  // The generated SetObjectDefaults_Service defaults every port's protocol once more (a no-op now).
}
