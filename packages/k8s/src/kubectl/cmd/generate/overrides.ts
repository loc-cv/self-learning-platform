// --overrides and --override-type of `kubectl run` and `kubectl expose`: an inline JSON document
// applied to the generated object before it is created or printed. The object is encoded
// (scheme.DefaultJSONEncoder), patched, and decoded back into its Go type, so fields the type
// does not have are dropped and type errors fail the command.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/override_options.go AddOverrideFlags,
//             Overrider.Apply ("invalid override type: %v"); helpers.go Merge, StrategicMerge,
//             JSONPatch (gopkg.in/evanphx/json-patch.v4 DecodePatch and Patch.Apply, the package
//             apimachinery/jsonpatch.ts ports)
//   upstream: staging/src/k8s.io/apimachinery/pkg/runtime/serializer/json/meta.go SimpleMetaFactory.Interpret
//             ("couldn't get version/kind; json parse error: %v")
//   upstream: staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch.go handleUnmarshal
//             (mergepatch.ErrBadJSONDoc "invalid JSON document")
//   fixtures/golden/v1.37.2/generate/run.yaml (the override steps)

import type { Json, JsonObject } from '../../../apimachinery/json.ts';
import { decode } from '../../../apimachinery/gojson.ts';
import { applyJsonPatch, decodeJsonPatch } from '../../../apimachinery/jsonpatch.ts';
import { BAD_JSON_PATCH, mergePatch, mergePatchError } from '../../../apimachinery/mergepatch.ts';
import { strategicMergePatch } from '../../../apimachinery/strategicpatch/index.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import type { FlagDef } from '../../cli/flagset.ts';
import { typed } from '../typed.ts';

export const OVERRIDE_FLAGS: FlagDef[] = [
  { name: 'overrides', kind: 'string', default: '' },
  { name: 'override-type', kind: 'string', default: 'merge' },
];


export const OVERRIDE_PARTIAL = { 'override-type': 'json with text that is not valid JSON prints a notice (encoding/json syntax errors are not ported)' };

/** Overrider.Apply: the overridden object, the error, or a notice for what is not simulated. */
export function applyOverrides(obj: JsonObject, typeId: string, overrides: string, overrideType: string): { object: JsonObject } | { error: KubectlError } {
  if (overrides === '') return { object: obj };
  const type = overrideType === '' ? 'merge' : overrideType;
  if (type !== 'json' && type !== 'merge' && type !== 'strategic') return { error: messageError(`invalid override type: ${type}`) };
  let fragment: Json | undefined;
  try {
    fragment = JSON.parse(overrides) as Json;
  } catch {
    fragment = undefined;
  }
  const target = typed(obj, typeId);
  let patched: Json;
  if (type === 'json') {
    // DecodePatch json.Unmarshal's the text; the syntax error texts of encoding/json are not ported.
    if (fragment === undefined) return { error: { type: 'notSimulated', what: 'an --overrides value that is not valid JSON, with --override-type=json' } };
    const d = decodeJsonPatch(fragment);
    if ('error' in d) return { error: messageError(d.error) };
    const r = applyJsonPatch(target, d.ops);
    if ('error' in r) return { error: messageError(r.error) };
    if ('panic' in r) return { error: { type: 'notSimulated', what: `a JSON patch that makes json-patch panic (${r.panic})` } };
    patched = r.ok;
  } else if (type === 'merge') {
    // json-patch v4 MergePatch: a patch that does not parse, or is not an object or array
    if (fragment === undefined || mergePatchError(fragment) !== null) return { error: messageError(BAD_JSON_PATCH) };
    patched = mergePatch(target, fragment);
  } else {
    // strategicpatch handleUnmarshal: anything but a JSON object (or null) is ErrBadJSONDoc
    if (fragment === undefined || (fragment !== null && (typeof fragment !== 'object' || Array.isArray(fragment)))) return { error: messageError('invalid JSON document') };
    const r = strategicMergePatch(target, fragment ?? {}, typeId);
    if ('error' in r) return { error: messageError(r.error) };
    patched = r.ok;
  }
  // json.Serializer.Decode reads apiVersion and kind first (SimpleMetaFactory.Interpret).
  if (patched === null || typeof patched !== 'object' || Array.isArray(patched)) {
    const what = Array.isArray(patched) ? 'array' : typeof patched === 'number' ? 'number' : typeof patched === 'boolean' ? 'bool' : 'string';
    if (patched !== null) {
      return { error: messageError(`couldn't get version/kind; json parse error: json: cannot unmarshal ${what} into Go value of type struct { APIVersion string "json:\\"apiVersion,omitempty\\""; Kind string "json:\\"kind,omitempty\\"" }`) };
    }
  }
  if (patched === null || typeof (patched as JsonObject).kind !== 'string' || (patched as JsonObject).kind === '' || typeof (patched as JsonObject).apiVersion !== 'string') {
    return { error: { type: 'notSimulated', what: 'an --overrides value that removes or retypes apiVersion or kind' } };
  }
  const d = decode(patched, typeId);
  if (d.error !== undefined) return { error: messageError(d.error) };
  return { object: typed(d.value as JsonObject, typeId) };
}
