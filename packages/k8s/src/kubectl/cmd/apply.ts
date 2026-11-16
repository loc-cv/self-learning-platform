// kubectl apply -f (client-side apply): every object of the manifests is fetched; one that does
// not exist is created with the last-applied-configuration annotation, one that does is patched
// with the three-way strategic merge of the last applied configuration, the manifest and the live
// object. Each prints `created`, `configured` or `unchanged`; -o yaml|json prints the objects at
// the end, as one List when there are several.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/apply/apply.go NewCmdApply, AddFlags, ToOptions
//             (Unexpected args, the dry-run strategy, DeleteFlags.ToOptions, RequireFilenameOrKustomize,
//             the validation directive), Validate, GetObjects (the builder with ContinueOnError),
//             Run, applyOneObject (generate name, GetModifiedConfiguration, info.Get, the create
//             path with CreateApplyAnnotation and pruneNulls, warningNoLastAppliedConfigAnnotation,
//             the patch, "unchanged" for "{}", WarnIfDeleting), shouldPrintObject, printObjects,
//             GetApplyFieldManagerFlag
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/apply/patcher.go Patch (five retries on a
//             conflict, the first without back-off, then 1 s), patchSimple (OpenAPI v3, then v2,
//             then the built-in types; the warnings when computing the patch fails), PatchLocal,
//             createPatchErrFormat
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/delete/delete_flags.go parseCascadingFlag
//   upstream: staging/src/k8s.io/cli-runtime/pkg/resource/visitor.go Info.String;
//             staging/src/k8s.io/client-go/rest/request.go Name ("resource name may not be empty")
//   fixtures/golden/v1.37.2/apply/created-configured-unchanged.yaml, apply/three-way.yaml,
//   apply/overwrite.yaml, errors/validation.yaml, create/no-server.yaml

import type { Op, ProcApi } from '@simlab/host';
import { isObject, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { compareGoStrings } from '../../apimachinery/yaml/gofmt.ts';
import { marshalJson, printJson } from '../../apimachinery/yaml/jsonprint.ts';
import { createThreeWayMergePatch, strategicMergePatch } from '../../apimachinery/strategicpatch/index.ts';
import type { Status } from '../../apimachinery/errors.ts';
import { schema } from '../../openapi/schema.ts';
import type { Invocation, Verb } from '../cli/command.ts';
import { messageError, type KubectlError } from '../cli/errors.ts';
import type { FlagDef } from '../cli/flagset.ts';
import type { Mapping } from '../client/restmapper.ts';
import { fail, overridesOf, request, resolveConfig, type Session } from '../client/session.ts';
import { continueOnError, visitFiles } from '../resource/files.ts';
import { openServer, sessionOf } from '../resource/server.ts';
import { createApplyAnnotation, encodeUnstructured, LAST_APPLIED, modifiedConfiguration, originalConfiguration, pruneNulls } from '../util/apply.ts';
import { addSourceToErr, CHANGE_FORMATS, clearResourceVersionForCreate, DRY_RUN_NO_OPT, dryRunStrategy, goStrings, parseBool, toPrinter, usageError, validationDirective, type DryRun, type FieldValidation, type Printer } from './helpers.ts';
import { parseYaml, YamlMarshalError } from './printing.ts';

const FLAGS: FlagDef[] = [
  { name: 'filename', shorthand: 'f', kind: 'stringSlice', default: [] },
  { name: 'recursive', shorthand: 'R', kind: 'bool', default: false },
  { name: 'kustomize', shorthand: 'k', kind: 'string', default: '' },
  { name: 'validate', kind: 'string', default: 'strict', noOptDefVal: 'strict' },
  { name: 'dry-run', kind: 'string', default: 'none', noOptDefVal: DRY_RUN_NO_OPT },
  { name: 'output', shorthand: 'o', kind: 'string', default: '' },
  { name: 'template', kind: 'string', default: '' },
  { name: 'selector', shorthand: 'l', kind: 'string', default: '' },
  { name: 'field-manager', kind: 'string', default: 'kubectl-client-side-apply' },
  { name: 'overwrite', kind: 'bool', default: true },
  { name: 'force', kind: 'bool', default: false },
  { name: 'cascade', kind: 'string', default: 'background', noOptDefVal: 'background' },
  { name: 'server-side', kind: 'bool', default: false },
  { name: 'force-conflicts', kind: 'bool', default: false },
  { name: 'prune', kind: 'bool', default: false },
  { name: 'all', kind: 'bool', default: false },
  { name: 'prune-allowlist', kind: 'stringArray', default: [] },
  { name: 'subresource', kind: 'string', default: '' },
  { name: 'openapi-patch', kind: 'bool', default: true },
];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** parseCascadingFlag: the error, or undefined (a boolean value prints its deprecation warning). */
function* parseCascade(p: ProcApi, value: string): Op<KubectlError | undefined> {
  const b = parseBool(value);
  if (b === undefined) {
    if (['orphan', 'foreground', 'background'].includes(value)) return undefined;
    return messageError(`invalid cascade value (${value}). Must be "background", "foreground", or "orphan"`);
  }
  yield* p.write(2, `warning: --cascade=${value} is deprecated (boolean value) and can be replaced with --cascade=${b ? 'background' : 'orphan'}.\n`);
  return undefined;
}

interface Options {
  dryRun: DryRun;
  directive: FieldValidation;
  fieldManager: string;
  overwrite: boolean;
  force: boolean;
  openApiPatch: boolean;
  output: string;
  template: string;
}

interface Info {
  source: string;
  object: JsonObject;
  mapping: Mapping;
  namespace: string;
  name: string;
}

/** Info.String() */
function infoString(i: Info): string {
  const m = i.mapping;
  return `Resource: "${m.group}/${m.version}, Resource=${m.resource}", GroupVersionKind: "${m.group}/${m.version}, Kind=${m.kind}"\nName: ${JSON.stringify(i.name)}, Namespace: ${JSON.stringify(i.namespace)}`;
}

/** shouldPrintObject: -o other than name prints the objects at the end instead of a line each. */
function printsObjects(o: Options): boolean {
  return o.output !== '' && o.output !== 'name';
}

function apiVersionOf(m: Mapping): string {
  return m.group === '' ? m.version : `${m.group}/${m.version}`;
}

function base(i: Info): { group: string; version: string; resource: string; namespace?: string } {
  return { group: i.mapping.group, version: i.mapping.version, resource: i.mapping.resource, ...(i.mapping.namespaced ? { namespace: i.namespace } : {}) };
}

type Step = { ok: true } | { error: KubectlError } | { notice: string };

/** Prints one object's outcome through a printer made for the operation, as applyOneObject does. */
function* printOutcome(p: ProcApi, o: Options, operation: string, obj: JsonObject): Op<Step> {
  if (printsObjects(o)) return { ok: true };
  const printer = toPrinter(o.output, operation, o.dryRun, o.template);
  if ('type' in printer) return printer.type === 'notSimulated' ? { notice: printer.what } : { error: printer };
  yield* p.write(1, printer.print(obj));
  return { ok: true };
}

type PatchOutcome = { patch: string; object: JsonObject } | { patch: string; error: KubectlError } | { notice: string };

/** patchSimple: the patch and the patched object (sent, or applied locally for --dry-run=client). */
function* patchSimple(s: Session, i: Info, current: JsonObject, modified: string, o: Options, local: boolean): Op<PatchOutcome> {
  const p = s.p;
  const original = originalConfiguration(current);
  const t = schema().kind(apiVersionOf(i.mapping), i.mapping.kind);
  if (!t) return { notice: `kubectl apply of a ${i.mapping.kind}: a kind without a built-in type is patched with a JSON merge patch, which is not simulated` };
  let originalObj: JsonObject | undefined;
  if (original !== undefined && original !== '') {
    const parsed = parseJsonObject(original);
    if (!parsed) return { notice: 'a last-applied-configuration annotation that is not a JSON object' };
    originalObj = parsed;
  }
  const modifiedObj = parseJsonObject(modified) as JsonObject;
  const r = createThreeWayMergePatch(originalObj, modifiedObj, current, t.id, o.overwrite);
  if ('error' in r) {
    // The OpenAPI v3 and v2 attempts fail the same way before the built-in types are tried.
    if (o.openApiPatch) {
      yield* p.write(2, `warning: error calculating patch from openapi v3 spec: ${r.error}\nwarning: error calculating patch from openapi spec: ${r.error}\n`);
    }
    return { patch: '', error: messageError(`creating patch with:\noriginal:\n${original ?? ''}\nmodified:\n${modified}\ncurrent:\n${encodeUnstructured(current)}\nfor: ${r.error}`) };
  }
  const patch = marshalJson(r.ok, { sortKeys: true });
  if (patch === '{}') return { patch, object: current };
  if (local) {
    const applied = strategicMergePatch(current, r.ok, t.id);
    if ('error' in applied) return { patch, error: messageError(`applying patch locally: ${applied.error}`) };
    return { patch, object: applied.ok };
  }
  const res = yield* request(s, {
    verb: 'patch',
    ...base(i),
    name: i.name,
    body: r.ok,
    options: { patchType: 'strategic', fieldManager: o.fieldManager, fieldValidation: o.directive, ...(o.dryRun === 'server' ? { dryRun: true } : {}) },
  });
  if (!res.ok) {
    if ('notSimulated' in res) return { notice: res.notSimulated };
    return { patch, error: { type: 'status', status: res.status } };
  }
  return { patch, object: res.object as JsonObject };
}

function parseJsonObject(text: string): JsonObject | undefined {
  try {
    const v = JSON.parse(text) as Json;
    return isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

const isStatus = (e: KubectlError, reason: string): e is { type: 'status'; status: Status } => e.type === 'status' && e.status.reason === reason;

/** Patcher.Patch: patchSimple, retried after a conflict with the object fetched again. */
function* patchWithRetries(s: Session, i: Info, live: JsonObject, modified: string, o: Options): Op<PatchOutcome> {
  let current = live;
  let r = yield* patchSimple(s, i, current, modified, o, false);
  for (let n = 1; n <= 5 && 'error' in r && isStatus(r.error, 'Conflict'); n++) {
    if (n > 1) yield* s.p.sleep(1000);
    const g = yield* request(s, { verb: 'get', ...base(i), name: i.name });
    if (!g.ok) return 'notSimulated' in g ? { notice: g.notSimulated } : { patch: '', error: { type: 'status', status: g.status } };
    current = g.object as JsonObject;
    r = yield* patchSimple(s, i, current, modified, o, false);
  }
  if ('error' in r) {
    if ((isStatus(r.error, 'Conflict') || isStatus(r.error, 'Invalid')) && o.force) {
      return { notice: 'kubectl apply --force replacing an object the patch cannot change (delete and create again)' };
    }
    return { patch: r.patch, error: addSourceToErr('patching', i.source, r.error) };
  }
  return r;
}

/** applyOneObject: undefined when done, or the error. */
function* applyOne(p: ProcApi, s: Session | undefined, i: Info, o: Options): Op<Step> {
  if (i.name === '') {
    const gen = isObject(i.object.metadata) ? str(i.object.metadata.generateName) : '';
    if (gen !== '') return { error: messageError(`from ${gen}: cannot use generate name with apply`) };
  }
  const modified = modifiedConfiguration(i.object, true);
  // info.Get: client-go refuses a request for an empty name before sending it.
  if (i.name === '') {
    return { error: addSourceToErr(`retrieving current configuration of:\n${infoString(i)}\nfrom server for:`, i.source, messageError('resource name may not be empty')) };
  }
  if (!s) return { notice: 'kubectl apply with no server listening' };
  const g = yield* request(s, { verb: 'get', ...base(i), name: i.name });
  if (!g.ok && 'notSimulated' in g) return { notice: g.notSimulated };
  if (!g.ok && g.status.reason !== 'NotFound') {
    return { error: addSourceToErr(`retrieving current configuration of:\n${infoString(i)}\nfrom server for:`, i.source, { type: 'status', status: g.status }) };
  }
  if (!g.ok) {
    // The create path: the annotation, then nulls pruned, as an update would persist them.
    createApplyAnnotation(i.object);
    pruneNulls(i.object);
    if (o.dryRun !== 'client') {
      // helper.Create(namespace, true, obj): after the annotation, so last-applied keeps it.
      clearResourceVersionForCreate(i.object);
      const c = yield* request(s, { verb: 'create', ...base(i), body: i.object, options: { fieldManager: o.fieldManager, fieldValidation: o.directive, ...(o.dryRun === 'server' ? { dryRun: true } : {}) } });
      if (!c.ok) {
        if ('notSimulated' in c) return { notice: c.notSimulated };
        return { error: addSourceToErr('creating', i.source, { type: 'status', status: c.status }) };
      }
      i.object = c.object as JsonObject;
    }
    return yield* printOutcome(p, o, 'created', i.object);
  }
  const live = g.object as JsonObject;
  const annotations = isObject(live.metadata) && isObject(live.metadata.annotations) ? live.metadata.annotations : {};
  if (!(LAST_APPLIED in annotations)) {
    // info.ObjectName(): the mapping's plural resource (Mapping.Resource.Resource, no group), then the name.
    yield* p.write(2, `Warning: resource ${i.mapping.resource}/${i.name} is missing the ${LAST_APPLIED} annotation which is required by kubectl apply. kubectl apply should only be used on resources created declaratively by either kubectl create --save-config or kubectl apply. The missing annotation will be patched automatically.\n`);
  }
  const r = o.dryRun === 'client' ? yield* patchSimple(s, i, live, modified, o, true) : yield* patchWithRetries(s, i, live, modified, o);
  if ('notice' in r) return r;
  if ('error' in r) return { error: addSourceToErr(`applying patch:\n${r.patch}\nto:\n${infoString(i)}\nfor:`, i.source, r.error) };
  i.object = r.object;
  if (isObject(r.object.metadata) && r.object.metadata.deletionTimestamp) {
    yield* p.write(2, `Warning: Detected changes to resource ${str(r.object.metadata.name)} which is currently being deleted.\n`);
  }
  return yield* printOutcome(p, o, r.patch === '{}' ? 'unchanged' : 'configured', i.object);
}

/** A copy with every map's keys in encoding/json's order (an unstructured object inside a typed List). */
function sortedDeep(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortedDeep);
  if (!isObject(v)) return v;
  const out: JsonObject = {};
  for (const k of Object.keys(v).sort(compareGoStrings)) out[k] = sortedDeep(v[k] as Json);
  return out;
}

/** printObjects: one object, or a corev1.List (TypeMeta, then an empty ListMeta, then the items). */
function* printObjects(p: ProcApi, infos: Info[], o: Options): Op<Step> {
  if (!printsObjects(o) || infos.length === 0) return { ok: true };
  const printer: Printer | KubectlError = toPrinter(o.output, '', o.dryRun, o.template);
  if ('type' in printer) return printer.type === 'notSimulated' ? { notice: printer.what } : { error: printer };
  const list = infos.length > 1;
  const obj: JsonObject = list ? { kind: 'List', apiVersion: 'v1', metadata: {}, items: infos.map((i) => sortedDeep(i.object)) } : (infos[0] as Info).object;
  try {
    // JSONPrinter marshals the typed List in its struct order; YAML sorts every map.
    yield* p.write(1, list && o.output.toLowerCase() === 'json' ? printJson(obj) : printer.print(obj));
  } catch (e) {
    if (!(e instanceof YamlMarshalError)) throw e;
    return { error: messageError(e.message) };
  }
  return { ok: true };
}

function* run(inv: Invocation): Op<number> {
  const { p, flags } = inv;
  const v = flags.values;
  // ToOptions
  if (inv.args.length !== 0) return yield* fail(p, usageError('apply', `Unexpected args: ${goStrings(inv.args)}`));
  const serverSide = v['server-side'] === true;
  const dryRun = yield* dryRunStrategy(p, str(v['dry-run']));
  if (typeof dryRun !== 'string') return yield* fail(p, dryRun);
  const config = resolveConfig(p, overridesOf(v), parseYaml);
  if ('type' in config) return yield* fail(p, config);
  const server = yield* openServer(p, config);
  if (typeof server === 'number') return server;
  const fieldManager = flags.changed.includes('field-manager') ? str(v['field-manager']) : serverSide ? 'kubectl' : 'kubectl-client-side-apply';
  const cascadeErr = yield* parseCascade(p, str(v.cascade));
  if (cascadeErr) return yield* fail(p, cascadeErr);
  const filenames = (v.filename as string[] | undefined) ?? [];
  const kustomize = str(v.kustomize);
  if (filenames.length === 0 && kustomize === '') return yield* fail(p, messageError('must specify one of -f and -k'));
  const directive = validationDirective(str(v.validate));
  if (typeof directive !== 'string') return yield* fail(p, directive);
  const force = v.force === true;
  const prune = v.prune === true;
  const selector = str(v.selector);
  // Validate
  const invalid = (m: string) => fail(p, messageError(m));
  if (v['force-conflicts'] === true && !serverSide) return yield* invalid('--force-conflicts only works with --server-side');
  if (dryRun === 'client' && serverSide) return yield* invalid("--dry-run=client doesn't work with --server-side (did you mean --dry-run=server instead?)");
  if (serverSide && force) return yield* invalid('--force cannot be used with --server-side');
  if (dryRun === 'server' && force) return yield* invalid('--dry-run=server cannot be used with --force');
  if (v.all === true && selector !== '') return yield* invalid('cannot set --all and --selector at the same time');
  if (prune) {
    if (force) return yield* invalid('--force cannot be used with --prune');
    if (v.all !== true && selector === '') {
      return yield* invalid(
        'all resources selected for prune without explicitly passing --all. To prune all resources, pass the --all flag. If you did not mean to prune all resources, specify a label selector',
      );
    }
    if (serverSide) return yield* invalid("--prune is in alpha and doesn't currently work on objects created by server-side apply");
  }
  if (str(v.subresource) !== '' && !serverSide) return yield* invalid('--subresource can only be specified for --server-side');
  if (serverSide) return yield* p.unsupported({ kind: 'flag', what: 'the flag --server-side (server-side apply)' });
  if (prune) return yield* p.unsupported({ kind: 'flag', what: 'the flag --prune' });
  const o: Options = {
    dryRun,
    directive,
    fieldManager,
    overwrite: v.overwrite !== false,
    force,
    openApiPatch: v['openapi-patch'] !== false,
    output: str(v.output),
    template: str(v.template),
  };
  // Run: GetObjects
  const items = yield* visitFiles(p, { filenames, recursive: v.recursive === true, ...(kustomize ? { kustomize } : {}) }, config.namespace, config.explicitNamespace, {
    ...(directive !== 'Ignore' ? { validation: directive } : {}),
    selector,
    server,
  });
  const errs: KubectlError[] = [];
  const infos: Info[] = [];
  if (!Array.isArray(items)) {
    if (items.type === 'notSimulated') return yield* fail(p, items);
    errs.push(items);
  } else {
    const visitErrors: KubectlError[] = [];
    const readErrors: KubectlError[] = [];
    for (const item of items) {
      if ('error' in item) (item.stage === 'read' ? readErrors : visitErrors).push(item.error);
      else infos.push({ ...item });
    }
    const err = continueOnError(visitErrors, readErrors);
    if (err) errs.push(err);
  }
  if (infos.length === 0 && errs.length === 0) return yield* fail(p, messageError('no objects passed to apply'));
  const session = sessionOf(server);
  for (const info of infos) {
    const r = yield* applyOne(p, session, info, o);
    if ('notice' in r) return yield* p.unsupported({ kind: 'behavior', what: r.notice });
    if ('error' in r) errs.push(r.error);
  }
  if (errs.length === 1) return yield* fail(p, errs[0] as KubectlError);
  if (errs.length > 1) return yield* fail(p, { type: 'aggregate', errors: errs });
  // PostProcessorFn: printObjects (no prune: it printed its notice).
  const printed = yield* printObjects(p, infos, o);
  if ('notice' in printed) return yield* p.unsupported({ kind: 'output-format', what: printed.notice });
  if ('error' in printed) return yield* fail(p, printed.error);
  return 0;
}

export const applyVerb: Verb = {
  path: 'apply',
  flags: FLAGS,
  noEffect: {
    'grace-period': 'only used when --force deletes an object or --prune deletes them, which print a notice',
    timeout: 'only used when --force deletes an object, which prints a notice',
    wait: 'only used when --prune deletes objects, which prints a notice',
    'allow-missing-template-keys': 'only used by template output formats, which print a notice',
    'show-managed-fields': 'objects have no managedFields (DIV-015)',
  },
  partial: {
    filename: 'URLs (http://, https://) print a notice: the simulated machines have no network access',
    kustomize: 'prints a notice: kustomize is not simulated',
    output: 'kyaml and the template formats print a notice',
    template: 'prints a notice: template output is not simulated',
    'openapi-patch': 'the patch strategies come from the built-in Go types either way, which the OpenAPI extensions mirror; false drops the warnings of a failed patch',
    force: 'replacing an object the patch cannot change prints a notice',
    'server-side': 'prints a notice after the flag checks: server-side apply is not simulated',
    prune: 'prints a notice after the flag checks: pruning is not simulated',
    'prune-allowlist': 'only used with --prune, which prints a notice',
    all: 'only used with --prune, which prints a notice',
    'force-conflicts': 'only valid with --server-side, which prints a notice',
    subresource: 'only valid with --server-side, which prints a notice',
  },
  outputFormats: { allowed: CHANGE_FORMATS, simulated: ['json', 'yaml', 'name'] },
  run,
};
