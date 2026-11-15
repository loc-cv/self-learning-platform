// Defaulting of apps/v1 Deployments and ReplicaSets on the versioned JSON.
// upstream: pkg/apis/apps/v1/defaults.go SetDefaults_Deployment, SetDefaults_ReplicaSet, and
// pkg/apis/apps/v1/zz_generated.defaults.go SetObjectDefaults_Deployment /
// SetObjectDefaults_ReplicaSet: the kind's own defaults, then the pod template's
// (SetDefaults_PodSpec and the walk below it, never SetDefaults_Pod).

import { isObject, type JsonObject } from '../../../apimachinery/json.ts';
import { defaultPodTemplateSpec } from '../../core/v1/defaults/pod.ts';

function spec(o: JsonObject): JsonObject {
  if (!isObject(o.spec)) o.spec = {};
  return o.spec as JsonObject;
}

function template(s: JsonObject): JsonObject {
  if (!isObject(s.template)) s.template = {};
  return s.template as JsonObject;
}

/** SetObjectDefaults_Deployment. */
export function defaultDeployment(d: JsonObject): void {
  const s = spec(d);
  if (typeof s.replicas !== 'number') s.replicas = 1;
  if (!isObject(s.strategy)) s.strategy = {};
  const strategy = s.strategy as JsonObject;
  if (typeof strategy.type !== 'string' || strategy.type === '') strategy.type = 'RollingUpdate';
  if (strategy.type === 'RollingUpdate') {
    if (!isObject(strategy.rollingUpdate)) strategy.rollingUpdate = {};
    const ru = strategy.rollingUpdate as JsonObject;
    if (ru.maxUnavailable === undefined || ru.maxUnavailable === null) ru.maxUnavailable = '25%';
    if (ru.maxSurge === undefined || ru.maxSurge === null) ru.maxSurge = '25%';
  }
  if (typeof s.revisionHistoryLimit !== 'number') s.revisionHistoryLimit = 10;
  if (typeof s.progressDeadlineSeconds !== 'number') s.progressDeadlineSeconds = 600;
  defaultPodTemplateSpec(template(s));
}

/** SetObjectDefaults_ReplicaSet. */
export function defaultReplicaSet(rs: JsonObject): void {
  const s = spec(rs);
  if (typeof s.replicas !== 'number') s.replicas = 1;
  defaultPodTemplateSpec(template(s));
}
