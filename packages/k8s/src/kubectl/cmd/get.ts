// kubectl get: list or fetch objects and print them as tables (server-side Tables), YAML, JSON or
// names, and watch them with -w.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/get/get.go NewCmdGet (flags), Complete, Validate,
//             Run (one tab writer, a new printer and a blank line per mapping, multipleGVKsRequested,
//             "No resources found"), printGeneric (the List wrapper, singleItemImplied), watch,
//             transformRequests (as=Table only for human-readable output with server print)
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/get/get_flags.go ToPrinter, AllowedFormats;
//             staging/src/k8s.io/cli-runtime/pkg/printers/name.go NamePrinter
//   upstream: staging/src/k8s.io/kubectl/pkg/util/interrupt (Ctrl-C ends a watch with status 1)
//   upstream: staging/src/k8s.io/cli-runtime/pkg/resource/builder.go IgnoreErrors, ContinueOnError

import type { Op } from '@simlab/host';
import { isObject, type Json, type JsonObject } from '../../apimachinery/json.ts';
import type { ApiRequest, RequestOptions } from '../../apiserver/types.ts';
import type { Status } from '../../apimachinery/errors.ts';
import type { Invocation, Verb } from '../cli/command.ts';
import { messageError, type KubectlError } from '../cli/errors.ts';
import type { FlagDef } from '../cli/flagset.ts';
import type { Mapping } from '../client/restmapper.ts';
import { closeWatch, fail, openProcessWatch, openSession, overridesOf, request, resolveConfig, takeWatchEvents, type Session } from '../client/session.ts';
import { argumentError, buildPlan, type Plan, type Visit } from '../resource/builder.ts';
import { newTablePrinter, parseYaml, toJson, toYaml, YamlMarshalError, type TablePrinter } from './printing.ts';

const FLAGS: FlagDef[] = [
  { name: 'all-namespaces', shorthand: 'A', kind: 'bool', default: false },
  { name: 'output', shorthand: 'o', kind: 'string', default: '' },
  { name: 'selector', shorthand: 'l', kind: 'string', default: '' },
  { name: 'field-selector', kind: 'string', default: '' },
  { name: 'show-labels', kind: 'bool', default: false },
  { name: 'label-columns', shorthand: 'L', kind: 'stringSlice', default: [] },
  { name: 'no-headers', kind: 'bool', default: false },
  { name: 'show-kind', kind: 'bool', default: false },
  { name: 'watch', shorthand: 'w', kind: 'bool', default: false },
  { name: 'ignore-not-found', kind: 'bool', default: false },
  { name: 'server-print', kind: 'bool', default: true },
  { name: 'output-watch-events', kind: 'bool', default: false },
  { name: 'chunk-size', kind: 'int64', default: 500 },
  { name: 'allow-missing-template-keys', kind: 'bool', default: true },
  { name: 'show-managed-fields', kind: 'bool', default: false },
];

/** get_flags.go AllowedFormats, sorted as the error lists them. */
const ALLOWED_FORMATS = [
  'custom-columns',
  'custom-columns-file',
  'go-template',
  'go-template-file',
  'json',
  'jsonpath',
  'jsonpath-as-json',
  'jsonpath-file',
  'kyaml',
  'name',
  'template',
  'templatefile',
  'wide',
  'yaml',
];
/** Formats the simulator prints. */
const SIMULATED_FORMATS = new Set(['', 'wide', 'json', 'yaml', 'name']);

type Format = 'table' | 'wide' | 'json' | 'yaml' | 'name';

interface Options {
  namespace: string;
  allNamespaces: boolean;
  format: Format;
  /** The -o value as given. */
  output: string;
  labelSelector?: string;
  fieldSelector?: string;
  showLabels: boolean;
  labelColumns: string[];
  noHeaders: boolean;
  showKind: boolean;
  ignoreNotFound: boolean;
  watch: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The name of the format of an -o value (`jsonpath={..}` → jsonpath). */
function formatName(output: string): string {
  const i = output.indexOf('=');
  return i >= 0 ? output.slice(0, i) : output;
}

function* run(inv: Invocation): Op<number> {
  const { p, flags } = inv;
  const v = flags.values;
  const output = str(v.output);
  // Complete: the namespace from the kubeconfig and flags.
  const overrides = overridesOf(v);
  const config = resolveConfig(p, overrides, parseYaml);
  if ('type' in config) return yield* fail(p, config);
  const allNamespaces = v['all-namespaces'] === true;
  const watch = v.watch === true;
  if (inv.args.length === 0 && !watch) {
    yield* p.write(2, 'You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.\n\n');
    return yield* fail(
      p,
      messageError(
        'Required resource not specified.\nUse "kubectl explain <resource>" for a detailed description of that resource (e.g. kubectl explain pods).\nSee \'kubectl get -h\' for help and examples',
      ),
    );
  }
  // Validate
  if (v['show-labels'] === true && output !== '' && output !== 'wide') {
    return yield* fail(p, messageError(`--show-labels option cannot be used with ${output} printer`));
  }
  const labelColumns = (v['label-columns'] as string[] | undefined) ?? [];
  if (labelColumns.length > 0 && output.startsWith('custom-columns')) {
    return yield* fail(p, messageError(`--label-columns option cannot be used with ${output} printer`));
  }
  if (v['output-watch-events'] === true && !watch) {
    return yield* fail(p, messageError('--output-watch-events option can only be used with --watch or --watch-only'));
  }
  if (v['output-watch-events'] === true) return yield* p.unsupported({ kind: 'flag', what: 'the flag --output-watch-events' });
  if (v['server-print'] === false) return yield* p.unsupported({ kind: 'flag-value', what: 'the flag --server-print=false' });
  const fmt = formatName(output);
  const argErr = argumentError(inv.args);
  if (argErr) return yield* fail(p, argErr);
  // Run: discovery (and with it the connection) comes before any printer is chosen.
  const session = yield* openSession(p, config);
  if (typeof session === 'number') return session;
  const plan = buildPlan({
    args: inv.args,
    namespace: config.namespace,
    allNamespaces,
    ...(flags.changed.includes('selector') ? { labelSelector: str(v.selector) } : {}),
    ...(flags.changed.includes('field-selector') ? { fieldSelector: str(v['field-selector']) } : {}),
    singleResourceType: watch,
  });
  if ('type' in plan) return yield* fail(p, plan);
  if (ALLOWED_FORMATS.includes(fmt) && !SIMULATED_FORMATS.has(fmt)) {
    return yield* p.unsupported({ kind: 'output-format', what: `the output format "${fmt}"` });
  }
  const o: Options = {
    namespace: config.namespace,
    allNamespaces,
    format: output === '' ? 'table' : (output as Format),
    output,
    showLabels: v['show-labels'] === true,
    labelColumns,
    noHeaders: v['no-headers'] === true,
    showKind: v['show-kind'] === true,
    ignoreNotFound: v['ignore-not-found'] === true,
    watch,
  };
  if (watch) return yield* runWatch(session, plan, o);
  if (o.format === 'table' || o.format === 'wide') return yield* printHuman(session, plan, o);
  return yield* printGeneric(session, plan, o);
}

// ---- fetching ----

interface Info {
  mapping: Mapping;
  /** The object, a list's item (with apiVersion and kind), or a Table. */
  object: JsonObject;
  namespaced: boolean;
}

function requestFor(visit: Visit, table: boolean): ApiRequest {
  const m = visit.mapping;
  const options: RequestOptions = table ? { as: 'Table' } : {};
  if (visit.kind === 'list') {
    if (visit.labelSelector !== '') options.labelSelector = visit.labelSelector;
    if (visit.fieldSelector !== '') options.fieldSelector = visit.fieldSelector;
    return { verb: 'list', group: m.group, version: m.version, resource: m.resource, ...(visit.namespace ? { namespace: visit.namespace } : {}), options };
  }
  return { verb: 'get', group: m.group, version: m.version, resource: m.resource, ...(visit.namespace ? { namespace: visit.namespace } : {}), name: visit.name, options };
}

function apiVersionOf(m: Mapping): string {
  return m.group === '' ? m.version : `${m.group}/${m.version}`;
}

/**
 * Fetches every visit (the builder's visitors with ContinueOnError): infos and errors in order.
 * Lists are flattened into their items unless `table` (a Table stays one info).
 */
function* fetch(s: Session, plan: Plan, o: Options, table: boolean): Op<{ infos: Info[]; errors: KubectlError[]; lists: JsonObject[] } | number> {
  const infos: Info[] = [];
  const errors: KubectlError[] = [];
  const lists: JsonObject[] = [];
  for (const visit of plan.visits) {
    const r = yield* request(s, requestFor(visit, table));
    if (!r.ok) {
      if ('notSimulated' in r) {
        // A category names every type that could hold its objects; one whose objects cannot exist
        // in the simulator holds none (docs/decisions.md D-066).
        if (visit.kind === 'list' && visit.fromCategory) continue;
        return yield* s.p.unsupported({ kind: 'resource', what: `the resource type "${visit.mapping.resource}${visit.mapping.group ? `.${visit.mapping.group}` : ''}"` });
      }
      let status = visit.kind === 'list' ? enhanceListError(r.status, visit) : r.status;
      // Info.Get: an object not found outside default may be missing because its namespace is.
      // upstream: staging/src/k8s.io/cli-runtime/pkg/resource/visitor.go Info.Get
      if (visit.kind === 'get' && status.reason === 'NotFound' && visit.namespace !== '' && visit.namespace !== 'default') {
        const ns = yield* request(s, { verb: 'get', group: '', version: 'v1', resource: 'namespaces', name: visit.namespace });
        if (!ns.ok && !('notSimulated' in ns) && ns.status.reason === 'NotFound') status = ns.status;
      }
      if (o.ignoreNotFound && status.reason === 'NotFound') continue;
      errors.push({ type: 'status', status });
      continue;
    }
    const obj = r.object as JsonObject;
    if (table || visit.kind === 'get') {
      infos.push({ mapping: visit.mapping, object: obj, namespaced: visit.mapping.namespaced });
      continue;
    }
    lists.push(obj);
    // UnstructuredList decoding gives each item the list's apiVersion and its kind.
    for (const item of (obj.items as JsonObject[] | undefined) ?? []) {
      infos.push({ mapping: visit.mapping, object: { apiVersion: apiVersionOf(visit.mapping), kind: visit.mapping.kind, ...item }, namespaced: visit.mapping.namespaced });
    }
  }
  return { infos, errors, lists };
}

/**
 * resource.EnhanceListError: a list's BadRequest or NotFound names what was listed.
 * upstream: staging/src/k8s.io/cli-runtime/pkg/resource/helper.go EnhanceListError (the subject
 * is the mapping's GroupVersionResource, printed `<group>/<version>, Resource=<resource>`).
 */
function enhanceListError(status: Status, visit: Extract<Visit, { kind: 'list' }>): Status {
  if (status.reason !== 'BadRequest' && status.reason !== 'NotFound') return status;
  const m = visit.mapping;
  const subj = `${m.group}/${m.version}, Resource=${m.resource}`;
  const message =
    visit.labelSelector === '' && visit.fieldSelector === ''
      ? `Unable to list "${subj}": ${status.message ?? ''}`
      : `Unable to find "${subj}" that match label selector "${visit.labelSelector}", field selector "${visit.fieldSelector}": ${status.message ?? ''}`;
  return { ...status, message };
}

// ---- printing ----

function tablePrinter(o: Options, mapping: Mapping, withNamespace: boolean, withKind: boolean): TablePrinter {
  return newTablePrinter({
    wide: o.format === 'wide',
    noHeaders: o.noHeaders,
    showLabels: o.showLabels,
    labelColumns: o.labelColumns,
    withNamespace,
    withKind: withKind || o.showKind,
    groupKind: { group: mapping.group, kind: mapping.kind },
  });
}

function sameGvk(a: Mapping, b: Mapping): boolean {
  return a.group === b.group && a.version === b.version && a.kind === b.kind;
}

function* printHuman(s: Session, plan: Plan, o: Options): Op<number> {
  const p = s.p;
  const fetched = yield* fetch(s, plan, o, true);
  if (typeof fetched === 'number') return fetched;
  const { infos, errors } = fetched;
  const printWithKind = infos.length >= 2 && infos.some((i) => !sameGvk(i.mapping, (infos[0] as Info).mapping));
  let written = 0;
  let separator = false;
  let out = '';
  const emit = (text: string) => {
    if (text === '') return;
    if (separator) {
      out += '\n';
      separator = false;
    }
    out += text;
    written += text.length;
  };
  let printer: TablePrinter | undefined;
  let last: Mapping | undefined;
  let allNamespaced = !o.allNamespaces;
  for (const info of infos) {
    allNamespaced = allNamespaced && info.namespaced;
    const withNamespace = o.allNamespaces && info.mapping.namespaced;
    if (!printer || !last || info.mapping.resource !== last.resource) {
      if (printer) emit(printer.flush());
      if (last && !o.noHeaders && written > 0) separator = true;
      printer = tablePrinter(o, info.mapping, withNamespace, printWithKind);
      last = info.mapping;
    }
    printer.add(info.object);
  }
  if (printer) emit(printer.flush());
  if (out !== '') yield* p.write(1, out);
  if (written === 0 && !o.ignoreNotFound && errors.length === 0) {
    yield* p.write(2, allNamespaced ? `No resources found in ${o.namespace} namespace.\n` : 'No resources found\n');
  }
  if (errors.length === 0) return 0;
  return yield* fail(p, { type: 'aggregate', errors });
}

/** NamePrinter: `<kind>[.<group>]/<name>`, lower-cased kind. */
function nameOf(obj: JsonObject): string {
  const apiVersion = str(obj.apiVersion);
  const group = apiVersion.includes('/') ? apiVersion.slice(0, apiVersion.indexOf('/')) : '';
  const kind = str(obj.kind).toLowerCase();
  const name = isObject(obj.metadata) ? str(obj.metadata.name) : '';
  return `${group ? `${kind}.${group}` : kind}/${name}`;
}

function render(obj: JsonObject, format: Format): string {
  switch (format) {
    case 'json':
      return toJson(obj);
    case 'yaml':
      return toYaml(obj);
    case 'name': {
      const items = obj.kind === 'List' ? ((obj.items as JsonObject[] | undefined) ?? []) : [obj];
      return items.map((i) => `${nameOf(i)}\n`).join('');
    }
    default:
      throw new Error(`no generic printer for ${format}`);
  }
}

function* printGeneric(s: Session, plan: Plan, o: Options): Op<number> {
  const p = s.p;
  const fetched = yield* fetch(s, plan, o, false);
  if (typeof fetched === 'number') return fetched;
  const { infos, errors } = fetched;
  if (errors.length > 0 && plan.singleItemImplied) return yield* fail(p, errors[0] as KubectlError);
  if (infos.length === 0 && o.ignoreNotFound) return errors.length > 0 ? yield* fail(p, { type: 'aggregate', errors }) : 0;
  if (!['json', 'yaml', 'name'].includes(o.format)) {
    return yield* fail(p, messageError(`unable to match a printer suitable for the output format "${o.output}", allowed formats are: ${ALLOWED_FORMATS.join(',')}`));
  }
  let obj: JsonObject;
  if (!plan.singleItemImplied || infos.length !== 1) {
    obj = { apiVersion: 'v1', items: infos.map((i) => i.object as Json), kind: 'List', metadata: { resourceVersion: '' } };
  } else obj = (infos[0] as Info).object;
  // A printer's failure joins the errors (printGeneric: errs = append(errs, printErr)).
  let text = '';
  try {
    text = render(obj, o.format);
  } catch (e) {
    if (!(e instanceof YamlMarshalError)) throw e;
    errors.push(messageError(e.message));
  }
  if (text !== '') yield* p.write(1, text);
  if (errors.length === 0) return 0;
  return yield* fail(p, { type: 'aggregate', errors });
}

// ---- watch ----

function* runWatch(s: Session, plan: Plan, o: Options): Op<number> {
  const p = s.p;
  const table = o.format === 'table' || o.format === 'wide';
  if (!table && !['json', 'yaml', 'name'].includes(o.format)) {
    return yield* fail(p, messageError(`unable to match a printer suitable for the output format "${o.output}", allowed formats are: ${ALLOWED_FORMATS.join(',')}`));
  }
  const visit = plan.visits[0] as Visit;
  const r = yield* request(s, requestFor(visit, table));
  if (!r.ok) {
    if ('notSimulated' in r) return yield* p.unsupported({ kind: 'resource', what: `the resource type "${visit.mapping.resource}"` });
    if (r.status.reason === 'NotFound' && o.ignoreNotFound) return 0;
    return yield* fail(p, { type: 'status', status: r.status });
  }
  const first = r.object as JsonObject;
  const isList = visit.kind === 'list';
  // A list starts the watch at its resourceVersion; a single object at "0", whose synthetic
  // ADDED event is not printed.
  const rv = isList ? str(isObject(first.metadata) ? first.metadata.resourceVersion : '') : '0';
  const printer = table ? tablePrinter(o, visit.mapping, o.allNamespaces && visit.mapping.namespaced, false) : undefined;
  let yamlCount = 0;
  const show = (obj: JsonObject): string => {
    if (printer) {
      printer.add(obj);
      return printer.flush();
    }
    if (o.format === 'yaml') return (yamlCount++ > 0 ? '---\n' : '') + toYaml(obj);
    return render(obj, o.format);
  };
  let text = '';
  if (table || !isList) text = show(table ? first : withTypeMeta(first, visit.mapping));
  else for (const item of (first.items as JsonObject[] | undefined) ?? []) text += show(withTypeMeta(item, visit.mapping));
  if (text !== '') yield* p.write(1, text);
  const m = visit.mapping;
  const options: RequestOptions = { resourceVersion: rv, ...(table ? { as: 'Table' } : {}) };
  if (visit.kind === 'list') {
    if (visit.labelSelector !== '') options.labelSelector = visit.labelSelector;
    if (visit.fieldSelector !== '') options.fieldSelector = visit.fieldSelector;
  } else options.fieldSelector = `metadata.name=${visit.name}`;
  const w = openProcessWatch(s, { verb: 'watch', group: m.group, version: m.version, resource: m.resource, ...(visit.namespace ? { namespace: visit.namespace } : {}), options });
  if ('notSimulated' in w) return yield* p.unsupported({ kind: 'behavior', what: w.notSimulated });
  if ('status' in w) return yield* fail(p, { type: 'status', status: w.status });
  let skipFirst = !isList;
  p.trap(2, 'interrupt');
  try {
    for (;;) {
      let out = '';
      for (const e of takeWatchEvents(s, w.id)) {
        if (skipFirst) {
          // The synthetic ADDED event of a single object is not printed; get.go's skipPrinter
          // still hands the printer its Table without rows (its column definitions).
          skipFirst = false;
          if (printer) printer.add({ ...e.object, rows: null });
          continue;
        }
        out += show(table ? e.object : withTypeMeta(e.object, m));
      }
      if (out !== '') yield* p.write(1, out);
      try {
        yield* p.wait(w.topic);
      } catch (e) {
        if (e instanceof Error && e.name === 'Interrupted') return 1;
        throw e;
      }
    }
  } finally {
    closeWatch(s, w.id);
  }
}

function withTypeMeta(obj: JsonObject, m: Mapping): JsonObject {
  return obj.kind ? obj : { apiVersion: apiVersionOf(m), kind: m.kind, ...obj };
}

export const getVerb: Verb = {
  path: 'get',
  flags: FLAGS,
  noEffect: {
    'chunk-size': 'lists are paged in chunks; the printed result is the same',
    'allow-missing-template-keys': 'only matters to template output formats, which print a notice',
    'show-managed-fields': 'objects have no managedFields (DIV-015)',
  },
  run,
};

