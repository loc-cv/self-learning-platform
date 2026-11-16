// Writes to the scale subresource (update and patch of `<resource>/scale`): the request's Scale is
// made from the stored object's, validated, and its replicas (and resourceVersion, the storage's
// precondition) moved onto the object, which then takes the main strategy's update path; the
// answer is the autoscaling/v1 Scale of the updated object.
//   upstream: pkg/registry/apps/deployment/storage/storage.go ScaleREST.Update,
//             scaleUpdatedObjectInfo.UpdatedObject (NotFound on `deployments/scale` when the object
//             does not exist, ValidateScaleUpdate → Invalid on Scale.autoscaling, the UID
//             precondition → Conflict, spec.replicas and resourceVersion moved to the object);
//             pkg/registry/apps/replicaset/storage/storage.go the same for ReplicaSets
//   upstream: pkg/apis/autoscaling/validation/validation.go ValidateScale (spec.replicas
//             nonnegative: apivalidation.ValidateNonnegativeField "must be greater than or equal to 0")
//   upstream: staging/src/k8s.io/apiserver/pkg/endpoints/handlers/patch.go (the patch is applied to
//             the old Scale: jsonPatcher for a merge patch, smpPatcher for a strategic one, the
//             result decoded as a Scale), update.go (the body decoded as a Scale)

import { canonical, decode } from '../apimachinery/gojson.ts';
import { badRequestError, conflictError, invalidError, notFoundError, type Status } from '../apimachinery/errors.ts';
import { invalid, newPath } from '../apimachinery/field.ts';
import { cloneJson, isObject, type Json, type JsonObject } from '../apimachinery/json.ts';
import { mergePatch, mergePatchError } from '../apimachinery/mergepatch.ts';
import { applyStrategicPatchInPlace } from '../apimachinery/strategicpatch/index.ts';
import { schema } from '../openapi/schema.ts';
import type { ApiRequest, ApiResponse, Strategy } from './types.ts';

const SCALE_API_VERSION = 'autoscaling/v1';

/** What the scale handler needs from the pipeline. */
export interface ScaleTarget {
  /** The stored object in the request's version, or undefined when there is none. */
  current: JsonObject | undefined;
  /** The update path of the main strategy for the changed object (its precondition included). */
  update(obj: JsonObject): ApiResponse;
}

const fail = (status: Status, warnings: string[] = []): ApiResponse => ({ ok: false, code: status.code ?? 500, status, warnings });
const gap = (what: string): ApiResponse => ({ ok: false, code: 0, notSimulated: what, warnings: [] });
const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');

function scaleTypeId(): string {
  const t = schema().kind(SCALE_API_VERSION, 'Scale');
  if (!t) throw new Error('no schema for autoscaling/v1 Scale');
  return t.id;
}

type Decoded = { ok: JsonObject } | { status: Status };

/** The request's Scale from a PUT body, decoded as update.go decodes a body. */
function decodeBody(body: Json | undefined, mode: string, warnings: string[]): Decoded {
  const handled = 'Scale in version "v1" cannot be handled as a Scale';
  if (!isObject(body)) return { status: badRequestError('the object provided is unrecognized (must be of type Scale): couldn\'t get version/kind; json parse error: unexpected end of JSON input (<empty>)') };
  const r = decode(body, scaleTypeId());
  if (r.error !== undefined) return { status: badRequestError(`${handled}: ${r.error}`) };
  if (r.unknown.length > 0) {
    const items = r.unknown.map((p) => `unknown field ${JSON.stringify(p)}`);
    if (mode === 'Strict') return { status: badRequestError(`${handled}: strict decoding error: ${items.join(', ')}`) };
    if (mode !== 'Ignore') warnings.push(...items);
  }
  return { ok: canonical(r.value as Json, scaleTypeId()) as JsonObject };
}

/** The request's Scale from a patch applied to the old Scale (patch.go). */
function patched(req: ApiRequest, old: JsonObject, mode: string, warnings: string[]): Decoded | ApiResponse {
  const type = req.options?.patchType ?? 'merge';
  const patchInvalid = (value: string, detail: string) => invalidError({ group: '', kind: '' }, '', [invalid(newPath('patch'), value, detail)]);
  let merged: Json;
  if (type === 'merge') {
    const patchErr = req.body === undefined ? 'invalid JSON patch' : mergePatchError(req.body);
    if (patchErr !== null) return { status: badRequestError(patchErr) };
    merged = mergePatch(old, req.body as Json);
  } else if (type === 'strategic') {
    if (req.body === undefined) return { status: badRequestError('invalid JSON patch') };
    if (req.body !== null && !isObject(req.body)) return gap('a strategic merge patch of the scale subresource that is not a JSON object');
    const r = applyStrategicPatchInPlace(cloneJson(old), req.body === null ? {} : cloneJson(req.body), scaleTypeId());
    if ('error' in r) return gap(`a strategic merge patch of the scale subresource that fails (${r.error})`);
    merged = r.ok;
  } else return gap(`${type} patches of the scale subresource`);
  if (!isObject(merged)) return { status: badRequestError('invalid JSON patch') };
  const r = decode(merged, scaleTypeId());
  if (r.error !== undefined) return { status: patchInvalid(JSON.stringify(merged), r.error) };
  if (r.unknown.length > 0) {
    const items = r.unknown.map((p) => `unknown field ${JSON.stringify(p)}`);
    if (mode === 'Strict') return { status: patchInvalid(JSON.stringify(merged), `strict decoding error: ${items.join(', ')}`) };
    if (mode !== 'Ignore') warnings.push(...items);
  }
  return { ok: canonical(r.value as Json, scaleTypeId()) as JsonObject };
}

function setPath(obj: JsonObject, path: readonly string[], value: Json): void {
  let o = obj;
  for (const k of path.slice(0, -1)) {
    if (!isObject(o[k])) o[k] = {};
    o = o[k] as JsonObject;
  }
  o[path[path.length - 1] as string] = value;
}

/** Update or patch of `<resource>/scale`. */
export function writeScale(req: ApiRequest, strategy: Strategy, gr: { group: string; resource: string }, target: ScaleTarget): ApiResponse {
  const sc = strategy.scale;
  if (!sc) return gap(`the ${gr.resource}/scale subresource`);
  const name = req.name ?? '';
  const warnings: string[] = [];
  // scaleUpdatedObjectInfo: a zero object (no resourceVersion) is one that does not exist.
  // The store's GuaranteedUpdate reads the object first: its NotFound names the parent resource
  // (fixtures/golden/v1.37.2/change/scale-subresource.yaml).
  if (!target.current) return fail(notFoundError(gr, name));
  const oldScale = sc.get(target.current);
  const mode = req.options?.fieldValidation || (req.verb === 'patch' && req.options?.patchType === 'strategic' ? 'Warn' : '');
  const r = req.verb === 'update' ? decodeBody(req.body, mode, warnings) : patched(req, oldScale, mode, warnings);
  if ('notSimulated' in r || 'code' in r) return r as ApiResponse;
  if ('status' in r) return fail(r.status, warnings);
  const scale = r.ok;
  const spec = isObject(scale.spec) ? scale.spec : {};
  const replicas = typeof spec.replicas === 'number' ? spec.replicas : 0;
  // ValidateScaleUpdate
  if (replicas < 0) {
    return fail(invalidError({ group: 'autoscaling', kind: 'Scale' }, name, [invalid(newPath('spec', 'replicas'), replicas, 'must be greater than or equal to 0')]), warnings);
  }
  const md = isObject(scale.metadata) ? scale.metadata : {};
  const objMeta = isObject(target.current.metadata) ? target.current.metadata : {};
  const uid = str(md.uid);
  // A PUT body's UID is the storage's precondition (rest.DefaultUpdatedObjectInfo.Preconditions),
  // checked before UpdatedObject runs; a patch has none, so the Scale's own check answers.
  if (req.verb === 'update' && uid !== '' && uid !== str(objMeta.uid)) {
    const key = `${str(objMeta.namespace) === '' ? '' : `${str(objMeta.namespace)}/`}${name}`;
    return fail(
      conflictError(gr, name, `StorageError: invalid object, Code: 4, Key: /registry/${strategy.storage.split('.')[0] as string}/${key}, ResourceVersion: 0, AdditionalErrorMsg: Precondition failed: UID in precondition: ${uid}, UID in object meta: ${str(objMeta.uid)}`),
      warnings,
    );
  }
  if (uid !== '' && uid !== str(objMeta.uid)) {
    return fail(conflictError({ group: gr.group, resource: `${gr.resource}/scale` }, name, `Precondition failed: UID in precondition: ${uid}, UID in object meta: ${str(objMeta.uid)}`), warnings);
  }
  const obj = cloneJson(target.current);
  setPath(obj, sc.replicasPath, replicas);
  (obj.metadata as JsonObject).resourceVersion = str(md.resourceVersion);
  const res = target.update(obj);
  if (!res.ok) return { ...res, warnings: [...warnings, ...res.warnings] };
  return { ok: true, code: 200, object: sc.get(res.object as JsonObject), warnings: [...warnings, ...res.warnings] };
}
