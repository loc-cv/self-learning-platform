// Patch metadata: a field's patch strategies and merge key, looked up by JSON field name in the Go
// type the object decodes into, as the API server does (PatchMetaFromStruct over the
// `patchStrategy` and `patchMergeKey` struct tags, which the vendored schema carries:
// openapi/schema.ts FieldSpec).
// upstream: staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/meta.go (PatchMeta,
// LookupPatchMeta, PatchMetaFromStruct), third_party/forked/golang/json/fields.go
// LookupPatchMetadataForStruct (exact JSON name first, else the first case-insensitive match).
//
// Types with their own JSON form (metav1.Time, resource.Quantity, intstr.IntOrString,
// runtime.RawExtension, apiextensions JSON) are Go structs whose fields have no JSON names this
// lookup could match, so a lookup inside one fails as it does upstream. (Quantity's exported
// `Format` and IntOrString's untagged `Type`/`IntVal`/`StrVal` would match those exact names
// upstream; nothing sends a map there, so they are not modelled.)

import { schema, type FieldSpec, type NamedType, type TypeExpr } from '../../openapi/schema.ts';
import { goQuote } from '../field.ts';
import { PatchError } from './errors.ts';

export interface PatchMeta {
  /** GetPatchStrategies: the `patchStrategy` tag split at commas (an absent tag gives [""]). */
  patchStrategies: string[];
  patchMergeKey: string;
}

export interface LookupPatchMeta {
  /** The subschema and patch meta of a field holding a map; throws a PatchError. */
  lookupPatchMetadataForStruct(key: string): [LookupPatchMeta, PatchMeta];
  /** The subschema (of the element type) and patch meta of a field holding a list; throws a PatchError. */
  lookupPatchMetadataForSlice(key: string): [LookupPatchMeta, PatchMeta];
  /** The type's reflect.Kind, as `cannot merge lists without merge key for <name>` prints it. */
  name(): string;
}

export type TypeResolver = (id: string) => NamedType;

interface Resolved {
  kind: string;
  named?: NamedType;
  elem?: TypeExpr;
}

/** reflect.Kind of a type expression, and what it points to or holds. */
function resolveKind(t: TypeExpr, resolve: TypeResolver): Resolved {
  switch (t.k) {
    case 'basic':
      return { kind: t.name };
    case 'bytes':
      return { kind: 'slice', elem: { k: 'basic', name: 'uint8' } };
    case 'any':
      return { kind: 'interface' };
    case 'ptr':
      return { kind: 'ptr', elem: t.elem };
    case 'slice':
      return { kind: 'slice', elem: t.elem };
    case 'map':
      return { kind: 'map', elem: t.elem };
    case 'named': {
      const nt = resolve(t.id);
      if (nt.underlying) return { ...resolveKind(nt.underlying, resolve), named: nt };
      return { kind: 'struct', named: nt };
    }
  }
}

const NO_FIELDS: FieldSpec[] = [];

function structFields(nt: NamedType | undefined): FieldSpec[] {
  // A type with its own JSON form has no JSON-named fields the lookup could match.
  if (!nt || nt.custom || !nt.struct) return NO_FIELDS;
  return nt.struct.fields;
}

/** bytes.EqualFold for the ASCII field names of the API types. */
const equalFold = (a: string, b: string): boolean => a.length === b.length && a.toLowerCase() === b.toLowerCase();

/** PatchMetaFromStruct{T: t}. */
export function patchMetaFromType(t: TypeExpr, resolve: TypeResolver = (id) => schema().type(id)): LookupPatchMeta {
  const self: StructPatchMeta = {
    type: t,
    lookupPatchMetadataForStruct(key) {
      let r = resolveKind(t, resolve);
      if (r.kind === 'ptr') r = resolveKind(r.elem as TypeExpr, resolve);
      if (r.kind !== 'struct') throw new PatchError(`merging an object in json but data type is not struct, instead is: ${r.kind}`);
      let found: FieldSpec | undefined;
      for (const f of structFields(r.named)) {
        if (f.json === key) {
          found = f;
          break;
        }
        if (found === undefined && equalFold(f.json, key)) found = f;
      }
      if (!found) throw new PatchError(`unable to find api field in struct ${r.named?.name ?? ''} for the json field ${goQuote(key)}`);
      return [patchMetaFromType(found.type, resolve), { patchStrategies: (found.patchStrategy ?? '').split(','), patchMergeKey: found.patchMergeKey ?? '' }];
    },
    lookupPatchMetadataForSlice(key) {
      const [sub, meta] = self.lookupPatchMetadataForStruct(key);
      const st = (sub as StructPatchMeta).type;
      const r = resolveKind(st, resolve);
      let elemType: TypeExpr;
      if (r.kind === 'slice' || r.kind === 'array') {
        elemType = r.elem as TypeExpr;
        const ek = resolveKind(elemType, resolve).kind;
        if (ek === 'slice' || ek === 'array') throw new PatchError('unexpected slice of slice');
      } else if (r.kind === 'ptr') {
        let inner = r.elem as TypeExpr;
        const ir = resolveKind(inner, resolve);
        if (ir.kind === 'slice' || ir.kind === 'array') inner = ir.elem as TypeExpr;
        elemType = inner;
      } else {
        // upstream prints the kind of the type looked in (s.T), not of the field.
        throw new PatchError(`expected slice or array type, but got: ${self.name()}`);
      }
      return [patchMetaFromType(elemType, resolve), meta];
    },
    name() {
      return resolveKind(t, resolve).kind;
    },
  };
  return self;
}

interface StructPatchMeta extends LookupPatchMeta {
  /** PatchMetaFromStruct.T */
  readonly type: TypeExpr;
}

/** The lookup for an object of the Go type `typeId` (`apps/v1.Deployment`). */
export function patchMetaFor(typeId: string, resolve?: TypeResolver): LookupPatchMeta {
  return patchMetaFromType({ k: 'named', id: typeId }, resolve);
}
