// cmdutil helpers the mutating commands share: the --dry-run strategy, the --validate directive,
// the source a failed object came from, and the output flags of commands that print what they
// changed (PrintFlags with a NamePrinter operation).
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go GetDryRunStrategy (its klog
//             warnings at helpers.go:714, 728 and 731), GetValidationDirective, AddSourceToErr,
//             PrintFlagsWithDryRunStrategy, UsageErrorf
//   upstream: staging/src/k8s.io/cli-runtime/pkg/genericclioptions/print_flags.go ToPrinter,
//             AllowedFormats, NoCompatiblePrinterError; name_flags.go, json_yaml_flags.go;
//             staging/src/k8s.io/cli-runtime/pkg/printers/name.go NamePrinter (printObj),
//             yaml.go YAMLPrinter (`---` before every object after the first), json.go JSONPrinter
//   upstream: .upstream/go src/strconv/atob.go ParseBool
//   upstream: staging/src/k8s.io/cli-runtime/pkg/resource/helper.go CreateWithOptions (modify)

import type { Op, ProcApi } from '@simlab/host';
import { isObject, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { messageError, type KubectlError } from '../cli/errors.ts';
import { goQuote } from '../cli/flagset.ts';
import { klogLine } from '../client/session.ts';
import { toJson, toYaml } from './printing.ts';

/** strconv.ParseBool */
export function parseBool(s: string): boolean | undefined {
  if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(s)) return true;
  if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(s)) return false;
  return undefined;
}

export type DryRun = 'none' | 'client' | 'server';

/** The --dry-run flag's NoOptDefVal (AddDryRunFlag). */
export const DRY_RUN_NO_OPT = 'unchanged';

/** GetDryRunStrategy; the deprecation warnings are klog lines on standard error. */
export function* dryRunStrategy(p: ProcApi, value: string): Op<DryRun | KubectlError> {
  const b = parseBool(value);
  if (b === undefined) {
    if (value === DRY_RUN_NO_OPT) {
      yield* p.write(2, klogLine(p, 'W', 'helpers.go:714', '--dry-run is deprecated and can be replaced with --dry-run=client.'));
      return 'client';
    }
    if (value === 'client' || value === 'server' || value === 'none') return value;
    return messageError(`Invalid dry-run value (${value}). Must be "none", "server", or "client".`);
  }
  if (b) {
    yield* p.write(2, klogLine(p, 'W', 'helpers.go:728', `--dry-run=${value} is deprecated (boolean value) and can be replaced with --dry-run=client.`));
    return 'client';
  }
  yield* p.write(2, klogLine(p, 'W', 'helpers.go:731', `--dry-run=${value} is deprecated (boolean value) and can be replaced with --dry-run=none.`));
  return 'none';
}

export type FieldValidation = 'Strict' | 'Warn' | 'Ignore';

/** GetValidationDirective */
export function validationDirective(value: string): FieldValidation | KubectlError {
  const b = parseBool(value);
  if (b === undefined) {
    if (value === 'strict') return 'Strict';
    if (value === 'warn') return 'Warn';
    if (value === 'ignore') return 'Ignore';
    return messageError(`invalid - validate option "${value}"; must be one of: strict (or true), warn, ignore (or false)`);
  }
  return b ? 'Strict' : 'Ignore';
}

/**
 * resource.Helper.Create with modify=true (create -f, apply's create path, replace --force): the
 * object goes to the server without its resourceVersion, which storage would refuse on a create
 * (fixtures/golden/v1.37.2/create/resource-version.yaml). Unstructured.GetResourceVersion reads a
 * string only, so a resourceVersion of another type is sent as it is.
 * upstream: staging/src/k8s.io/cli-runtime/pkg/resource/helper.go CreateWithOptions;
 *           apimachinery/pkg/apis/meta/v1/unstructured/unstructured.go SetResourceVersion
 */
export function clearResourceVersionForCreate(obj: JsonObject): void {
  const m = obj.metadata;
  if (isObject(m) && typeof m.resourceVersion === 'string' && m.resourceVersion !== '') delete m.resourceVersion;
}

/** AddSourceToErr: `error when <verb> "<source>": ` before the message. */
export function addSourceToErr(verb: string, source: string, err: KubectlError): KubectlError {
  if (source === '') return err;
  const prefix = `error when ${verb} ${goQuote(source)}: `;
  if (err.type === 'status') return { type: 'status', status: { ...err.status, message: `${prefix}${err.status.message ?? ''}` } };
  if (err.type === 'message') return messageError(`${prefix}${err.message}`);
  return err;
}

/** UsageErrorf */
export function usageError(path: string, message: string): KubectlError {
  return messageError(`${message}\nSee 'kubectl ${path} -h' for help and examples`);
}

/** Go's %v of a []string */
export function goStrings(a: readonly string[]): string {
  return `[${a.join(' ')}]`;
}

// ---- printing what was changed ----

/** PrintFlags.AllowedFormats of create and apply (JSON/YAML, name, templates), sorted. */
export const CHANGE_FORMATS = ['go-template', 'go-template-file', 'json', 'jsonpath', 'jsonpath-as-json', 'jsonpath-file', 'kyaml', 'name', 'template', 'templatefile', 'yaml'];
const TEMPLATE_FORMATS = new Set(['go-template', 'go-template-file', 'template', 'templatefile', 'jsonpath', 'jsonpath-as-json', 'jsonpath-file']);

export interface Printer {
  print(obj: JsonObject): string;
}

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');

/** NamePrinter's `<kind>[.<group>]/<name>`, then the operation. */
export function namePrinted(obj: JsonObject, operation: string): string {
  const apiVersion = str(obj.apiVersion);
  const group = apiVersion.includes('/') ? apiVersion.slice(0, apiVersion.indexOf('/')) : '';
  const kind = str(obj.kind).toLowerCase();
  const name = (isObject(obj.metadata) ? str(obj.metadata.name) : '') || '<unknown>';
  return `${group ? `${kind}.${group}` : kind}/${name}${operation ? ` ${operation}` : ''}\n`;
}

/**
 * PrintFlags.ToPrinter after PrintFlagsWithDryRunStrategy: a printer, the error for a format the
 * command does not have, or a notice for one the simulator does not print.
 */
export function toPrinter(output: string, operation: string, dryRun: DryRun, template = ''): Printer | KubectlError {
  let format = output;
  if (format === '' && template !== '') format = 'go-template';
  const lower = format.toLowerCase();
  const op = dryRun === 'client' ? `${operation} (dry run)` : dryRun === 'server' ? `${operation} (server dry run)` : operation;
  if (lower === 'json') return { print: (o) => toJson(o) };
  if (lower === 'yaml') {
    let count = 0;
    return { print: (o) => `${count++ > 0 ? '---\n' : ''}${toYaml(o)}` };
  }
  if (lower === 'kyaml') return { type: 'notSimulated', what: 'the output format "kyaml"' };
  if (lower === 'name') return { print: (o) => namePrinted(o, '') };
  if (lower === '') return { print: (o) => namePrinted(o, op) };
  const name = format.includes('=') ? format.slice(0, format.indexOf('=')) : format;
  if (TEMPLATE_FORMATS.has(name)) return { type: 'notSimulated', what: `the output format "${name}"` };
  return messageError(`unable to match a printer suitable for the output format "${output}", allowed formats are: ${CHANGE_FORMATS.join(',')}`);
}
