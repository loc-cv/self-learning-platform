// Accessors controllers use on stored objects (plain JSON in storage version), the owner
// reference helpers of metav1 (GetControllerOf, IsControlledBy, NewControllerRef), and API errors
// as a controller sees them (apierrors.IsNotFound, IsAlreadyExists, HasStatusCause).
//
// upstream: staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/controller_ref.go,
// staging/src/k8s.io/apimachinery/pkg/api/errors/errors.go

import type { Millis } from '@simlab/kernel';
import { isObject, type Json, type JsonObject } from '../apimachinery/json.ts';
import { parseTime } from '../apimachinery/time.ts';
import type { ApiObject } from '../apiserver/store.ts';
import type { ApiResponse } from '../apiserver/types.ts';

export const metaOf = (o: ApiObject): JsonObject => (isObject(o.metadata) ? o.metadata : {});
export const specOf = (o: ApiObject): JsonObject => (isObject(o.spec) ? o.spec : {});
export const statusOf = (o: ApiObject): JsonObject => (isObject(o.status) ? o.status : {});

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
export const nameOf = (o: ApiObject): string => str(metaOf(o).name);
export const namespaceOf = (o: ApiObject): string => str(metaOf(o).namespace);
export const uidOf = (o: ApiObject): string => str(metaOf(o).uid);
export const resourceVersionOf = (o: ApiObject): string => str(metaOf(o).resourceVersion);
export const generationOf = (o: ApiObject): number => num(metaOf(o).generation);
export const isDeleting = (o: ApiObject): boolean => typeof metaOf(o).deletionTimestamp === 'string';

/** A number field, 0 when absent (Go's zero value of an omitempty int). */
export function num(v: Json | undefined): number {
  return typeof v === 'number' ? v : 0;
}

/** A map[string]string field (labels, annotations); empty when absent. */
export function stringMap(v: Json | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObject(v)) for (const k of Object.keys(v)) if (typeof v[k] === 'string') out[k] = v[k];
  return out;
}

export const labelsOf = (o: ApiObject): Record<string, string> => stringMap(metaOf(o).labels);
export const annotationsOf = (o: ApiObject): Record<string, string> => stringMap(metaOf(o).annotations);

/** cache.MetaNamespaceKeyFunc: `namespace/name`. */
export const keyOf = (o: ApiObject): string => `${namespaceOf(o)}/${nameOf(o)}`;

/** cache.SplitMetaNamespaceKey for namespaced keys. */
export function splitKey(key: string): [string, string] {
  const i = key.indexOf('/');
  return i < 0 ? ['', key] : [key.slice(0, i), key.slice(i + 1)];
}

/** A metav1.Time (RFC 3339, whole seconds) in microseconds; undefined when absent or invalid (IsZero). */
export function timeMicros(v: Json | undefined): number | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  const r = parseTime(v, false);
  return 'micros' in r ? r.micros : undefined;
}

/** A metav1.Time in virtual milliseconds; 0 for the zero time. */
export const timeMillis = (v: Json | undefined): Millis => (timeMicros(v) ?? 0) / 1000;

export const creationMicros = (o: ApiObject): number => timeMicros(metaOf(o).creationTimestamp) ?? 0;

export interface OwnerReference {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  controller?: boolean;
  blockOwnerDeletion?: boolean;
}

/** metav1.GetControllerOf: the first owner reference with controller true. */
export function getControllerOf(o: ApiObject): OwnerReference | undefined {
  const refs = metaOf(o).ownerReferences;
  if (!Array.isArray(refs)) return undefined;
  for (const r of refs) if (isObject(r) && r.controller === true) return r as unknown as OwnerReference;
  return undefined;
}

/** metav1.IsControlledBy: the controller reference points at `owner`'s UID. */
export function isControlledBy(o: ApiObject, owner: ApiObject): boolean {
  const ref = getControllerOf(o);
  return ref !== undefined && ref.uid === uidOf(owner);
}

/** metav1.NewControllerRef: controller and blockOwnerDeletion true. */
export function newControllerRef(owner: ApiObject, apiVersion: string, kind: string): JsonObject {
  return { apiVersion, kind, name: nameOf(owner), uid: uidOf(owner), controller: true, blockOwnerDeletion: true };
}

/** A failed request as a controller holds it: the Go error's text, and what the apierrors helpers test. */
export interface ApiError {
  /** err.Error(): a StatusError's message. */
  message: string;
  code: number;
  reason: string;
  causes: string[];
}

export function apiError(res: ApiResponse): ApiError | undefined {
  if (res.ok) return undefined;
  if ('notSimulated' in res) return { message: res.notSimulated, code: 0, reason: 'NotSimulated', causes: [] };
  const causes = (res.status.details?.causes ?? []).map((c) => c.reason ?? '');
  return { message: res.status.message ?? '', code: res.code, reason: res.status.reason ?? '', causes };
}

/** An error the controller makes itself (fmt.Errorf). */
export const plainError = (message: string): ApiError => ({ message, code: 0, reason: '', causes: [] });

export const isNotFound = (e: ApiError | undefined): boolean => e?.reason === 'NotFound';
export const isAlreadyExists = (e: ApiError | undefined): boolean => e?.reason === 'AlreadyExists';
export const isInvalid = (e: ApiError | undefined): boolean => e?.reason === 'Invalid';
/** apierrors.HasStatusCause(err, v1.NamespaceTerminatingCause). */
export const isNamespaceTerminating = (e: ApiError | undefined): boolean => e?.causes.includes('NamespaceTerminating') ?? false;
