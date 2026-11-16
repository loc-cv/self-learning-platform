// RealPodControl: how ReplicaSet-like controllers create, delete and patch Pods, and the events
// they record for it.
//
// upstream: pkg/controller/controller_utils.go (RealPodControl.CreatePods, createPods, DeletePod,
// PatchPod, GetPodFromTemplate, getPodsPrefix, validateControllerRef; the event reasons
// FailedCreatePodReason etc.)

import { cloneJson, isObject, type JsonObject } from '../apimachinery/json.ts';
import { isDNS1123Subdomain, maskTrailingDash } from '../apimachinery/validation/names.ts';
import type { ApiObject } from '../apiserver/store.ts';
import { apiError, isNamespaceTerminating, isNotFound, nameOf, plainError, stringMap, type ApiError } from './objects.ts';
import type { SyncCtx } from './types.ts';

export const FAILED_CREATE_POD_REASON = 'FailedCreate';
export const SUCCESSFUL_CREATE_POD_REASON = 'SuccessfulCreate';
export const FAILED_DELETE_POD_REASON = 'FailedDelete';
export const SUCCESSFUL_DELETE_POD_REASON = 'SuccessfulDelete';

/** getPodsPrefix: `<controller>-`, or the bare name when that is not a valid generateName (ValidatePodName with prefix). */
function getPodsPrefix(controllerName: string): string {
  const prefix = `${controllerName}-`;
  return isDNS1123Subdomain(maskTrailingDash(prefix)).length !== 0 ? controllerName : prefix;
}

/** validateControllerRef. */
function validateControllerRef(ref: JsonObject | undefined): string | undefined {
  if (!ref) return 'controllerRef is nil';
  if (!ref.apiVersion) return 'controllerRef has empty APIVersion';
  if (!ref.kind) return 'controllerRef has empty Kind';
  if (ref.controller !== true) return 'controllerRef.Controller is not set to true';
  if (ref.blockOwnerDeletion !== true) return 'controllerRef.BlockOwnerDeletion is not set';
  return undefined;
}

/**
 * GetPodFromTemplate: labels, annotations and finalizers copied from the template (empty ones are
 * dropped, as Go's omitempty drops empty maps and slices), generateName from the parent, the
 * controller reference, the template's spec.
 */
export function getPodFromTemplate(template: JsonObject, parent: ApiObject, controllerRef: JsonObject | undefined): JsonObject {
  const tmeta = isObject(template.metadata) ? template.metadata : {};
  const labels = stringMap(tmeta.labels);
  const annotations = stringMap(tmeta.annotations);
  const finalizers = Array.isArray(tmeta.finalizers) ? tmeta.finalizers.filter((f) => typeof f === 'string') : [];
  const metadata: JsonObject = { generateName: getPodsPrefix(nameOf(parent)) };
  if (Object.keys(labels).length > 0) metadata.labels = labels;
  if (Object.keys(annotations).length > 0) metadata.annotations = annotations;
  if (finalizers.length > 0) metadata.finalizers = finalizers;
  if (controllerRef) metadata.ownerReferences = [controllerRef];
  return { apiVersion: 'v1', kind: 'Pod', metadata, spec: isObject(template.spec) ? cloneJson(template.spec) : {} };
}

/**
 * RealPodControl.CreatePods: create a Pod from the template; record SuccessfulCreate, or
 * FailedCreate unless the namespace is terminating.
 */
export function createPods(c: SyncCtx, namespace: string, template: JsonObject, object: ApiObject, controllerRef: JsonObject): ApiError | undefined {
  const invalid = validateControllerRef(controllerRef);
  if (invalid) return plainError(invalid);
  const pod = getPodFromTemplate(template, object, controllerRef);
  if (!isObject((pod.metadata as JsonObject).labels)) return plainError('unable to create pods, no labels');
  const res = c.client.resource('v1/pods').create(namespace, pod);
  const err = apiError(res);
  if (err) {
    if (!isNamespaceTerminating(err)) c.event(object, 'Warning', FAILED_CREATE_POD_REASON, `Error creating: ${err.message}`);
    return err;
  }
  c.event(object, 'Normal', SUCCESSFUL_CREATE_POD_REASON, `Created pod: ${nameOf((res.ok ? res.object : {}) as ApiObject)}`);
  return undefined;
}

/** RealPodControl.DeletePod: delete with default options; NotFound is returned without an event. */
export function deletePod(c: SyncCtx, namespace: string, podID: string, object: ApiObject): ApiError | undefined {
  const err = apiError(c.client.resource('v1/pods').delete(namespace, podID));
  if (err) {
    if (isNotFound(err)) return err;
    c.event(object, 'Warning', FAILED_DELETE_POD_REASON, `Error deleting: ${err.message}`);
    return plainError(`unable to delete pods: ${err.message}`);
  }
  c.event(object, 'Normal', SUCCESSFUL_DELETE_POD_REASON, `Deleted pod: ${podID}`);
  return undefined;
}
