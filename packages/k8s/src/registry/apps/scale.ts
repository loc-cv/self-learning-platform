// The scale subresource of Deployments and ReplicaSets: the autoscaling/v1 Scale of an object.
// upstream: pkg/registry/apps/deployment/storage/storage.go scaleFromDeployment,
// pkg/registry/apps/replicaset/storage/storage.go scaleFromReplicaSet (the same shape: name,
// namespace, uid, resourceVersion and creationTimestamp of the object, spec.replicas,
// status.replicas and the selector as a string), served in autoscaling/v1.

import { canonical } from '../../apimachinery/gojson.ts';
import { isObject, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { labelSelectorAsSelector, selectorString } from '../../apimachinery/labels.ts';
import { schema } from '../../openapi/schema.ts';

const obj = (v: Json | undefined): JsonObject => (isObject(v) ? v : {});

/** scaleFromDeployment / scaleFromReplicaSet on the versioned object. */
export function scaleOf(o: JsonObject): JsonObject {
  const m = obj(o.metadata);
  const spec = obj(o.spec);
  const status = obj(o.status);
  const sel = labelSelectorAsSelector(spec.selector ?? undefined);
  // upstream returns the conversion error; a stored object always has a valid selector.
  const selector = 'error' in sel ? '' : selectorString(sel);
  const meta: JsonObject = {};
  for (const k of ['name', 'namespace', 'uid', 'resourceVersion', 'creationTimestamp']) if (m[k] !== undefined) meta[k] = m[k] as Json;
  const scale: JsonObject = {
    kind: 'Scale',
    apiVersion: 'autoscaling/v1',
    metadata: meta,
    spec: { replicas: typeof spec.replicas === 'number' ? spec.replicas : 0 },
    status: { replicas: typeof status.replicas === 'number' ? status.replicas : 0, selector },
  };
  const t = schema().kind('autoscaling/v1', 'Scale');
  return t ? (canonical(scale, t.id) as JsonObject) : scale;
}
