// pod.DropDisabledTemplateFields for the apps kinds: the template's spec gets what a Pod's gets.
// upstream: pkg/api/pod/util.go DropDisabledTemplateFields (not in the sparse checkout). Only the
// ContainerStopSignals gate (alpha, off in v1.37.2) is handled: lifecycle.stopSignal is dropped
// unless the old template used it, and a lifecycle left empty goes with it, as the v1.37.2 oracle
// does for Pods.

import { isObject, type Json, type JsonObject } from '../../apimachinery/json.ts';

const obj = (v: Json | undefined): JsonObject | undefined => (isObject(v) ? v : undefined);
const LISTS = ['initContainers', 'containers', 'ephemeralContainers'];

function containers(spec: JsonObject | undefined): JsonObject[] {
  return LISTS.flatMap((l) => (Array.isArray(spec?.[l]) ? (spec[l] as Json[]) : [])).filter(isObject);
}

/** Drops disabled fields from a PodSpec, unless `oldSpec` already used them. */
export function dropDisabledPodSpecFields(spec: JsonObject | undefined, oldSpec: JsonObject | undefined): void {
  if (containers(oldSpec).some((c) => obj(c.lifecycle)?.stopSignal !== undefined)) return;
  for (const c of containers(spec)) {
    const lc = obj(c.lifecycle);
    if (!lc || lc.stopSignal === undefined) continue;
    delete lc.stopSignal;
    if (lc.postStart === undefined && lc.preStop === undefined) delete c.lifecycle;
  }
}

/** DropDisabledTemplateFields on `spec.template.spec` of a Deployment or ReplicaSet. */
export function dropDisabledTemplateFields(o: JsonObject, old: JsonObject | undefined): void {
  const spec = obj(obj(obj(o.spec)?.template)?.spec);
  const oldSpec = old ? obj(obj(obj(old.spec)?.template)?.spec) : undefined;
  dropDisabledPodSpecFields(spec, oldSpec);
}
