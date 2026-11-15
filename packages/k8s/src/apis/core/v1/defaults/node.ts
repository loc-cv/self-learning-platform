// Node defaulting and the v1 ↔ internal conversion of the pod CIDR fields.
// upstream: pkg/apis/core/v1/zz_generated.defaults.go SetObjectDefaults_Node
// (SetDefaults_NodeStatus, then SetDefaults_ResourceList on capacity and allocatable),
// pkg/apis/core/v1/defaults.go SetDefaults_NodeStatus (allocatable copied from capacity when
// unset); pkg/apis/core/v1/conversion.go Convert_v1_NodeSpec_To_core_NodeSpec (the internal
// NodeSpec has only PodCIDRs: podCIDR fills it when podCIDRs is empty and replaces it when the
// two disagree) and Convert_core_NodeSpec_To_v1_NodeSpec (podCIDR = podCIDRs[0]). Checked
// against the v1.37.2 oracle: capacity {cpu: 1500u, pods: 10} comes back as cpu 2m in both
// capacity and allocatable.

import { cloneJson, isObject, type JsonObject } from '../../../../apimachinery/json.ts';
import { defaultResourceList } from './pod.ts';

/** SetObjectDefaults_Node. */
export function setObjectDefaultsNode(node: JsonObject): void {
  const status = isObject(node.status) ? node.status : undefined;
  if (!status) return;
  // SetDefaults_NodeStatus: a nil map is absent; an empty capacity map still counts as set.
  if (status.allocatable === undefined && isObject(status.capacity)) status.allocatable = cloneJson(status.capacity);
  defaultResourceList(status.capacity);
  defaultResourceList(status.allocatable);
}

/** Convert_v1_NodeSpec_To_core_NodeSpec, then back to v1. */
export function convertNodeSpecPodCIDRs(node: JsonObject): void {
  const spec = isObject(node.spec) ? node.spec : undefined;
  if (!spec) return;
  const podCIDR = typeof spec.podCIDR === 'string' ? spec.podCIDR : '';
  let podCIDRs = Array.isArray(spec.podCIDRs) ? spec.podCIDRs.map((c) => (typeof c === 'string' ? c : '')) : [];
  if (podCIDR !== '' && podCIDRs.length > 0 && podCIDR !== podCIDRs[0]) podCIDRs = [podCIDR];
  if (podCIDR !== '' && podCIDRs.length === 0) podCIDRs = [podCIDR];
  if (podCIDRs.length > 0) {
    spec.podCIDRs = podCIDRs;
    spec.podCIDR = podCIDRs[0] as string;
  } else {
    delete spec.podCIDR;
  }
}
