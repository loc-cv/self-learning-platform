// The request pipeline (docs/ARCHITECTURE.md §4.2): every API access goes through `handle`.
// Stage order, verified against upstream v1.37.2:
//   create: decode (strict field checks) + defaults → wipe system fields → namespace check →
//     mutating admission → generateName → fill uid/creationTimestamp → PrepareForCreate →
//     Validate (+ path segment check) → warnings → Canonicalize → validating admission →
//     storage allocation → persist (AlreadyExists) → watch events.
//   update: decode + defaults → namespace check → name check → mutating admission → existence
//     and resourceVersion checks → BeforeUpdate (generation from old, PrepareForUpdate, system
//     fields from old, ObjectMeta update checks, ValidateUpdate) → validating admission →
//     delete-during-update or persist (no write when nothing changed).
//   patch: the current object merged with the patch, decoded and defaulted again, then the update
//     path. delete: BeforeDelete (grace), finalizers and propagation, then removal.
// upstream: staging/src/k8s.io/apiserver/pkg/endpoints/handlers/{create,update,patch,delete,get,
// watch,rest}.go; registry/rest/{create,update,delete,meta}.go; registry/generic/registry/store.go.
// Authentication and authorization are explicit no-op stages until phase 20a.

import { daysFromCivil, put, type Ctx } from '@simlab/kernel';
import { decode, canonical } from '../apimachinery/gojson.ts';
import {
  alreadyExistsError,
  badRequestError,
  conflictError,
  deleteSuccess,
  generateNameConflictError,
  genericServerResponse,
  invalidError,
  methodNotSupportedError,
  notFoundError,
  OPTIMISTIC_LOCK_ERROR,
  resourceExpiredError,
  unknownStatusError,
  type GroupKind,
  type Status,
} from '../apimachinery/errors.ts';
import { invalid, newPath, notSupported, type FieldError } from '../apimachinery/field.ts';
import { cloneJson, isObject, jsonEqual, type Json, type JsonObject } from '../apimachinery/json.ts';
import { mergePatch, mergePatchError } from '../apimachinery/mergepatch.ts';
import { applyJsonPatchRequest } from './jsonpatch.ts';
import { applyStrategicPatchInPlace } from '../apimachinery/strategicpatch/index.ts';
import { fromUnstructured } from '../apimachinery/converter.ts';
import { goSprint } from '../kubectl/printers/gofmt.ts';
import { generateName } from '../apimachinery/rand.ts';
import { timeOf } from '../apimachinery/time.ts';
import { isPathSegmentPrefix, isValidPathSegmentName } from '../apimachinery/validation/names.ts';
import { validateObjectMeta, validateObjectMetaUpdate } from '../apimachinery/validation/objectmeta.ts';
import { schema } from '../openapi/schema.ts';
import { registry, type ApiResource } from '../discovery/registry.ts';
import { admitAll, validateAll, type AdmissionAttributes } from './admission.ts';
import type { ApiServerConfig } from './config.ts';
import { compileSelectors, objectLabels } from './selectors.ts';
import { strategyFor } from './strategies.ts';
import {
  etcdData,
  historySince,
  objectKey,
  openSubscription,
  storeCreate,
  storeDelete,
  storeGet,
  storeList,
  storeUpdate,
  k8sSlice,
  takeEvents,
  type ApiObject,
  type EtcdData,
  type WatchEventType,
} from './store.ts';
import type { ApiRequest, ApiResponse, RequestOptions, Strategy, StrategyCtx } from './types.ts';
import { recordWarnings } from './warning.ts';
import { writeScale } from './scale.ts';
import { applyIncludeObject, convertToTable, type TableSource } from '../printers/tablegenerator.ts';

type Result<T> = { ok: T } | { status: Status };

const fail = (status: Status, warnings: string[] = []): ApiResponse => ({ ok: false, code: status.code ?? 500, status, warnings });
const okResponse = (code: number, object: Json, warnings: string[] = []): ApiResponse => ({ ok: true, code, object, warnings });
const gap = (what: string): ApiResponse => ({ ok: false, code: 0, notSimulated: what, warnings: [] });

const meta = (o: JsonObject): JsonObject => {
  if (!isObject(o.metadata)) o.metadata = {};
  return o.metadata as JsonObject;
};
const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');

interface Served {
  res: ApiResource;
  strategy: Strategy;
  s: StrategyCtx;
  etcd: EtcdData;
  server: ApiServerConfig;
  /** The API version of the request (`apps/v1`). */
  apiVersion: string;
  gr: { group: string; resource: string };
  gk: GroupKind;
  warnings: string[];
}

/** Handles one request against the API server `server`. Synchronous: one event, no latency. */
export function handle(ctx: Ctx, server: ApiServerConfig, req: ApiRequest): ApiResponse {
  const res = registry().get(req.group, req.version, req.resource, req.subresource);
  if (!res) return gap(`the ${req.group === '' ? '' : `${req.group}/`}${req.version} resource ${req.resource}${req.subresource ? `/${req.subresource}` : ''}`);
  const verbs = res.verbs;
  const listVerb = req.verb === 'list' || req.verb === 'watch' || req.verb === 'get';
  if (!verbs.includes(req.verb) && !(listVerb && req.subresource && req.verb === 'get')) {
    return fail(methodNotSupportedError({ group: req.group, resource: req.resource }, req.verb));
  }
  const strategy = strategyFor(req.group, req.resource);
  if (!strategy) return gap(`${req.resource}${req.group ? `.${req.group}` : ''}`);
  // The scale subresource: get, and update/patch through the main strategy (scale.ts).
  const binding = req.subresource === 'binding' && req.verb === 'create' && strategy.kind === 'Pod';
  // Subresources written through update with their own strategy (namespaces/finalize).
  const updateSub = req.subresource !== undefined && (req.verb === 'update' || req.verb === 'patch') && strategy.updateSubresources?.[req.subresource] !== undefined;
  if (req.subresource && req.subresource !== 'status' && !binding && !updateSub && !(req.subresource === 'scale' && strategy.scale && ['get', 'update', 'patch'].includes(req.verb))) {
    return gap(`the ${req.resource}/${req.subresource} subresource`);
  }
  // Authentication and authorization (phase 20a): every request is admitted as given.
  const etcd = etcdData(ctx, server.etcd);
  const apiVersion = req.group === '' ? req.version : `${req.group}/${req.version}`;
  const served: Served = {
    res: registry().get(req.group, req.version, req.resource) as ApiResource,
    strategy,
    etcd,
    server,
    apiVersion,
    gr: { group: req.group, resource: req.resource },
    gk: { group: strategy.internalGroup ?? strategy.group, kind: strategy.kind },
    warnings: [],
    s: {
      ctx,
      server,
      etcd,
      request: req,
      dryRun: req.options?.dryRun === true,
      now: () => timeOf(ctx.now),
      notPorted: (what) => ctx.gap({ kind: 'field', program: 'kube-apiserver', what, commandLine: '', machine: 'controlplane' }),
    },
  };
  const r = dispatch(served, req);
  // The deprecation warning is added first; the recorder dedupes and truncates (warning.ts).
  return { ...r, warnings: recordWarnings(strategy.deprecationWarning ? [strategy.deprecationWarning, ...r.warnings] : r.warnings) };
}

function dispatch(served: Served, req: ApiRequest): ApiResponse {
  if (req.subresource === 'binding') return bindPod(served, req);
  if (req.subresource === 'scale' && (req.verb === 'update' || req.verb === 'patch')) {
    const existing = storeGet(served.etcd, served.strategy.storage, objectKey(namespaceFor(served, req), req.name ?? ''));
    return writeScale(req, served.strategy, served.gr, { current: existing ? toResponse(served, existing) : undefined, update: (obj) => update(served, req, obj) });
  }
  switch (req.verb) {
    case 'get':
      return get(served, req);
    case 'list':
      return list(served, req);
    case 'create':
      return create(served, req);
    case 'update':
      return update(served, req, undefined);
    case 'patch':
      return patch(served, req);
    case 'delete':
      return del(served, req);
    case 'watch':
      return gap('watch through handle(); use openWatch');
  }
}

// ---- conversion between the request version and storage ----

/** The apiVersion objects of this strategy are stored in (`v1`, `apps/v1`). */
function storageApiVersionOf(st: Strategy): string {
  const group = st.storageGroup ?? st.group;
  return group === '' ? st.storageVersion : `${group}/${st.storageVersion}`;
}

function toResponse(sv: Served, stored: ApiObject): JsonObject {
  const st = sv.strategy;
  const version = sv.res.version;
  const converted = st.fromStorage && sv.apiVersion !== storageApiVersionOf(st) ? st.fromStorage(stored, version) : cloneJson(stored);
  converted.apiVersion = sv.apiVersion;
  converted.kind = st.kind;
  const t = schema().kind(sv.apiVersion, st.kind);
  return t ? (canonical(converted, t.id) as JsonObject) : converted;
}

function toStorage(sv: Served, obj: JsonObject): JsonObject {
  const st = sv.strategy;
  const version = sv.res.version;
  const storageApiVersion = storageApiVersionOf(st);
  const out = st.toStorage && sv.apiVersion !== storageApiVersion ? st.toStorage(obj, version) : obj;
  const t = schema().kind(storageApiVersion, st.kind);
  out.apiVersion = storageApiVersion;
  out.kind = st.kind;
  return t ? (canonical(out, t.id) as JsonObject) : out;
}

// ---- decoding ----

/** Decodes a body for this resource: type errors, strict field checking, defaulting. */
function decodeBody(sv: Served, body: Json | undefined, options: RequestOptions | undefined): Result<JsonObject> {
  const kind = sv.strategy.kind;
  const version = sv.res.version;
  if (!isObject(body)) return { status: badRequestError(`the object provided is unrecognized (must be of type ${kind}): couldn't get version/kind; json parse error: unexpected end of JSON input (<empty>)`) };
  const bodyKind = typeof body.kind === 'string' && body.kind !== '' ? body.kind : kind;
  const bodyVersion = typeof body.apiVersion === 'string' && body.apiVersion !== '' ? body.apiVersion : sv.apiVersion;
  const internalPkg = sv.strategy.group === '' ? 'core' : (sv.strategy.group.split('.')[0] as string);
  if (bodyKind !== kind) {
    const other = schema().kind(bodyVersion, bodyKind);
    const reason = other
      ? `converting (${other.display}) to (${internalPkg}.${kind}): unknown conversion`
      : `no kind ${JSON.stringify(bodyKind)} is registered for version ${JSON.stringify(bodyVersion)} in scheme "pkg/api/legacyscheme/scheme.go:30"`;
    return { status: badRequestError(`${bodyKind} in version ${JSON.stringify(version)} cannot be handled as a ${kind}: ${reason}`) };
  }
  if (bodyVersion !== sv.apiVersion) {
    if (!schema().kind(bodyVersion, bodyKind)) {
      return { status: badRequestError(`${kind} in version ${JSON.stringify(version)} cannot be handled as a ${kind}: no kind ${JSON.stringify(kind)} is registered for version ${JSON.stringify(bodyVersion)} in scheme "pkg/api/legacyscheme/scheme.go:30"`) };
    }
    return { status: badRequestError(`the API version in the data (${bodyVersion}) does not match the expected API version (${sv.apiVersion})`) };
  }
  const t = schema().kind(sv.apiVersion, kind);
  if (!t) throw new Error(`no schema for ${sv.apiVersion} ${kind}`);
  const r = decode(body, t.id);
  if (r.error !== undefined) return { status: badRequestError(`${kind} in version ${JSON.stringify(version)} cannot be handled as a ${kind}: ${r.error}`) };
  const convErr = isObject(r.value) ? sv.strategy.conversionError?.(r.value) : undefined;
  if (convErr !== undefined) return { status: badRequestError(`${kind} in version ${JSON.stringify(version)} cannot be handled as a ${kind}: ${convErr}`) };
  const mode = options?.fieldValidation ?? '';
  if (r.unknown.length > 0) {
    const items = r.unknown.map((p) => `unknown field ${JSON.stringify(p)}`);
    if (mode === 'Strict') return { status: badRequestError(`${kind} in version ${JSON.stringify(version)} cannot be handled as a ${kind}: strict decoding error: ${items.join(', ')}`) };
    if (mode !== 'Ignore') sv.warnings.push(...items);
  }
  const obj = canonical(r.value as Json, t.id) as JsonObject;
  obj.apiVersion = sv.apiVersion;
  obj.kind = kind;
  sv.strategy.defaults?.(obj, sv.s);
  return { ok: canonical(obj, t.id) as JsonObject };
}

/** ValidateCreateOptions / PatchOptions: fieldValidation's values (sorted, as sets.List does). */
function checkFieldValidation(options: RequestOptions | undefined, kind: 'CreateOptions' | 'UpdateOptions' | 'PatchOptions'): Status | undefined {
  const v = options?.fieldValidation;
  if (v === undefined || ['', 'Ignore', 'Strict', 'Warn'].includes(v)) return undefined;
  return invalidError({ group: 'meta.k8s.io', kind }, '', [notSupported(newPath('fieldValidation'), v, ['', 'Ignore', 'Strict', 'Warn'])]);
}

function namespaceFor(sv: Served, req: ApiRequest): string | undefined {
  return sv.res.namespaced ? req.namespace : undefined;
}

/** rest.EnsureObjectNamespaceMatchesRequestNamespace. */
function ensureNamespace(sv: Served, obj: JsonObject, requestNs: string | undefined): Status | undefined {
  const m = meta(obj);
  const objNs = str(m.namespace);
  if (!sv.res.namespaced) {
    delete m.namespace;
    return undefined;
  }
  if (objNs === '') {
    if (requestNs) m.namespace = requestNs;
    return undefined;
  }
  if (objNs === requestNs) return undefined;
  return badRequestError('the namespace of the provided object does not match the namespace sent on the request');
}

function admission(sv: Served, op: AdmissionAttributes['operation'], name: string, namespace: string | undefined, obj?: JsonObject, old?: JsonObject): AdmissionAttributes {
  return {
    operation: op,
    group: sv.gr.group,
    version: sv.res.version,
    resource: sv.gr.resource,
    ...(sv.s.request.subresource ? { subresource: sv.s.request.subresource } : {}),
    kind: sv.strategy.kind,
    ...(namespace ? { namespace } : {}),
    name,
    ...(obj ? { object: obj } : {}),
    ...(old ? { oldObject: old } : {}),
    dryRun: sv.s.dryRun,
  };
}

// ---- get, list ----

function get(sv: Served, req: ApiRequest): ApiResponse {
  const key = objectKey(namespaceFor(sv, req), req.name ?? '');
  const obj = storeGet(sv.etcd, sv.strategy.storage, key);
  if (!obj) return fail(notFoundError(sv.gr, req.name ?? ''));
  if (req.subresource === 'scale' && sv.strategy.scale) {
    const scale = sv.strategy.scale.get(toResponse(sv, obj));
    // The scale storage's ConvertToTable is the store's: printScale (printers.go AddHandlers).
    if (req.options?.as === 'Table') return tableResponse(sv, req, 'autoscaling', 'Scale', { object: scale }, (o) => o);
    return okResponse(200, scale);
  }
  if (req.options?.as === 'Table') return tableResponse(sv, req, printedGroup(sv.strategy), sv.strategy.kind, { object: obj }, (o) => toResponse(sv, o));
  return okResponse(200, toResponse(sv, obj));
}

function list(sv: Served, req: ApiRequest): ApiResponse {
  const sel = compileSelectors(sv.strategy, req.options?.labelSelector, req.options?.fieldSelector);
  if ('error' in sel) return fail(badRequestError(sel.error));
  const items = storeList(sv.etcd, sv.strategy.storage, namespaceFor(sv, req)).filter((o) => sel.matches(o));
  if (req.options?.as === 'Table') {
    return tableResponse(sv, req, printedGroup(sv.strategy), sv.strategy.kind, { items, resourceVersion: String(sv.etcd.revision) }, (o) => toResponse(sv, o));
  }
  const listKind = `${sv.strategy.kind}List`;
  return okResponse(200, {
    kind: listKind,
    apiVersion: sv.apiVersion,
    metadata: { resourceVersion: String(sv.etcd.revision) },
    // List items carry no apiVersion and kind of their own on the wire.
    items: items.map((o) => {
      const { apiVersion: _a, kind: _k, ...rest } = toResponse(sv, o);
      return rest;
    }),
  });
}

// ---- Table (as=Table) ----

/**
 * The group of the type printers see: the storage type's (events.k8s.io Events are core Events in
 * storage and in the internal API, pkg/registry/events/rest/storage_events.go).
 */
const printedGroup = (st: Strategy): string => st.storageGroup ?? st.group;

/**
 * The response of a get or list asking for a Table: the kind's TableConvertor over the stored
 * objects, then includeObject. upstream: apiserver/pkg/endpoints/handlers/response.go
 * transformResponseObject, doTransformObject, asTable.
 */
function tableResponse(sv: Served, req: ApiRequest, group: string, kind: string, src: TableSource, toVersioned: (o: JsonObject) => JsonObject): ApiResponse {
  const t = convertToTable(group, kind, src, { noHeaders: false, now: sv.s.ctx.now });
  const r = applyIncludeObject(t, req.options?.includeObject, toVersioned);
  if ('badRequest' in r) return fail(badRequestError(r.badRequest));
  return okResponse(200, r);
}

// ---- create ----

/** Fields a client may not set on create (rest.WipeObjectMetaSystemFields), and what storage resets. */
function wipeSystemFields(m: JsonObject): void {
  for (const k of ['creationTimestamp', 'uid', 'deletionTimestamp', 'deletionGracePeriodSeconds', 'selfLink', 'resourceVersion', 'generation', 'managedFields']) delete m[k];
}

function newUid(ctx: Ctx): string {
  // A random (version 4) UUID from a named stream. upstream: registry/rest/meta.go FillObjectMetaSystemFields
  const r = ctx.random('k8s.uid');
  const hex = (n: number) => Array.from({ length: n }, () => r.int(16).toString(16)).join('');
  const variant = (8 + r.int(4)).toString(16);
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

/** registry/rest/create.go validatePathSegment: the generic name rule of every kind. */
const validatePathSegment = (name: string, prefix: boolean): string[] => (prefix ? isPathSegmentPrefix(name) : isValidPathSegmentName(name));

function validationErrors(sv: Served, obj: JsonObject): FieldError[] {
  const errs = sv.strategy.validate(obj, sv.s);
  if (errs.length > 0) return errs;
  // registry/rest/create.go ValidateCreate: the generic ObjectMeta check only when the strategy found nothing.
  return validateObjectMeta(meta(obj), sv.res.namespaced, validatePathSegment, newPath('metadata'));
}

function create(sv: Served, req: ApiRequest): ApiResponse {
  const optErr = checkFieldValidation(req.options, 'CreateOptions');
  if (optErr) return fail(optErr);
  const decoded = decodeBody(sv, req.body, req.options);
  if ('status' in decoded) return fail(decoded.status);
  const obj = decoded.ok;
  const m = meta(obj);
  if (req.name && str(m.name) === '') m.name = req.name;
  const ns = namespaceFor(sv, req);
  if (sv.strategy.kind === 'Namespace' && sv.strategy.group === '') delete m.namespace;
  wipeSystemFields(m);
  const nsErr = ensureNamespace(sv, obj, ns);
  if (nsErr) return fail(nsErr, sv.warnings);
  const admitErr = admitAll(admission(sv, 'CREATE', str(m.name), ns, obj), sv.etcd);
  if (admitErr) return fail(admitErr, sv.warnings);
  const generated = str(m.generateName) !== '' && str(m.name) === '';
  // store.go createWithGenerateNameRetry: up to 8 attempts while the name is taken.
  for (let attempt = 1; ; attempt++) {
    const copy = cloneJson(obj);
    const r = createOnce(sv, copy, ns, generated);
    if (!('taken' in r)) return r;
    if (!generated) return fail(r.taken, sv.warnings);
    if (attempt >= 8) return fail(generateNameConflictError(sv.gr, r.name, 1), sv.warnings);
  }
}

/** One create attempt after admission: AlreadyExists comes back as `taken` for generateName retry. */
function createOnce(sv: Served, obj: JsonObject, ns: string | undefined, generated: boolean): ApiResponse | { taken: Status; name: string } {
  const m = meta(obj);
  m.uid = newUid(sv.s.ctx);
  m.creationTimestamp = sv.s.now();
  if (generated) m.name = generateName(sv.s.ctx, str(m.generateName));
  sv.strategy.prepareForCreate?.(obj, sv.s);
  const errs = validationErrors(sv, obj);
  if (errs.length > 0) return fail(invalidError(sv.gk, str(m.name), errs), sv.warnings);
  sv.warnings.push(...(sv.strategy.warningsOnCreate?.(obj, sv.s) ?? []));
  sv.strategy.canonicalize?.(obj);
  const valErr = validateAll(admission(sv, 'CREATE', str(m.name), ns, obj), sv.etcd);
  if (valErr) return fail(valErr, sv.warnings);
  const key = objectKey(ns, str(m.name));
  const existing = storeGet(sv.etcd, sv.strategy.storage, key);
  if (existing) {
    const err = alreadyExistsError(sv.gr, str(m.name));
    if (isObject(existing.metadata) && existing.metadata.deletionTimestamp) err.message = `object is being deleted: ${err.message as string}`;
    return { taken: err, name: str(m.name) };
  }
  const alloc = sv.strategy.beforePersist?.(obj, sv.s);
  if (alloc) return fail(Array.isArray(alloc) ? invalidError(sv.gk, str(m.name), alloc) : alloc, sv.warnings);
  const stored = toStorage(sv, obj);
  if (sv.s.dryRun) return okResponse(201, toResponse(sv, stored), sv.warnings);
  const written = storeCreate(sv.s.ctx, sv.server.etcd, sv.strategy.storage, key, stored);
  return okResponse(201, toResponse(sv, written), sv.warnings);
}

// ---- update and patch ----

/**
 * PUT. `merged` is set for a patch: the object the patch produced (already decoded), and the
 * patch path skips the body decoding and the create-on-update case.
 */
function update(sv: Served, req: ApiRequest, merged: JsonObject | undefined): ApiResponse {
  const status = req.subresource === 'status';
  // The update strategy of the subresource, when it has one (StatusStrategy, FinalizeStrategy).
  const sub = status ? sv.strategy.status : req.subresource !== undefined ? sv.strategy.updateSubresources?.[req.subresource] : undefined;
  const optErr = checkFieldValidation(req.options, merged ? 'PatchOptions' : 'UpdateOptions');
  if (optErr) return fail(optErr);
  let obj: JsonObject;
  if (merged) obj = merged;
  else {
    const decoded = decodeBody(sv, req.body, req.options);
    if ('status' in decoded) return fail(decoded.status);
    obj = decoded.ok;
  }
  const ns = namespaceFor(sv, req);
  const name = req.name ?? '';
  const nsErr = ensureNamespace(sv, obj, ns);
  if (nsErr) return fail(nsErr, sv.warnings);
  const m = meta(obj);
  if (str(m.name) !== name) return fail(badRequestError(`the name of the object (${str(m.name)}) does not match the name on the URL (${name})`), sv.warnings);
  const key = objectKey(ns, name);
  const existing = storeGet(sv.etcd, sv.strategy.storage, key);
  if (!existing) {
    if (merged || req.subresource !== undefined || !sv.strategy.allowCreateOnUpdate) return fail(notFoundError(sv.gr, name), sv.warnings);
    // Create on update: wipe and fill system fields, then the create path.
    const admitErr = admitAll(admission(sv, 'CREATE', name, ns, obj), sv.etcd);
    if (admitErr) return fail(admitErr, sv.warnings);
    wipeSystemFields(m);
    const r = createOnce(sv, obj, ns, false);
    return 'taken' in r ? fail(r.taken, sv.warnings) : r;
  }
  const old = toResponse(sv, existing);
  const oldMeta = old.metadata as JsonObject;
  // UID precondition from a PUT body (registry/rest/update.go defaultUpdatedObjectInfo.Preconditions);
  // a patch has none (patch.go: DefaultUpdatedObjectInfo(nil, …)), so its uid change is Invalid.
  if (!merged && str(m.uid) !== '' && str(m.uid) !== str(oldMeta.uid)) {
    return fail(
      conflictError(sv.gr, name, `StorageError: invalid object, Code: 4, Key: /registry/${sv.strategy.storage.split('.')[0] as string}/${key}, ResourceVersion: 0, AdditionalErrorMsg: Precondition failed: UID in precondition: ${str(m.uid)}, UID in object meta: ${str(oldMeta.uid)}`),
      sv.warnings,
    );
  }
  const admitErr = admitAll(admission(sv, 'UPDATE', name, ns, obj, old), sv.etcd);
  if (admitErr) return fail(admitErr, sv.warnings);
  // store.go Update: an empty resourceVersion is unconditional where the strategy allows it.
  const rv = str(m.resourceVersion);
  if (rv === '') {
    if (!sv.strategy.allowUnconditionalUpdate) {
      return fail(invalidError({ group: sv.gr.group, kind: sv.gr.resource }, name, [invalid(newPath('metadata', 'resourceVersion'), 0, 'must be specified for an update')]), sv.warnings);
    }
    m.resourceVersion = str(oldMeta.resourceVersion);
  } else if (rv !== str(oldMeta.resourceVersion)) {
    return fail(conflictError(sv.gr, name, OPTIMISTIC_LOCK_ERROR), sv.warnings);
  }
  // rest.BeforeUpdate.
  if (oldMeta.generation !== undefined) m.generation = oldMeta.generation;
  else delete m.generation;
  if (sub) sub.prepareForUpdate(obj, old, sv.s);
  else sv.strategy.prepareForUpdate?.(obj, old, sv.s);
  if (str(m.uid) === '') m.uid = oldMeta.uid as Json;
  if (oldMeta.creationTimestamp) m.creationTimestamp = oldMeta.creationTimestamp;
  if (oldMeta.deletionTimestamp) m.deletionTimestamp = oldMeta.deletionTimestamp;
  if (oldMeta.deletionGracePeriodSeconds !== undefined && m.deletionGracePeriodSeconds === undefined) m.deletionGracePeriodSeconds = oldMeta.deletionGracePeriodSeconds;
  delete m.managedFields;
  // registry/rest/update.go validateCommonFields, then the strategy's ValidateUpdate (which repeats
  // the ObjectMeta checks: causes keep the repeats, the message drops them).
  const errs = [
    ...validateObjectMeta(m, sv.res.namespaced, validatePathSegment, newPath('metadata')),
    ...validateObjectMetaUpdate(m, oldMeta, newPath('metadata')),
    ...(sub ? sub.validateUpdate(obj, old, sv.s) : sv.strategy.validateUpdate(obj, old, sv.s)),
  ];
  if (errs.length > 0) return fail(invalidError(sv.gk, name, errs), sv.warnings);
  // A subresource has its own strategy, whose WarningsOnUpdate is usually empty.
  const warn = sub ? sub.warningsOnUpdate : sv.strategy.warningsOnUpdate;
  sv.warnings.push(...(warn?.(obj, old, sv.s) ?? []));
  sv.strategy.canonicalize?.(obj);
  const valErr = validateAll(admission(sv, 'UPDATE', name, ns, obj, old), sv.etcd);
  if (valErr) return fail(valErr, sv.warnings);
  // store.go ShouldDeleteDuringUpdate: the last finalizer of an object being deleted with no grace left.
  const finalizers = Array.isArray(m.finalizers) ? m.finalizers : [];
  const oldGrace = oldMeta.deletionGracePeriodSeconds;
  if (finalizers.length === 0 && oldMeta.deletionTimestamp && (oldGrace === undefined || oldGrace === 0) && (sv.strategy.deleteDuringUpdate?.(obj) ?? true)) {
    if (!sv.s.dryRun) {
      storeDelete(sv.s.ctx, sv.server.etcd, sv.strategy.storage, key);
      sv.strategy.afterDelete?.(existing, sv.s);
    }
    return okResponse(200, toResponse(sv, toStorage(sv, obj)), sv.warnings);
  }
  const alloc = sv.strategy.beforePersistUpdate?.(obj, existing, sv.s);
  if (alloc) return fail(Array.isArray(alloc) ? invalidError(sv.gk, name, alloc) : alloc, sv.warnings);
  const stored = toStorage(sv, obj);
  // No write when the object did not change: same resourceVersion, no watch event.
  if (jsonEqual(stored, existing)) return okResponse(200, toResponse(sv, existing), sv.warnings);
  if (sv.s.dryRun) return okResponse(200, toResponse(sv, stored), sv.warnings);
  const written = storeUpdate(sv.s.ctx, sv.server.etcd, sv.strategy.storage, key, stored);
  return okResponse(200, toResponse(sv, written), sv.warnings);
}

function patch(sv: Served, req: ApiRequest): ApiResponse {
  const type = req.options?.patchType ?? 'merge';
  if (type === 'strategic') return strategicPatch(sv, req);
  if (type !== 'merge' && type !== 'json') return gap(`${type} patches (only JSON, JSON merge and strategic merge patches are simulated so far)`);
  const optErr = checkFieldValidation(req.options, 'PatchOptions');
  if (optErr) return fail(optErr);
  // patch.go: json-patch v4 refuses a merge patch that is not an object or array.
  const patchErr = req.body === undefined ? 'invalid JSON patch' : type === 'json' ? null : mergePatchError(req.body);
  if (patchErr !== null) return fail(badRequestError(patchErr));
  const ns = namespaceFor(sv, req);
  const name = req.name ?? '';
  const existing = storeGet(sv.etcd, sv.strategy.storage, objectKey(ns, name));
  if (!existing) return fail(notFoundError(sv.gr, name));
  const current = toResponse(sv, existing);
  // A JSON patch (jsonpatch.ts) and its operations' strict decoding errors, or a merge patch.
  let mergedJson: Json;
  let strict: string[] = [];
  if (type === 'json') {
    const jp = applyJsonPatchRequest(current, req.body as Json, req.options?.fieldValidation ?? '');
    if ('gap' in jp) return gap(jp.gap);
    if ('status' in jp) return fail(jp.status);
    ({ ok: mergedJson, strict } = jp);
  } else mergedJson = mergePatch(current, req.body as Json);
  const t = schema().kind(sv.apiVersion, sv.strategy.kind);
  if (!t) throw new Error(`no schema for ${sv.apiVersion}`);
  if (!isObject(mergedJson)) return fail(badRequestError('invalid JSON patch'));
  // patch.go applyPatchToCurrentObject: the merged JSON is decoded (and defaulted) like a body; a
  // decoding failure is Invalid on the field `patch`, with the whole merged JSON as the value.
  const r = decode(mergedJson, t.id);
  const patchInvalid = (detail: string) => invalidError({ group: '', kind: '' }, '', [invalid(newPath('patch'), JSON.stringify(mergedJson), detail)]);
  if (r.error !== undefined) return fail(patchInvalid(r.error));
  const convErr = isObject(r.value) ? sv.strategy.conversionError?.(r.value) : undefined;
  if (convErr !== undefined) return fail(patchInvalid(convErr));
  if (strict.length + r.unknown.length > 0) {
    const items = [...strict, ...r.unknown.map((p) => `unknown field ${JSON.stringify(p)}`)];
    const mode = req.options?.fieldValidation ?? '';
    if (mode === 'Strict') return fail(patchInvalid(`strict decoding error: ${items.join(', ')}`));
    if (mode !== 'Ignore') sv.warnings.push(...items);
  }
  const obj = canonical(r.value as Json, t.id) as JsonObject;
  obj.apiVersion = sv.apiVersion;
  obj.kind = sv.strategy.kind;
  sv.strategy.defaults?.(obj, sv.s);
  return update(sv, req, canonical(obj, t.id) as JsonObject);
}

/** jsonKind of a value encoding/json cannot unmarshal into a map: its UnmarshalTypeError Value. */
function jsonValueKind(v: Json): string {
  return Array.isArray(v) ? 'array' : typeof v === 'boolean' ? 'bool' : typeof v;
}

/**
 * A strategic merge patch (application/strategic-merge-patch+json), as smpPatcher applies it.
 * upstream: staging/src/k8s.io/apiserver/pkg/endpoints/handlers/patch.go (validateAndTranscodePatch,
 * smpPatcher.applyPatchToCurrentObject, strategicPatchObject, applyPatchToObject,
 * interpretStrategicMergePatchError). The current object as a map, the patch decoded into
 * map[string]interface{}, StrategicMergeMapPatch, then the unstructured converter into the Go type
 * (its errors and sorted unknown fields, apimachinery/converter.ts); a failure is Invalid on the
 * field `patch` with the patch map, as the merge left it, printed by %+v.
 */
function strategicPatch(sv: Served, req: ApiRequest): ApiResponse {
  const optErr = checkFieldValidation(req.options, 'PatchOptions');
  if (optErr) return fail(optErr);
  // validateAndTranscodePatch: json.Valid.
  if (req.body === undefined) return fail(badRequestError('invalid JSON patch'));
  const ns = namespaceFor(sv, req);
  const name = req.name ?? '';
  const existing = storeGet(sv.etcd, sv.strategy.storage, objectKey(ns, name));
  // smpPatcher.createNewObject: a strategic merge patch never creates.
  if (!existing) return fail(notFoundError(sv.gr, name));
  const t = schema().kind(sv.apiVersion, sv.strategy.kind);
  if (!t) throw new Error(`no schema for ${sv.apiVersion}`);
  // kjson.UnmarshalStrict / UnmarshalCaseSensitivePreserveInts into map[string]interface{}: a
  // JSON null leaves the map empty. (Duplicate keys, the one strict error a map can have, cannot
  // reach the simulator: clients send values.)
  if (req.body !== null && !isObject(req.body)) return fail(badRequestError(`json: cannot unmarshal ${jsonValueKind(req.body)} into Go value of type map[string]interface {}`));
  const patchMap: JsonObject = req.body === null ? {} : cloneJson(req.body);
  const merged = applyStrategicPatchInPlace(cloneJson(toResponse(sv, existing)), patchMap, t.id);
  if ('error' in merged) {
    switch (merged.sentinel) {
      case 'ErrBadJSONDoc':
      case 'ErrBadPatchFormatForPrimitiveList':
      case 'ErrBadPatchFormatForRetainKeys':
      case 'ErrBadPatchFormatForSetElementOrderList':
      case 'ErrUnsupportedStrategicMergePatchFormat':
        return fail(badRequestError(merged.error));
      case 'ErrNoListOfLists':
      case 'ErrPatchContentNotMatchRetainKeys':
        return fail(genericServerResponse(422, merged.error));
      default:
        return fail(unknownStatusError(merged.error));
    }
  }
  // handlers/rest.go fieldValidation: no directive is Warn.
  const mode = req.options?.fieldValidation || 'Warn';
  const conv = fromUnstructured(merged.ok, t.id, mode === 'Warn' || mode === 'Strict');
  const patchInvalid = (detail: string) => invalidError({ group: '', kind: '' }, '', [invalid(newPath('patch'), goSprint(patchMap), detail)]);
  if (conv.error !== undefined) return fail(patchInvalid(conv.error));
  if (conv.unknown.length > 0) {
    if (mode === 'Strict') return fail(patchInvalid(`strict decoding error: ${conv.unknown.join(', ')}`));
    sv.warnings.push(...conv.unknown);
  }
  // smpPatcher: ConvertToVersion to the hub version; its error is a plain one.
  const convErr = isObject(conv.value) ? sv.strategy.conversionError?.(conv.value) : undefined;
  if (convErr !== undefined) return fail(unknownStatusError(convErr), sv.warnings);
  const obj = canonical(conv.value as Json, t.id) as JsonObject;
  obj.apiVersion = sv.apiVersion;
  obj.kind = sv.strategy.kind;
  sv.strategy.defaults?.(obj, sv.s);
  return update(sv, req, canonical(obj, t.id) as JsonObject);
}

// ---- delete ----

interface DeleteOptions {
  gracePeriodSeconds?: number;
  propagationPolicy?: string;
  orphanDependents?: boolean;
  preconditions?: { uid?: string; resourceVersion?: string };
}

function validateDeleteOptions(o: DeleteOptions): Status | undefined {
  const errs: FieldError[] = [];
  if (o.orphanDependents !== undefined && o.propagationPolicy !== undefined) {
    errs.push(invalid(newPath('propagationPolicy'), o.propagationPolicy, 'orphanDependents and deletionPropagation cannot be both set'));
  }
  if (o.propagationPolicy !== undefined && !['Foreground', 'Background', 'Orphan'].includes(o.propagationPolicy)) {
    errs.push(notSupported(newPath('propagationPolicy'), o.propagationPolicy, ['Foreground', 'Background', 'Orphan', 'nil']));
  }
  return errs.length > 0 ? invalidError({ group: 'meta.k8s.io', kind: 'DeleteOptions' }, '', errs) : undefined;
}

/** store.go shouldOrphanDependents / shouldDeleteDependentsInForeground. */
function gcFinalizers(st: Strategy, o: DeleteOptions, finalizers: string[]): { orphan: boolean; foreground: boolean } {
  if (st.gcPolicy === 'Unsupported') return { orphan: false, foreground: false };
  let orphan: boolean;
  if (o.orphanDependents !== undefined) orphan = o.orphanDependents;
  else if (o.propagationPolicy !== undefined) orphan = o.propagationPolicy === 'Orphan';
  else if (finalizers.includes('orphan')) orphan = true;
  else if (finalizers.includes('foregroundDeletion')) orphan = false;
  else orphan = st.gcPolicy === 'OrphanDependents';
  let foreground: boolean;
  if (o.orphanDependents !== undefined) foreground = false;
  else if (o.propagationPolicy !== undefined) foreground = o.propagationPolicy === 'Foreground';
  else foreground = finalizers.includes('foregroundDeletion');
  return { orphan, foreground };
}

const timePlus = (sv: Served, seconds: number): string => timeOf(sv.s.ctx.now + seconds * 1000);

function finalizeDelete(sv: Served, obj: ApiObject): Json {
  if (sv.strategy.returnDeletedObject) return toResponse(sv, obj);
  return deleteSuccess(sv.gr, str((obj.metadata as JsonObject).name), str((obj.metadata as JsonObject).uid));
}

function del(sv: Served, req: ApiRequest): ApiResponse {
  const o: DeleteOptions = {
    ...(req.options?.gracePeriodSeconds !== undefined ? { gracePeriodSeconds: req.options.gracePeriodSeconds } : {}),
    ...(req.options?.propagationPolicy !== undefined ? { propagationPolicy: req.options.propagationPolicy } : {}),
    ...(req.options?.orphanDependents !== undefined ? { orphanDependents: req.options.orphanDependents } : {}),
    ...(req.options?.preconditions ? { preconditions: req.options.preconditions } : {}),
  };
  const optErr = validateDeleteOptions(o);
  if (optErr) return fail(optErr);
  const ns = namespaceFor(sv, req);
  const name = req.name ?? '';
  const key = objectKey(ns, name);
  const existing = storeGet(sv.etcd, sv.strategy.storage, key);
  if (!existing) return fail(notFoundError(sv.gr, name));
  const admitErr = admitAll(admission(sv, 'DELETE', name, ns, undefined, toResponse(sv, existing)), sv.etcd);
  if (admitErr) return fail(admitErr);
  if (sv.strategy.deleteHook) {
    const custom = sv.strategy.deleteHook(existing, sv.s, (obj) => persistDeleting(sv, key, obj));
    if (custom) return custom.ok ? okResponse(custom.code, toResponse(sv, custom.object as ApiObject), custom.warnings) : custom;
  }
  const em = existing.metadata as JsonObject;
  // Preconditions (registry/rest/delete.go BeforeDelete): the Conflict names the Kind.
  const kindGr = { group: sv.strategy.group, resource: sv.strategy.kind };
  if (o.preconditions?.uid !== undefined && o.preconditions.uid !== str(em.uid)) {
    return fail(conflictError(kindGr, name, `the UID in the precondition (${o.preconditions.uid}) does not match the UID in record (${str(em.uid)}). The object might have been deleted and then recreated`));
  }
  if (o.preconditions?.resourceVersion !== undefined && o.preconditions.resourceVersion !== str(em.resourceVersion)) {
    return fail(conflictError(kindGr, name, `the ResourceVersion in the precondition (${o.preconditions.resourceVersion}) does not match the ResourceVersion in record (${str(em.resourceVersion)}). The object might have been modified`));
  }
  const obj = cloneJson(existing);
  const m = meta(obj);
  let grace = o.gracePeriodSeconds;
  if (grace !== undefined && grace < 0) grace = 1;
  // BeforeDelete: graceful, pending.
  let graceful = false;
  let pending = false;
  if (m.deletionTimestamp) {
    const stored = typeof m.deletionGracePeriodSeconds === 'number' ? (m.deletionGracePeriodSeconds < 0 ? 1 : m.deletionGracePeriodSeconds) : undefined;
    if (stored === undefined || stored === 0) {
      graceful = false;
    } else if (grace === undefined || grace >= stored) {
      pending = true;
    } else {
      // A shorter grace period moves the deadline earlier, never before now.
      const oldTs = parseSeconds(str(m.deletionTimestamp));
      let ts = oldTs - stored + grace;
      const nowS = Math.floor(sv.s.ctx.now / 1000);
      let g = grace;
      if (ts < nowS) {
        ts = nowS;
        if (g !== 0) g = 1;
      }
      m.deletionTimestamp = timeOf(ts * 1000);
      m.deletionGracePeriodSeconds = g;
      graceful = true;
    }
  } else if (sv.strategy.gracePeriod) {
    const g = sv.strategy.gracePeriod(existing, grace);
    if (g !== undefined) {
      m.deletionTimestamp = timePlus(sv, g);
      m.deletionGracePeriodSeconds = g;
      if (typeof m.generation === 'number' && m.generation > 0) m.generation += 1;
      graceful = true;
    }
  }
  if (pending) return okResponse(200, finalizeDelete(sv, existing));
  const finalizers = Array.isArray(m.finalizers) ? (m.finalizers as string[]) : [];
  const gc = gcFinalizers(sv.strategy, o, finalizers);
  const wantOrphan = gc.orphan;
  const wantForeground = gc.foreground;
  const hasGc = finalizers.includes('orphan') || finalizers.includes('foregroundDeletion');
  const shouldUpdateFinalizers = wantOrphan !== finalizers.includes('orphan') || wantForeground !== finalizers.includes('foregroundDeletion');
  const pendingFinalizers = finalizers.length > 0;
  if (graceful || pendingFinalizers || shouldUpdateFinalizers) {
    if (shouldUpdateFinalizers || hasGc) {
      const rest = finalizers.filter((f) => f !== 'orphan' && f !== 'foregroundDeletion');
      if (wantOrphan) rest.push('orphan');
      if (wantForeground) rest.push('foregroundDeletion');
      if (rest.length > 0) m.finalizers = rest;
      else delete m.finalizers;
    }
    const nowFinalizers = Array.isArray(m.finalizers) ? m.finalizers : [];
    if (!graceful) {
      if (nowFinalizers.length === 0) return deleteNow(sv, key, existing);
      // markAsDeleting.
      if (!m.deletionTimestamp && typeof m.generation === 'number' && m.generation > 0) m.generation += 1;
      if (!m.deletionTimestamp || parseSeconds(str(m.deletionTimestamp)) > Math.floor(sv.s.ctx.now / 1000)) m.deletionTimestamp = sv.s.now();
      m.deletionGracePeriodSeconds = 0;
    }
    if (nowFinalizers.length === 0 && m.deletionGracePeriodSeconds === 0) {
      // Graceful with nothing left to wait for: stored as deleting, then removed (an unbound Pod).
      const written = persistDeleting(sv, key, obj);
      if (sv.s.dryRun) return okResponse(200, toResponse(sv, written));
      storeDelete(sv.s.ctx, sv.server.etcd, sv.strategy.storage, key);
      sv.strategy.afterDelete?.(written, sv.s);
      return okResponse(200, finalizeDelete(sv, written));
    }
    const written = persistDeleting(sv, key, obj);
    return okResponse(200, toResponse(sv, written));
  }
  return deleteNow(sv, key, existing);
}

function persistDeleting(sv: Served, key: string, obj: JsonObject): ApiObject {
  const stored = canonicalStored(sv, obj);
  const existing = storeGet(sv.etcd, sv.strategy.storage, key);
  if (existing && jsonEqual(stored, existing)) return existing;
  if (sv.s.dryRun) return stored;
  return storeUpdate(sv.s.ctx, sv.server.etcd, sv.strategy.storage, key, stored);
}

function canonicalStored(sv: Served, obj: JsonObject): ApiObject {
  const t = schema().kind(storageApiVersionOf(sv.strategy), sv.strategy.kind);
  return t ? (canonical(obj, t.id) as JsonObject) : obj;
}

function deleteNow(sv: Served, key: string, existing: ApiObject): ApiResponse {
  if (sv.s.dryRun) return okResponse(200, finalizeDelete(sv, existing));
  storeDelete(sv.s.ctx, sv.server.etcd, sv.strategy.storage, key);
  sv.strategy.afterDelete?.(existing, sv.s);
  return okResponse(200, finalizeDelete(sv, existing));
}

/** Seconds since the epoch of a metav1.Time string written by this server. */
function parseSeconds(t: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(t);
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m.map(Number) as [number, number, number, number, number, number, number];
  return daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s;
}

// ---- pods/binding ----

/**
 * POST pods/<name>/binding: assigns a Pod to a node. A storage-level update that bypasses the
 * Pod strategy (no generation bump), as upstream's GuaranteedUpdate does.
 * upstream: pkg/registry/core/pod/storage/storage.go BindingREST.Create, setPodNodeAndMetadata,
 * assignPod; pkg/api/pod/util.go UpdatePodCondition; the create handler fills a Success Status's
 * code with 201 (endpoints/handlers/create.go). ClearingNominatedNodeNameAfterBinding and
 * PodTopologyLabelsAdmission are beta and on at the pin (pkg/features/kube_features.go).
 */
function bindPod(sv: Served, req: ApiRequest): ApiResponse {
  const b = isObject(req.body) ? req.body : {};
  const bm = isObject(b.metadata) ? b.metadata : {};
  const name = req.name ?? '';
  if (str(bm.name) !== name) return fail(badRequestError('name in URL does not match name in Binding object'));
  const target = isObject(b.target) ? b.target : {};
  // ValidatePodBinding's errors reach the client as an aggregate without a Status: not modeled.
  if ((str(target.kind) !== '' && str(target.kind) !== 'Node') || str(target.name) === '') return gap('an invalid Binding');
  const key = objectKey(req.namespace, name);
  const existing = storeGet(sv.etcd, sv.strategy.storage, key);
  if (!existing) return fail(notFoundError({ group: '', resource: 'pods' }, name));
  // The Binding's uid and resourceVersion are storage preconditions (setPodNodeAndMetadata);
  // kube-scheduler sends the Pod's uid. A failed one is an InvalidObj storage error, which
  // InterpretUpdateError turns into a Conflict on pods (apiserver/pkg/storage/interfaces.go
  // Preconditions.Check, pkg/storage/errors InterpretUpdateError).
  const em = meta(existing);
  const precondition = (what: string, want: string, have: string) =>
    fail(conflictError({ group: '', resource: 'pods' }, name, `StorageError: invalid object, Code: 4, Key: /registry/pods/${key}, ResourceVersion: 0, AdditionalErrorMsg: Precondition failed: ${what} in precondition: ${want}, ${what} in object meta: ${have}`));
  if (str(bm.uid) !== '' && str(bm.uid) !== str(em.uid)) return precondition('UID', str(bm.uid), str(em.uid));
  if (str(bm.resourceVersion) !== '' && str(bm.resourceVersion) !== str(em.resourceVersion)) return precondition('ResourceVersion', str(bm.resourceVersion), str(em.resourceVersion));
  const pod = cloneJson(existing);
  const m = meta(pod);
  const spec = isObject(pod.spec) ? pod.spec : {};
  const conflict = (msg: string) => fail(conflictError({ group: '', resource: 'pods/binding' }, name, msg));
  if (m.deletionTimestamp) return conflict(`pod ${name} is being deleted, cannot be assigned to a host`);
  if (str(spec.nodeName) !== '') return conflict(`pod ${name} is already assigned to node "${str(spec.nodeName)}"`);
  if (Array.isArray(spec.schedulingGates) && spec.schedulingGates.length > 0) return conflict(`pod ${name} has non-empty .spec.schedulingGates`);
  spec.nodeName = str(target.name);
  pod.spec = spec;
  const status = isObject(pod.status) ? pod.status : {};
  delete status.nominatedNodeName;
  const annotations = { ...(isObject(m.annotations) ? m.annotations : {}), ...(isObject(bm.annotations) ? bm.annotations : {}) };
  if (Object.keys(annotations).length > 0) m.annotations = annotations;
  if (isObject(bm.labels) && Object.keys(bm.labels).length > 0) m.labels = { ...(isObject(m.labels) ? m.labels : {}), ...bm.labels };
  const conditions = Array.isArray(status.conditions) ? [...status.conditions] : [];
  const i = conditions.findIndex((c) => isObject(c) && c.type === 'PodScheduled');
  const now = sv.s.now();
  const old = i >= 0 ? (conditions[i] as JsonObject) : undefined;
  const cond: JsonObject = { type: 'PodScheduled', status: 'True', lastProbeTime: null, lastTransitionTime: old && old.status === 'True' ? (old.lastTransitionTime ?? null) : now };
  if (i >= 0) conditions[i] = cond;
  else conditions.push(cond);
  status.conditions = conditions;
  pod.status = status;
  if (!sv.s.dryRun) storeUpdate(sv.s.ctx, sv.server.etcd, sv.strategy.storage, key, canonicalStored(sv, pod));
  return okResponse(201, { kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Success', code: 201 });
}

// ---- watch ----

export interface WatchOpen {
  id: string;
}

/**
 * Opens a watch for a list request (`verb: 'watch'`): from now with the current objects as ADDED
 * when resourceVersion is unset or "0", else the changes after that revision. A revision older
 * than the watch cache keeps is Expired, as the cacher reports it.
 */
export function openWatch(ctx: Ctx, server: ApiServerConfig, req: ApiRequest, owner: Json): Result<WatchOpen> | { notSimulated: string } {
  const res = registry().get(req.group, req.version, req.resource);
  const strategy = strategyFor(req.group, req.resource);
  if (!res || !strategy) return { notSimulated: `watching ${req.resource}` };
  if (!res.verbs.includes('watch')) return { status: methodNotSupportedError({ group: req.group, resource: req.resource }, 'watch') };
  const sel = compileSelectors(strategy, req.options?.labelSelector, req.options?.fieldSelector);
  if ('error' in sel) return { status: badRequestError(sel.error) };
  const etcd = etcdData(ctx, server.etcd);
  const namespace = res.namespaced ? req.namespace : undefined;
  const rv = req.options?.resourceVersion ?? '';
  const sub = {
    etcd: server.etcd,
    storage: strategy.storage,
    group: req.group,
    version: req.version,
    resource: req.resource,
    ...(namespace ? { namespace } : {}),
    ...(req.options?.labelSelector ? { labelSelector: req.options.labelSelector } : {}),
    ...(req.options?.fieldSelector ? { fieldSelector: req.options.fieldSelector } : {}),
    ...(req.options?.as === 'Table' ? { table: { ...(req.options.includeObject !== undefined ? { includeObject: req.options.includeObject } : {}), noHeaders: false } } : {}),
    owner,
  };
  if (rv === '' || rv === '0') {
    return { ok: { id: openSubscription(ctx, sub, storeList(etcd, strategy.storage, namespace)) } };
  }
  const n = Number(rv);
  if (!/^[0-9]+$/.test(rv)) return { notSimulated: `a watch from resourceVersion ${JSON.stringify(rv)}` };
  const h = historySince(etcd, strategy.storage, n);
  if (n < h.oldest) return { status: resourceExpiredError(`too old resource version: ${n} (${h.oldest})`) };
  return { ok: { id: openSubscription(ctx, sub, [], h.events) } };
}

export { objectLabels };

/** Takes a watch's pending events, converted to the version the watch was opened on. */
export function watchEvents(ctx: Ctx, server: ApiServerConfig, id: string): { type: WatchEventType; object: JsonObject }[] {
  const sub = k8sSlice(ctx).watches[id];
  if (!sub) return [];
  const strategy = strategyFor(sub.group, sub.resource);
  const res = registry().get(sub.group, sub.version, sub.resource);
  const events = takeEvents(ctx, id);
  if (!strategy || !res) return events.map((e) => ({ type: e.type, object: cloneJson(e.object) }));
  const sv = { strategy, res, apiVersion: sub.group === '' ? sub.version : `${sub.group}/${sub.version}` } as Served;
  void server;
  if (!sub.table || events.length === 0) return events.map((e) => ({ type: e.type, object: toResponse(sv, e.object) }));
  // as=Table: each object becomes a one-row Table; only the first event carries the column
  // definitions. A failed transform logs and sends the object as it is (watchEmbeddedEncoder.doEncode).
  let noHeaders = sub.table.noHeaders;
  const out = events.map((e) => {
    const t = convertToTable(printedGroup(strategy), strategy.kind, { object: e.object }, { noHeaders, now: ctx.now });
    noHeaders = true;
    const r = applyIncludeObject(t, sub.table?.includeObject, (o) => toResponse(sv, o));
    return { type: e.type, object: 'badRequest' in r ? toResponse(sv, e.object) : (r as JsonObject) };
  });
  const now = k8sSlice(ctx).watches[id];
  if (now) put(k8sSlice(ctx).watches, id, { ...now, table: { ...sub.table, noHeaders: true } });
  return out;
}
