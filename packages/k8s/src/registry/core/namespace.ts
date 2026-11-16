// Namespace. upstream: pkg/registry/core/namespace/strategy.go (cluster-scoped; PrepareForCreate
// sets status Active and appends the `kubernetes` finalizer; PrepareForUpdate keeps spec.finalizers
// and status; Canonicalize sets the kubernetes.io/metadata.name label; status strategy),
// pkg/registry/core/namespace/storage/storage.go (REST.Delete, ShouldDeleteNamespaceDuringUpdate,
// ReturnDeletedObject), pkg/apis/core/v1/defaults.go (SetDefaults_Namespace,
// SetDefaults_NamespaceStatus), pkg/apis/core/validation/validation.go (ValidateNamespace,
// ValidateNamespaceUpdate, ValidateNamespaceStatusUpdate, ValidateNamespaceFinalizeUpdate,
// validateFinalizerName). The finalize subresource (storage.go FinalizeREST, an update through
// namespaceFinalizeStrategy) is how the namespace controller removes the `kubernetes` finalizer.

import { conflictError } from '../../apimachinery/errors.ts';
import { invalid, newPath, type FieldError, type Path } from '../../apimachinery/field.ts';
import { cloneJson, ensureObject, isObject, type JsonObject } from '../../apimachinery/json.ts';
import { validateNamespaceName } from '../../apimachinery/validation/objectmeta.ts';
import { validateObjectMeta, validateObjectMetaUpdate } from '../../apis/core/validation/objectmeta.ts';
import { isQualifiedName } from '../../apimachinery/validation/names.ts';
import type { Strategy } from '../../apiserver/types.ts';
import { objectMetaFields } from '../meta.ts';

const LABEL_METADATA_NAME = 'kubernetes.io/metadata.name';
const FINALIZER_KUBERNETES = 'kubernetes';

const meta = (o: JsonObject): JsonObject => ensureObject(o, 'metadata');
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** upstream: pkg/apis/core/helper IsStandardFinalizerName: `kubernetes` is the one standard name. */
function validateFinalizerName(name: string, path: Path): FieldError[] {
  const errs = isQualifiedName(name).map((m) => invalid(path, name, m));
  if (name.split('/').length === 1 && name !== FINALIZER_KUBERNETES) {
    errs.push(invalid(path, name, 'name is neither a standard finalizer name nor is it fully qualified'));
  }
  return errs;
}

function validateNamespace(ns: JsonObject): FieldError[] {
  const errs = validateObjectMeta(meta(ns), false, validateNamespaceName, newPath('metadata'));
  const finalizers = isObject(ns.spec) && Array.isArray(ns.spec.finalizers) ? ns.spec.finalizers : [];
  for (const f of finalizers) errs.push(...validateFinalizerName(str(f), newPath('spec', 'finalizers')));
  return errs;
}

function setMetadataNameLabel(obj: JsonObject): void {
  const m = meta(obj);
  if (str(m.name) === '') return;
  ensureObject(m, 'labels')[LABEL_METADATA_NAME] = m.name as string;
}

/** shouldHaveOrphanFinalizer / shouldHaveDeleteDependentsFinalizer. */
function gcFinalizer(opts: { orphanDependents?: boolean; propagationPolicy?: string } | undefined, which: 'orphan' | 'foreground', have: boolean): boolean {
  if (opts?.orphanDependents !== undefined) return which === 'orphan' ? opts.orphanDependents : !opts.orphanDependents;
  if (opts?.propagationPolicy !== undefined) return opts.propagationPolicy === (which === 'orphan' ? 'Orphan' : 'Foreground');
  return have;
}

export const namespaceStrategy: Strategy = {
  group: '',
  resource: 'namespaces',
  kind: 'Namespace',
  storage: 'namespaces',
  storageVersion: 'v1',
  defaults(obj) {
    setMetadataNameLabel(obj);
    const status = ensureObject(obj, 'status');
    if (str(status.phase) === '') status.phase = 'Active';
  },
  prepareForCreate(obj) {
    obj.status = { phase: 'Active' };
    const spec = ensureObject(obj, 'spec');
    const finalizers = Array.isArray(spec.finalizers) ? spec.finalizers : [];
    if (!finalizers.includes(FINALIZER_KUBERNETES)) spec.finalizers = [...finalizers, FINALIZER_KUBERNETES];
  },
  prepareForUpdate(obj, old) {
    const spec = ensureObject(obj, 'spec');
    const oldSpec = isObject(old.spec) ? old.spec : {};
    if (oldSpec.finalizers !== undefined) spec.finalizers = cloneJson(oldSpec.finalizers);
    else delete spec.finalizers;
    obj.status = cloneJson(old.status ?? {});
  },
  validate: (obj) => validateNamespace(obj),
  validateUpdate: (obj, old) => [...validateNamespace(obj), ...validateObjectMetaUpdate(meta(obj), old.metadata as JsonObject, newPath('metadata'))],
  canonicalize(obj) {
    // Also for names generated after defaulting ran.
    ensureObject(meta(obj), 'labels')[LABEL_METADATA_NAME] = str(meta(obj).name);
  },
  allowCreateOnUpdate: false,
  allowUnconditionalUpdate: true,
  returnDeletedObject: true,
  fields(o) {
    const status = isObject(o.status) ? o.status : {};
    return { ...objectMetaFields(o, false), 'status.phase': str(status.phase), name: str((o.metadata as JsonObject).name) };
  },
  convertFieldLabel(label, value) {
    // upstream: pkg/apis/core/v1/conversion.go, Namespace: metadata.name, status.phase.
    if (label === 'metadata.name' || label === 'status.phase') return { label, value };
    return { error: `field label not supported: ${label}` };
  },
  status: {
    prepareForUpdate(obj, old) {
      obj.spec = cloneJson(old.spec ?? {});
    },
    validateUpdate(obj, old) {
      const errs = validateObjectMetaUpdate(meta(obj), old.metadata as JsonObject, newPath('metadata'));
      const phase = isObject(obj.status) ? str(obj.status.phase) : '';
      if (!meta(obj).deletionTimestamp) {
        if (phase !== 'Active') errs.push(invalid(newPath('status', 'Phase'), phase, "may only be 'Active' if `deletionTimestamp` is empty"));
      } else if (phase !== 'Terminating') {
        errs.push(invalid(newPath('status', 'Phase'), phase, "may only be 'Terminating' if `deletionTimestamp` is not empty"));
      }
      return errs;
    },
  },
  updateSubresources: {
    // upstream: strategy.go namespaceFinalizeStrategy: the namespace strategy with its own
    // PrepareForUpdate (status kept, spec and metadata as sent) and ValidateUpdate.
    finalize: {
      prepareForUpdate(obj, old) {
        obj.status = cloneJson(old.status ?? {});
      },
      validateUpdate(obj, old) {
        // validation.go ValidateNamespaceFinalizeUpdate: indexed paths, unlike ValidateNamespace.
        const errs = validateObjectMetaUpdate(meta(obj), old.metadata as JsonObject, newPath('metadata'));
        const finalizers = isObject(obj.spec) && Array.isArray(obj.spec.finalizers) ? obj.spec.finalizers : [];
        finalizers.forEach((f, i) => errs.push(...validateFinalizerName(str(f), newPath('spec', 'finalizers').index(i))));
        return errs;
      },
      warningsOnUpdate: () => [],
    },
  },
  deleteDuringUpdate(obj) {
    const spec = isObject(obj.spec) ? obj.spec : {};
    return !Array.isArray(spec.finalizers) || spec.finalizers.length === 0;
  },
  deleteHook(existing, s, persist) {
    const opts = s.request.options;
    const m = existing.metadata as JsonObject;
    const name = str(m.name);
    const gr = { group: '', resource: 'namespaces' };
    const pre = opts?.preconditions;
    if (pre?.uid !== undefined && pre.uid !== str(m.uid)) {
      return { ok: false, code: 409, status: conflictError(gr, name, `Precondition failed: UID in precondition: ${pre.uid}, UID in object meta: ${str(m.uid)}`), warnings: [] };
    }
    if (pre?.resourceVersion !== undefined && pre.resourceVersion !== str(m.resourceVersion)) {
      return { ok: false, code: 409, status: conflictError(gr, name, `Precondition failed: ResourceVersion in precondition: ${pre.resourceVersion}, ResourceVersion in object meta: ${str(m.resourceVersion)}`), warnings: [] };
    }
    if (!m.deletionTimestamp) {
      const ns = cloneJson(existing);
      const nm = meta(ns);
      nm.deletionTimestamp = s.now();
      ensureObject(ns, 'status').phase = 'Terminating';
      const current = new Set(Array.isArray(nm.finalizers) ? nm.finalizers.map(str) : []);
      const want = {
        orphan: gcFinalizer(opts, 'orphan', current.has('orphan')),
        foregroundDeletion: gcFinalizer(opts, 'foreground', current.has('foregroundDeletion')),
      };
      let changed = false;
      for (const [f, should] of Object.entries(want)) {
        changed = changed || current.has(f) !== should;
        if (should) current.add(f);
        else current.delete(f);
      }
      // Go builds the list from a map: random order; sorted here (D-040).
      if (changed) nm.finalizers = [...current].sort();
      const written = persist(ns);
      return { ok: true, code: 200, object: written, warnings: [] };
    }
    const spec = isObject(existing.spec) ? existing.spec : {};
    if (Array.isArray(spec.finalizers) && spec.finalizers.length > 0) return { ok: true, code: 200, object: existing, warnings: [] };
    return undefined;
  },
};
