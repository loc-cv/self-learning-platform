// Topology hints on EndpointSlice endpoints: Service.spec.trafficDistribution (trafficdist) and
// the topology-mode annotation (topologycache).
// upstream: staging/src/k8s.io/endpointslice/trafficdist/trafficdist.go,
// topologycache/{topologycache.go,utils.go,event.go}, reconciler.go validTrafficDistribution.
//
// Topology Aware Routing (annotation `service.kubernetes.io/topology-mode: Auto`) is ported up to
// the topology cache's node check: when any ready, non-control-plane Node lacks a zone label or
// allocatable CPU, or the Nodes span fewer than two zones, upstream disables hints with a Warning
// event, as here. The proportional allocation across zones that follows is not ported: such a
// Service gets no hints, and a `sim.gap` trace and a gap record say so.

import type { JsonObject } from '../../apimachinery/json.ts';
import { isZero, parseQuantity } from '../../apimachinery/quantity.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import type { EventType, Reader } from '../types.ts';
import { metaOf, objs, specOf, statusOf, str, strMap } from './util.ts';

/** v1.DeprecatedAnnotationTopologyAwareHints and v1.AnnotationTopologyMode. */
export const ANNOTATION_TOPOLOGY_AWARE_HINTS = 'service.kubernetes.io/topology-aware-hints';
export const ANNOTATION_TOPOLOGY_MODE = 'service.kubernetes.io/topology-mode';
/** v1.LabelTopologyZone. */
export const LABEL_TOPOLOGY_ZONE = 'topology.kubernetes.io/zone';

// upstream: topologycache/event.go
export const INSUFFICIENT_NODE_INFO = 'Insufficient Node information: allocatable CPU or zone not specified on one or more nodes';
export const TOPOLOGY_AWARE_HINTS_DISABLED_REASON = 'TopologyAwareHintsDisabled';

export interface HintEvent {
  type: EventType;
  reason: string;
  message: string;
}

/** hintsEnabled: the deprecated annotation, else topology-mode, is `Auto` or `auto`. */
export function hintsEnabled(svc: ApiObject): boolean {
  const a = strMap(metaOf(svc).annotations);
  const val = a[ANNOTATION_TOPOLOGY_AWARE_HINTS] ?? a[ANNOTATION_TOPOLOGY_MODE];
  return val === 'Auto' || val === 'auto';
}

/**
 * validTrafficDistribution with PreferSameTrafficDistribution on (GA and locked in v1.35,
 * pkg/features/kube_features.go): PreferClose, PreferSameZone and PreferSameNode.
 */
export function validTrafficDistribution(svc: ApiObject): boolean {
  const td = specOf(svc).trafficDistribution;
  return td === 'PreferClose' || td === 'PreferSameZone' || td === 'PreferSameNode';
}

const endpointReady = (ep: JsonObject): boolean => (ep.conditions as JsonObject | undefined)?.ready === true;

/** RemoveHintsFromSlices: drops hints everywhere; unchanged slices that had some become updates. */
export function removeHintsFromSlices(toCreate: JsonObject[], toUpdate: JsonObject[], unchanged: JsonObject[]): void {
  for (const s of [...toCreate, ...toUpdate]) for (const ep of objs(s.endpoints)) delete ep.hints;
  for (const s of unchanged) {
    if (objs(s.endpoints).some((ep) => ep.hints !== undefined && ep.hints !== null)) {
      for (const ep of objs(s.endpoints)) delete ep.hints;
      toUpdate.push(s);
    }
  }
}

/**
 * trafficdist.ReconcileHints for a valid trafficDistribution (the preferClose heuristic; node
 * hints for PreferSameNode). Unchanged slices whose hints are out of date become updates.
 */
export function reconcileTrafficDistributionHints(svc: ApiObject, toCreate: JsonObject[], toUpdate: JsonObject[], unchanged: JsonObject[]): void {
  const nodeHints = specOf(svc).trafficDistribution === 'PreferSameNode';
  const needsUpdate = (slice: JsonObject): boolean => {
    for (const ep of objs(slice.endpoints)) {
      if (!endpointReady(ep)) continue;
      const hints = (ep.hints ?? null) as JsonObject | null;
      const zones = hints ? objs(hints.forZones) : [];
      const nodes = hints ? objs(hints.forNodes) : [];
      if (typeof ep.zone === 'string') {
        if (!hints || zones.length !== 1 || str(zones[0]?.name) !== ep.zone) return true;
      } else if (zones.length > 0) return true;
      if (typeof ep.nodeName === 'string' && nodeHints) {
        if (!hints || nodes.length !== 1 || str(nodes[0]?.name) !== ep.nodeName) return true;
      } else if (nodes.length > 0) return true;
    }
    return false;
  };
  const update = (slice: JsonObject): void => {
    for (const ep of objs(slice.endpoints)) {
      if (!endpointReady(ep)) continue;
      const forZones = typeof ep.zone === 'string' ? [{ name: ep.zone }] : undefined;
      const forNodes = typeof ep.nodeName === 'string' && nodeHints ? [{ name: ep.nodeName }] : undefined;
      if (forZones || forNodes) ep.hints = { ...(forZones ? { forZones } : {}), ...(forNodes ? { forNodes } : {}) };
      else delete ep.hints;
    }
  };
  for (const s of unchanged) if (needsUpdate(s)) toUpdate.push(s);
  for (const s of toCreate) update(s);
  for (const s of toUpdate) update(s);
}

/**
 * The topology cache's verdict on the Nodes (SetNodes, then getAllocations' first check):
 * `insufficient` when hints cannot be allocated at all, `sufficient` otherwise.
 */
export function topologyNodeInfo(read: Reader): 'insufficient' | 'sufficient' {
  const zones = new Set<string>();
  let totalCPU = false;
  for (const node of read.list('v1/nodes')) {
    const labels = strMap(metaOf(node).labels);
    if ('node-role.kubernetes.io/control-plane' in labels || 'node-role.kubernetes.io/master' in labels) continue;
    const ready = objs(statusOf(node).conditions).find((c) => c.type === 'Ready');
    if (ready?.status !== 'True') continue;
    const cpu = parseQuantity(str((statusOf(node).allocatable as JsonObject | undefined)?.cpu) || '0');
    const zone = labels[LABEL_TOPOLOGY_ZONE] ?? '';
    if (zone === '' || 'error' in cpu || isZero(cpu)) return 'insufficient';
    totalCPU = true;
    zones.add(zone);
  }
  return totalCPU && zones.size >= 2 ? 'sufficient' : 'insufficient';
}

/** FormatWithAddressType. */
export const formatWithAddressType = (s: string, addressType: string): string => `${s}, addressType: ${addressType}`;
