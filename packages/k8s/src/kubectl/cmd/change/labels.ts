// kubectl label and kubectl annotate: add, overwrite and remove metadata.labels or
// metadata.annotations of the objects named, selected or read from files, sent as a JSON merge
// patch of the object before and after; --list prints them, --local changes the file's objects only.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/label/label.go NewCmdLabel, Complete (the pairs,
//             "--list and --output may not be specified together"), Validate (the --all, --local
//             and missing-input errors, "at least one label update is required"), RunLabel (the
//             builder with Latest unless --local, "--resource-version may only be used with a single
//             resource", the resourceVersion cleared before the old data, `label %q not found.` for a
//             removal on the server path, the merge patch only when something changed, a printer made
//             per object with the change as its operation, --list's "Listing labels for %s.%s/%s:"),
//             updateDataChangeMsg (labeled, unlabeled, modified, not labeled), validateNoOverwrites,
//             parseLabels ("invalid label spec", "invalid label value: %q: %s", "unknown label
//             spec", "can not both modify and remove a label in the same command"), labelFunc
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/annotate/annotate.go ToOptions (the checks in
//             order), RunAnnotate (the patch always sent, the server's object printed by one printer),
//             validateAnnotations, validateNoAnnotationOverwrites (kubernetes.io/change-cause may be
//             overwritten), updateAnnotations
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go ParsePairs ("invalid %s format: %s")
//   upstream: staging/src/k8s.io/cli-runtime/pkg/genericclioptions/builder_flags.go ToBuilder
//             (annotate's builder: -R defaults to true, LocalResourceError)
//   Go maps (the new pairs, an object's labels) are iterated in random order: the simulator uses the
//   order of the arguments and, for --list, sorted keys (docs/decisions.md).
//   fixtures/golden/v1.37.2/change/label.yaml, change/annotate.yaml, client/yaml-input.yaml

import type { Op, ProcApi } from '@simlab/host';
import { cloneJson, isObject, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import { compareGoStrings } from '../../../apimachinery/yaml/gofmt.ts';
import { isValidLabelValue } from '../../../apimachinery/validation/names.ts';
import type { Invocation, Verb } from '../../cli/command.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import { goQuote, type FlagDef } from '../../cli/flagset.ts';
import { fail, overridesOf, request, resolveConfig, type Session } from '../../client/session.ts';
import { continueOnError } from '../../resource/files.ts';
import { CHANGE_FORMATS, DRY_RUN_NO_OPT, dryRunStrategy, toPrinter, type DryRun, type Printer } from '../helpers.ts';
import { parseYaml, YamlMarshalError } from '../printing.ts';
import { find, infoBase, type Found, type Info } from './finder.ts';
import { createMergePatch } from './mergepatch.ts';
import { resourcesAndPairs } from './pairs.ts';

const CHANGE_CAUSE = 'kubernetes.io/change-cause';

function flags(manager: string, recursive: boolean): FlagDef[] {
  return [
    { name: 'all', kind: 'bool', default: false },
    { name: 'all-namespaces', shorthand: 'A', kind: 'bool', default: false },
    { name: 'dry-run', kind: 'string', default: 'none', noOptDefVal: DRY_RUN_NO_OPT },
    { name: 'field-manager', kind: 'string', default: manager },
    { name: 'field-selector', kind: 'string', default: '' },
    { name: 'filename', shorthand: 'f', kind: 'stringSlice', default: [] },
    { name: 'kustomize', shorthand: 'k', kind: 'string', default: '' },
    { name: 'list', kind: 'bool', default: false },
    { name: 'local', kind: 'bool', default: false },
    { name: 'output', shorthand: 'o', kind: 'string', default: '' },
    { name: 'overwrite', kind: 'bool', default: false },
    { name: 'recursive', shorthand: 'R', kind: 'bool', default: recursive },
    { name: 'resource-version', kind: 'string', default: '' },
    { name: 'selector', shorthand: 'l', kind: 'string', default: '' },
    { name: 'template', kind: 'string', default: '' },
  ];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const isFilenameSliceEmpty = (filenames: readonly string[], kustomize: string) => filenames.length === 0 && kustomize === '';

function metaOf(obj: JsonObject): JsonObject {
  if (!isObject(obj.metadata)) obj.metadata = {};
  return obj.metadata as JsonObject;
}

function stringMap(obj: JsonObject, field: 'labels' | 'annotations'): Record<string, string> {
  const m = metaOf(obj)[field];
  return isObject(m) ? (m as Record<string, string>) : {};
}

/** Accessor.SetLabels / SetAnnotations on an unstructured object: nil removes the field. */
function setStringMap(obj: JsonObject, field: 'labels' | 'annotations', m: Record<string, string>): void {
  metaOf(obj)[field] = m as unknown as Json;
}

interface Pairs {
  set: [string, string][];
  remove: string[];
}

/** parseLabels */
function parseLabels(spec: readonly string[]): Pairs | KubectlError {
  const set = new Map<string, string>();
  const remove: string[] = [];
  for (const s of spec) {
    if (s.includes('=')) {
      const parts = s.split('=');
      if (parts.length !== 2) return messageError(`invalid label spec: ${s}`);
      const errs = isValidLabelValue(parts[1] as string);
      if (errs.length > 0) return messageError(`invalid label value: ${goQuote(s)}: ${errs.join(';')}`);
      set.set(parts[0] as string, parts[1] as string);
    } else if (s.endsWith('-')) remove.push(s.slice(0, -1));
    else return messageError(`unknown label spec: ${s}`);
  }
  for (const r of remove) if (set.has(r)) return messageError('can not both modify and remove a label in the same command');
  return { set: [...set.entries()], remove };
}

/** ParsePairs(…, "annotation", true) and validateAnnotations */
function parseAnnotations(args: readonly string[]): Pairs | KubectlError {
  const set = new Map<string, string>();
  const remove: string[] = [];
  const invalid: string[] = [];
  for (const a of args) {
    if (a.includes('=') && a[0] !== '=') {
      const i = a.indexOf('=');
      set.set(a.slice(0, i), a.slice(i + 1));
    } else if (a.endsWith('-') && a !== '-') remove.push(a.slice(0, -1));
    else invalid.push(a);
  }
  if (invalid.length > 0) return messageError(`invalid annotation format: ${invalid.join(', ')}`);
  return { set: [...set.entries()], remove };
}

function validateAnnotations(p: Pairs): KubectlError | undefined {
  const both = p.remove.filter((r) => p.set.some(([k]) => k === r));
  if (both.length > 0) return messageError(`can not both modify and remove the following annotation(s) in the same command: ${both.join(', ')}`);
  return undefined;
}

/** labelFunc: what was added and removed, or the overwrite error. */
function labelFunc(obj: JsonObject, overwrite: boolean, resourceVersion: string, p: Pairs): { added: number; removed: number } | KubectlError {
  const current = stringMap(obj, 'labels');
  if (!overwrite) {
    const errs: KubectlError[] = [];
    for (const [k, v] of p.set) if (k in current && current[k] !== v) errs.push(messageError(`'${k}' already has a value (${current[k] as string}), and --overwrite is false`));
    if (errs.length > 0) return errs.length === 1 ? (errs[0] as KubectlError) : { type: 'aggregate', errors: errs };
  }
  const labels = { ...current };
  let added = 0;
  let removed = 0;
  for (const [k, v] of p.set) {
    if (!(k in labels) || labels[k] !== v) {
      labels[k] = v;
      added++;
    }
  }
  for (const k of p.remove) {
    if (k in labels) {
      delete labels[k];
      removed++;
    }
  }
  setStringMap(obj, 'labels', labels);
  if (resourceVersion !== '') metaOf(obj).resourceVersion = resourceVersion;
  return { added, removed };
}

/** updateDataChangeMsg */
function changeMessage(c: { added: number; removed: number }): string {
  if (c.added > 0 && c.removed > 0) return 'modified';
  if (c.added > 0) return 'labeled';
  if (c.removed > 0) return 'unlabeled';
  return 'not labeled';
}

/** updateAnnotations */
function updateAnnotations(obj: JsonObject, overwrite: boolean, resourceVersion: string, p: Pairs): KubectlError | undefined {
  const current = stringMap(obj, 'annotations');
  if (!overwrite) {
    const found: string[] = [];
    for (const [k, v] of p.set) {
      if (k === CHANGE_CAUSE) continue;
      if (k in current && current[k] !== v) found.push(`'${k}' already has a value (${current[k] as string})`);
    }
    if (found.length > 0) return messageError(`--overwrite is false but found the following declared annotation(s): ${found.join('; ')}`);
  }
  const annotations = { ...current };
  for (const [k, v] of p.set) annotations[k] = v;
  for (const k of p.remove) delete annotations[k];
  setStringMap(obj, 'annotations', annotations);
  if (resourceVersion !== '') metaOf(obj).resourceVersion = resourceVersion;
  return undefined;
}

/** The merge patch request (resource.Helper.Patch with MergePatchType). */
function* patchObject(s: Session, info: Info, patch: JsonObject, dryRun: DryRun, fieldManager: string): Op<{ ok: JsonObject } | { error: KubectlError }> {
  const r = yield* request(s, {
    verb: 'patch',
    ...infoBase(info),
    name: info.name,
    body: patch,
    options: { patchType: 'merge', fieldManager, ...(dryRun === 'server' ? { dryRun: true } : {}) },
  });
  if (!r.ok) return { error: 'notSimulated' in r ? { type: 'notSimulated', what: r.notSimulated } : { type: 'status', status: r.status } };
  return { ok: r.object as JsonObject };
}

/** --list: `key=value` lines, under a heading when more than one object may be listed. */
function* list(p: ProcApi, what: 'labels' | 'annotations', info: Info, obj: JsonObject, single: boolean): Op<void> {
  let out = '';
  const indent = single ? '' : ' ';
  if (!single) {
    const apiVersion = str(info.object.apiVersion);
    const group = apiVersion.includes('/') ? apiVersion.slice(0, apiVersion.indexOf('/')) : '';
    out += `Listing ${what} for ${str(info.object.kind)}.${group}/${info.name}:\n`;
  }
  const m = stringMap(obj, what);
  for (const k of Object.keys(m).sort(compareGoStrings)) out += `${indent}${k}=${m[k] as string}\n`;
  yield* p.write(1, out);
}

function* print(p: ProcApi, printer: Printer, obj: JsonObject): Op<KubectlError | undefined> {
  try {
    yield* p.write(1, printer.print(obj));
  } catch (e) {
    if (!(e instanceof YamlMarshalError)) throw e;
    return messageError(e.message);
  }
  return undefined;
}

interface Common {
  dryRun: DryRun;
  local: boolean;
  listing: boolean;
  overwrite: boolean;
  resourceVersion: string;
  fieldManager: string;
  output: string;
  template: string;
}

/** The objects to visit (the builder of RunLabel and of annotate's ToBuilder). */
function* findObjects(inv: Invocation, resources: string[], local: boolean): Op<Found | number | { error: KubectlError }> {
  const v = inv.flags.values;
  const config = resolveConfig(inv.p, overridesOf(v), parseYaml);
  if ('type' in config) return { error: config };
  return yield* find(inv.p, {
    config,
    args: resources,
    filenames: (v.filename as string[] | undefined) ?? [],
    recursive: v.recursive === true,
    kustomize: str(v.kustomize),
    local,
    all: v.all === true,
    selector: local ? '' : str(v.selector),
    fieldSelector: local ? '' : str(v['field-selector']),
    allNamespaces: !local && v['all-namespaces'] === true,
    latest: !local,
  });
}

/** Walks the entries as ContinueOnErrorVisitor does: errors collected, the visitor's own too. */
function* visitAll(p: ProcApi, found: Found, fn: (info: Info) => Op<KubectlError | undefined>): Op<number> {
  const errs: KubectlError[] = [];
  for (const e of found.entries) {
    if ('error' in e) {
      if (e.error.type === 'notSimulated') return yield* fail(p, e.error);
      errs.push(e.error);
      continue;
    }
    const err = yield* fn(e.info);
    if (err?.type === 'notSimulated') return yield* fail(p, err);
    if (err) errs.push(err);
  }
  const err = continueOnError(errs, found.readErrors);
  return err ? yield* fail(p, err) : 0;
}

function commonOf(inv: Invocation, dryRun: DryRun): Common {
  const v = inv.flags.values;
  return {
    dryRun,
    local: v.local === true,
    listing: v.list === true,
    overwrite: v.overwrite === true,
    resourceVersion: str(v['resource-version']),
    fieldManager: str(v['field-manager']),
    output: str(v.output),
    template: str(v.template),
  };
}

// ---- label ----

function* runLabel(inv: Invocation): Op<number> {
  const { p, flags } = inv;
  const v = flags.values;
  // Complete
  const dryRun = yield* dryRunStrategy(p, str(v['dry-run']));
  if (typeof dryRun !== 'string') return yield* fail(p, dryRun);
  const o = commonOf(inv, dryRun);
  const split = resourcesAndPairs(inv.args, 'label');
  if ('type' in split) return yield* fail(p, split);
  const pairs = parseLabels(split.pairs);
  if ('type' in pairs) return yield* fail(p, pairs);
  if (o.listing && o.output !== '') return yield* fail(p, messageError('--list and --output may not be specified together'));
  const config = resolveConfig(p, overridesOf(v), parseYaml);
  if ('type' in config) return yield* fail(p, config);
  // Validate
  const filenames = (v.filename as string[] | undefined) ?? [];
  const kustomize = str(v.kustomize);
  if (v.all === true && str(v.selector) !== '') return yield* fail(p, messageError('cannot set --all and --selector at the same time'));
  if (v.all === true && str(v['field-selector']) !== '') return yield* fail(p, messageError('cannot set --all and --field-selector at the same time'));
  if (o.local) {
    if (dryRun === 'server') return yield* fail(p, messageError('cannot specify --local and --dry-run=server - did you mean --dry-run=client?'));
    if (split.resources.length > 0) return yield* fail(p, messageError('can only use local files by -f pod.yaml or --filename=pod.json when --local=true is set'));
    if (isFilenameSliceEmpty(filenames, kustomize)) return yield* fail(p, messageError('one or more files must be specified as -f pod.yaml or --filename=pod.json'));
  } else if (split.resources.length < 1 && isFilenameSliceEmpty(filenames, kustomize)) {
    return yield* fail(p, messageError('one or more resources must be specified as <resource> <name> or <resource>/<name>'));
  }
  if (pairs.set.length < 1 && pairs.remove.length < 1 && !o.listing) return yield* fail(p, messageError('at least one label update is required'));
  // Run
  const found = yield* findObjects(inv, split.resources, o.local);
  if (typeof found === 'number') return found;
  if ('error' in found) return yield* fail(p, found.error);
  const one = found.singleItemImplied;
  if (!one && o.resourceVersion !== '') return yield* fail(p, messageError('--resource-version may only be used with a single resource'));
  return yield* visitAll(p, found, function* (info) {
    const obj = info.object;
    if (o.resourceVersion !== '') metaOf(obj).resourceVersion = '';
    const oldData = cloneJson(obj);
    let outputObj: JsonObject = obj;
    let msg: string;
    if (dryRun === 'client' || o.local || o.listing) {
      const r = labelFunc(obj, o.overwrite, o.resourceVersion, pairs);
      if ('type' in r) return r;
      msg = changeMessage(r);
    } else {
      const current = stringMap(obj, 'labels');
      for (const k of pairs.remove) if (!(k in current)) yield* p.write(1, `label ${goQuote(k)} not found.\n`);
      const r = labelFunc(obj, o.overwrite, o.resourceVersion, pairs);
      if ('type' in r) return r;
      msg = changeMessage(r);
      if (r.added > 0 || r.removed > 0) {
        const res = yield* patchObject(found.session as Session, info, createMergePatch(oldData, obj), dryRun, o.fieldManager);
        if ('error' in res) return res.error;
        outputObj = res.ok;
      }
    }
    if (o.listing) {
      yield* list(p, 'labels', info, outputObj, one);
      return undefined;
    }
    // A printer per object: YAML documents get no separator.
    const printer = toPrinter(o.output, msg, dryRun, o.template);
    if ('type' in printer) return printer;
    return yield* print(p, printer, info.object);
  });
}

// ---- annotate ----

function* runAnnotate(inv: Invocation): Op<number> {
  const { p, flags } = inv;
  const v = flags.values;
  // ToOptions
  const dryRun = yield* dryRunStrategy(p, str(v['dry-run']));
  if (typeof dryRun !== 'string') return yield* fail(p, dryRun);
  const o = commonOf(inv, dryRun);
  const split = resourcesAndPairs(inv.args, 'annotation');
  if ('type' in split) return yield* fail(p, split);
  const pairs = parseAnnotations(split.pairs);
  if ('type' in pairs) return yield* fail(p, pairs);
  if (o.listing && o.output !== '') return yield* fail(p, messageError('--list and --output may not be specified together'));
  if (v.all === true && str(v.selector) !== '') return yield* fail(p, messageError('cannot set --all and --selector at the same time'));
  if (v.all === true && str(v['field-selector']) !== '') return yield* fail(p, messageError('cannot set --all and --field-selector at the same time'));
  const filenames = (v.filename as string[] | undefined) ?? [];
  const kustomize = str(v.kustomize);
  if (!o.local) {
    if (split.resources.length < 1 && isFilenameSliceEmpty(filenames, kustomize)) {
      return yield* fail(p, messageError('one or more resources must be specified as <resource> <name> or <resource>/<name>'));
    }
  } else {
    if (dryRun === 'server') return yield* fail(p, messageError('cannot specify --local and --dry-run=server - did you mean --dry-run=client?'));
    if (split.resources.length > 0) return yield* fail(p, messageError('can only use local files by -f rsrc.yaml or --filename=rsrc.json when --local=true is set'));
    if (isFilenameSliceEmpty(filenames, kustomize)) return yield* fail(p, messageError('one or more files must be specified as -f rsrc.yaml or --filename=rsrc.json'));
  }
  if (pairs.set.length < 1 && pairs.remove.length < 1 && !o.listing) return yield* fail(p, messageError('at least one annotation update is required'));
  const both = validateAnnotations(pairs);
  if (both) return yield* fail(p, both);
  const printer = toPrinter(o.output, 'annotated', dryRun, o.template);
  if ('type' in printer) return yield* fail(p, printer);
  // RunAnnotate
  const found = yield* findObjects(inv, split.resources, o.local);
  if (typeof found === 'number') return found;
  if ('error' in found) return yield* fail(p, found.error);
  const one = found.singleItemImplied;
  if (!one && o.resourceVersion !== '') return yield* fail(p, messageError('--resource-version may only be used with a single resource'));
  return yield* visitAll(p, found, function* (info) {
    const obj = info.object;
    let outputObj: JsonObject = obj;
    if (dryRun === 'client' || o.local || o.listing) {
      const err = updateAnnotations(obj, o.overwrite, o.resourceVersion, pairs);
      if (err) return err;
    } else {
      if (o.resourceVersion !== '') metaOf(obj).resourceVersion = '';
      const oldData = cloneJson(obj);
      const err = updateAnnotations(obj, o.overwrite, o.resourceVersion, pairs);
      if (err) return err;
      const res = yield* patchObject(found.session as Session, info, createMergePatch(oldData, obj), dryRun, o.fieldManager);
      if ('error' in res) return res.error;
      outputObj = res.ok;
    }
    if (o.listing) {
      yield* list(p, 'annotations', info, outputObj, one);
      return undefined;
    }
    return yield* print(p, printer, outputObj);
  });
}

const NO_EFFECT = {
  'allow-missing-template-keys': 'only used by template output formats, which print a notice',
  'show-managed-fields': 'objects have no managedFields (DIV-015)',
};
const PARTIAL = {
  filename: 'URLs (http://, https://) print a notice: the simulated machines have no network access',
  kustomize: 'prints a notice: kustomize is not simulated',
  output: 'kyaml and the template formats print a notice',
  template: 'prints a notice: template output is not simulated',
  'all-namespaces': 'with -f prints a notice',
};

export const labelVerb: Verb = {
  path: 'label',
  flags: flags('kubectl-label', false),
  noEffect: NO_EFFECT,
  partial: PARTIAL,
  outputFormats: { allowed: CHANGE_FORMATS, simulated: ['json', 'yaml', 'name'] },
  run: runLabel,
};

export const annotateVerb: Verb = {
  path: 'annotate',
  flags: flags('kubectl-annotate', true),
  noEffect: NO_EFFECT,
  partial: PARTIAL,
  outputFormats: { allowed: CHANGE_FORMATS, simulated: ['json', 'yaml', 'name'] },
  run: runAnnotate,
};
