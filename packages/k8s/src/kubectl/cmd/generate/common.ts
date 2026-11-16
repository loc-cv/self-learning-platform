// What the generator commands share: cobra's required-flag check, NameFromCommandArgs, the
// Complete steps every `create <kind>` runs (client config, --dry-run, the printer, --validate),
// the --save-config annotation of a typed object, the create request (typed client or resource
// helper) and the printing of a typed object.
//
// Generators build typed Go objects, so kubectl prints them as encoding/json marshals the struct:
// -o json keeps struct field order and drops omitempty zero values (`canonical` over the vendored
// Go types), and -o yaml is sigs.k8s.io/yaml over that JSON (keys sorted). The --save-config
// annotation is scheme.DefaultJSONEncoder's compact JSON of the typed object, also in struct order.
//   upstream: vendor/github.com/spf13/cobra/command.go ValidateRequiredFlags
//             (`required flag(s) "image" not set`, before Run)
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/create/create.go NameFromCommandArgs
//   upstream: staging/src/k8s.io/kubectl/pkg/util/apply.go GetModifiedConfiguration,
//             CreateApplyAnnotation, CreateOrUpdateAnnotation
//   upstream: staging/src/k8s.io/client-go/rest/request.go URL (the query of a create:
//             url.Values.Encode, keys sorted: dryRun, fieldManager, fieldValidation);
//             net/url Error.Error (`Post "<url>": <err>`)
//   upstream: staging/src/k8s.io/cli-runtime/pkg/printers/json.go JSONPrinter, yaml.go YAMLPrinter,
//             typesetter.go TypeSetterPrinter (kind and apiVersion set before printing)
//   fixtures/golden/v1.37.2/client/generators.yaml, generate/client.yaml, generate/create.yaml

import type { Op, ProcApi } from '@simlab/host';
import { isObject, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import { marshalJson } from '../../../apimachinery/yaml/jsonprint.ts';
import type { Invocation } from '../../cli/command.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import type { ClientConfig } from '../../client/kubeconfig.ts';
import { overridesOf, request, resolveConfig } from '../../client/session.ts';
import type { ServerState } from '../../resource/server.ts';
import { LAST_APPLIED } from '../../util/apply.ts';
import { dryRunStrategy, usageError, validationDirective, type DryRun, type FieldValidation } from '../helpers.ts';
import { parseYaml, YamlMarshalError } from '../printing.ts';
import { typed, typedPrinter, type TypedPrinter } from '../typed.ts';

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const strs = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/** cobra's ValidateRequiredFlags for one flag: the error, or undefined when it was set. */
export function requiredFlag(inv: Invocation, name: string): KubectlError | undefined {
  return inv.flags.changed.includes(name) ? undefined : messageError(`required flag(s) "${name}" not set`);
}

/** NameFromCommandArgs: the one name before `--`. */
export function nameFromArgs(inv: Invocation): string | KubectlError {
  const n = inv.flags.argsLenAtDash === -1 ? inv.args.length : inv.flags.argsLenAtDash;
  if (n !== 1) return usageError(inv.path, `exactly one NAME is required, got ${n}`);
  return inv.args[0] as string;
}

// The typed printer (`typed`, `typedPrinter`, `TypedPrinter`) is in ../typed.ts.

// ---- Complete ----

export interface Completed {
  config: ClientConfig;
  dryRun: DryRun;
  printer: TypedPrinter;
  directive: FieldValidation;
}

/**
 * The Complete steps of a `create <kind>` generator after the name: ToRESTConfig, the namespace,
 * GetDryRunStrategy, the printer, GetValidationDirective; each error in that order.
 */
export function* completeCreate(p: ProcApi, inv: Invocation): Op<Completed | KubectlError> {
  const v = inv.flags.values;
  const config = resolveConfig(p, overridesOf(v), parseYaml);
  if ('type' in config) return config;
  const dryRun = yield* dryRunStrategy(p, str(v['dry-run']));
  if (typeof dryRun !== 'string') return dryRun;
  const printer = typedPrinter(str(v.output), 'created', dryRun, str(v.template));
  if ('type' in printer) return printer;
  const directive = validationDirective(str(v.validate));
  if (typeof directive !== 'string') return directive;
  return { config, dryRun, printer, directive };
}

// ---- --save-config ----

function annotationsOf(obj: JsonObject): Record<string, Json> {
  const md = obj.metadata;
  return isObject(md) && isObject(md.annotations) ? { ...md.annotations } : {};
}

function setAnnotations(obj: JsonObject, annots: Record<string, Json>): void {
  if (!isObject(obj.metadata)) obj.metadata = {};
  (obj.metadata as JsonObject).annotations = annots;
}

/**
 * CreateOrUpdateAnnotation for a typed object: the annotation holds the object's
 * DefaultJSONEncoder encoding (struct order, compact, a trailing newline) without the annotation.
 */
export function typedApplyAnnotation(create: boolean, obj: JsonObject, typeId: string): void {
  const annots = annotationsOf(obj);
  const original = typeof annots[LAST_APPLIED] === 'string' ? (annots[LAST_APPLIED] as string) : '';
  if (!create && original === '') return;
  delete annots[LAST_APPLIED];
  setAnnotations(obj, annots);
  const modified = `${marshalJson(typed(obj, typeId), { sortKeys: false })}\n`;
  setAnnotations(obj, { ...annots, [LAST_APPLIED]: modified });
}

// ---- the create request ----

export interface Target {
  group: string;
  version: string;
  /** The plural resource, e.g. `deployments`. */
  resource: string;
  /** Empty for a cluster-scoped resource. */
  namespace: string;
}

export interface CreateOptions {
  fieldManager: string;
  directive: FieldValidation;
  dryRun: DryRun;
}

/** url.QueryEscape */
function queryEscape(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The POST URL client-go builds for a create. */
function createUrl(base: string, t: Target, o: CreateOptions): string {
  const prefix = t.group === '' ? `/api/${t.version}` : `/apis/${t.group}/${t.version}`;
  const path = `${prefix}${t.namespace !== '' ? `/namespaces/${t.namespace}` : ''}/${t.resource}`;
  const query: string[] = [];
  if (o.dryRun === 'server') query.push('dryRun=All');
  if (o.fieldManager !== '') query.push(`fieldManager=${queryEscape(o.fieldManager)}`);
  query.push(`fieldValidation=${o.directive}`);
  return `${base}${path}?${query.join('&')}`;
}

export type Created = { object: JsonObject } | { error: KubectlError };

/**
 * Sends the create (dry run on the server when asked). A refused connection is the *url.Error of
 * the POST; a failed request is the API server's Status; a resource the simulator does not store
 * prints a notice (the exit status is returned).
 */
export function* createRequest(p: ProcApi, server: ServerState, t: Target, body: JsonObject, o: CreateOptions): Op<Created | number> {
  if (!('session' in server)) {
    const url = createUrl(server.refused.base, t, o);
    return { error: { type: 'url', op: 'Post', url, err: `dial tcp ${server.refused.dialAddress}: connect: connection refused` } };
  }
  const r = yield* request(server.session, {
    verb: 'create',
    group: t.group,
    version: t.version,
    resource: t.resource,
    ...(t.namespace !== '' ? { namespace: t.namespace } : {}),
    body,
    options: { ...(o.fieldManager !== '' ? { fieldManager: o.fieldManager } : {}), fieldValidation: o.directive, ...(o.dryRun === 'server' ? { dryRun: true } : {}) },
  });
  if (r.ok) return { object: r.object as JsonObject };
  if ('notSimulated' in r) return yield* p.unsupported({ kind: 'resource', what: r.notSimulated });
  return { error: { type: 'status', status: r.status } };
}

/** `fmt.Errorf("<prefix>%v", err)`: the error's text behind a prefix, as a plain error. */
export function wrapped(prefix: string, err: KubectlError): KubectlError {
  if (err.type === 'status') return messageError(`${prefix}${err.status.message ?? ''}`);
  if (err.type === 'url') return messageError(`${prefix}${err.op} "${err.url}": ${err.err}`);
  if (err.type === 'message') return messageError(`${prefix}${err.message}`);
  return err;
}

/** Prints the object; a YAML marshalling failure is the command's error. */
export function* printObject(p: ProcApi, printer: TypedPrinter, obj: JsonObject, typeId: string): Op<KubectlError | undefined> {
  let text: string;
  try {
    text = printer.print(obj, typeId);
  } catch (e) {
    if (e instanceof YamlMarshalError) return messageError(e.message);
    throw e;
  }
  yield* p.write(1, text);
  return undefined;
}

