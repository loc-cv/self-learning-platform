// metav1.Status errors as the API server returns them.
// upstream: staging/src/k8s.io/apimachinery/pkg/api/errors/errors.go (NewNotFound, NewAlreadyExists,
// NewGenerateNameConflict, NewConflict, NewInvalid, NewBadRequest, NewForbidden, NewMethodNotSupported,
// NewResourceExpired, NewInternalError); GroupResource.String() and GroupKind.String() in
// apimachinery/pkg/runtime/schema/group_version.go. Wire shape and key order checked against
// fixtures/golden/v1.37.2/api/*.yaml.

import { aggregate, errorBody, errorString, type FieldError } from './field.ts';
import type { JsonObject } from './json.ts';

export interface StatusCause {
  reason: string;
  message: string;
  field: string;
}

export interface StatusDetails {
  name?: string;
  group?: string;
  kind?: string;
  uid?: string;
  causes?: StatusCause[];
  retryAfterSeconds?: number;
}

/** A metav1.Status of a failure. */
export interface Status {
  kind: 'Status';
  apiVersion: 'v1';
  metadata: Record<string, never>;
  status: 'Failure' | 'Success';
  message?: string;
  reason?: string;
  details?: StatusDetails;
  code?: number;
}

export interface GroupResource {
  group: string;
  resource: string;
}

export interface GroupKind {
  group: string;
  kind: string;
}

export const grString = (gr: GroupResource): string => (gr.group === '' ? gr.resource : `${gr.resource}.${gr.group}`);
export const gkString = (gk: GroupKind): string => (gk.group === '' ? gk.kind : `${gk.kind}.${gk.group}`);

function failure(code: number, reason: string, message: string, details?: StatusDetails): Status {
  // Key order of the wire form: kind, apiVersion, metadata, status, message, reason, details, code.
  return {
    kind: 'Status',
    apiVersion: 'v1',
    metadata: {},
    status: 'Failure',
    message,
    reason,
    ...(details ? { details } : {}),
    code,
  };
}

function details(name: string, group: string, kind: string, extra: Partial<StatusDetails> = {}): StatusDetails {
  const d: StatusDetails = {};
  if (name !== '') d.name = name;
  if (group !== '') d.group = group;
  if (kind !== '') d.kind = kind;
  return { ...d, ...extra };
}

const q = (s: string): string => JSON.stringify(s);

export function notFoundError(gr: GroupResource, name: string): Status {
  return failure(404, 'NotFound', `${grString(gr)} ${q(name)} not found`, details(name, gr.group, gr.resource));
}

export function alreadyExistsError(gr: GroupResource, name: string): Status {
  return failure(409, 'AlreadyExists', `${grString(gr)} ${q(name)} already exists`, details(name, gr.group, gr.resource));
}

export function generateNameConflictError(gr: GroupResource, name: string, retryAfterSeconds: number): Status {
  return failure(
    409,
    'AlreadyExists',
    `${grString(gr)} ${q(name)} already exists, the server was not able to generate a unique name for the object`,
    details(name, gr.group, gr.resource, { retryAfterSeconds }),
  );
}

/** upstream: staging/src/k8s.io/apiserver/pkg/registry/generic/registry/store.go OptimisticLockErrorMsg */
export const OPTIMISTIC_LOCK_ERROR = 'the object has been modified; please apply your changes to the latest version and try again';

export function conflictError(gr: GroupResource, name: string, err: string): Status {
  return failure(409, 'Conflict', `Operation cannot be fulfilled on ${grString(gr)} ${q(name)}: ${err}`, details(name, gr.group, gr.resource));
}

export function invalidError(gk: GroupKind, name: string, errs: readonly FieldError[]): Status {
  // The causes come out de-duplicated like the message: an update whose generic and per-kind
  // ObjectMeta checks both report a bad label shows it once (checked against the v1.37.2
  // oracle, 2026-11-16: PUT of a ConfigMap with an invalid label value; api/crud.yaml #32).
  const seen = new Set<string>();
  const causes: StatusCause[] = [];
  for (const e of errs) {
    const key = errorString(e);
    if (seen.has(key)) continue;
    seen.add(key);
    causes.push({ reason: e.type, message: errorBody(e), field: e.field });
  }
  const head = `${gkString(gk)} ${q(name)} is invalid`;
  return failure(422, 'Invalid', errs.length === 0 ? head : `${head}: ${aggregate(errs)}`, details(name, gk.group, gk.kind, causes.length > 0 ? { causes } : {}));
}

export function badRequestError(message: string): Status {
  return failure(400, 'BadRequest', message);
}

export function forbiddenError(gr: GroupResource, name: string, err: string, causes?: StatusCause[]): Status {
  const message =
    gr.group === '' && gr.resource === '' ? `forbidden: ${err}` : name === '' ? `${grString(gr)} is forbidden: ${err}` : `${grString(gr)} ${q(name)} is forbidden: ${err}`;
  return failure(403, 'Forbidden', message, details(name, gr.group, gr.resource, causes ? { causes } : {}));
}

export function methodNotSupportedError(gr: GroupResource, action: string): Status {
  return failure(405, 'MethodNotAllowed', `${action} is not supported on resources of kind ${q(grString(gr))}`, details('', gr.group, gr.resource));
}

export function resourceExpiredError(message: string): Status {
  return failure(410, 'Expired', message);
}

/**
 * responsewriters.ErrorToAPIStatus of an error that is not a Status (a plain Go error from deep
 * inside a handler): code 500, no reason (StatusReasonUnknown is empty, so omitted), the error's
 * text as the message.
 */
export function unknownStatusError(message: string): Status {
  return { kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message, code: 500 };
}

/**
 * errors.NewGenericServerResponse(code, "", GroupResource{}, "", serverMessage, 0, false) for 422
 * and 5xx, as interpretStrategicMergePatchError builds them: the server message is not shown.
 */
export function genericServerResponse(code: number, serverMessage: string): Status {
  if (code === 422) return failure(422, 'Invalid', 'the server rejected our request due to an error in our request', {});
  return failure(code, 'InternalError', `an error on the server (${q(serverMessage)}) has prevented the request from succeeding`, {});
}

export function internalError(err: string): Status {
  return failure(500, 'InternalError', `Internal error occurred: ${err}`, { causes: [{ reason: '', message: err, field: '' }] });
}

/**
 * The Status a delete returns for stores that do not return the deleted object
 * (upstream: store.go finalizeDelete): Success, no code, details with the plural resource.
 */
export function deleteSuccess(gr: GroupResource, name: string, uid: string): JsonObject {
  const d: JsonObject = { name };
  if (gr.group !== '') d.group = gr.group;
  d.kind = gr.resource;
  d.uid = uid;
  return { kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Success', details: d };
}
