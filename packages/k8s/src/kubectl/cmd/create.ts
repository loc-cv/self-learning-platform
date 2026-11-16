// kubectl create -f: every object of the manifests POSTed in order, each printed as it is created
// (`configmap/x created`, -o yaml|json|name), failures reported after the rest with the file they
// came from (`Error from server (AlreadyExists): error when creating "x.yaml": …`).
// The generators (`create deployment` …) are separate commands (phase 08).
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/create/create.go NewCmdCreate (flags), Complete
//             (Unexpected args, the dry-run and validate flags, the printer, --edit), Validate
//             (RequireFilenameOrKustomize, the --raw checks), RunCreate (the builder with
//             ContinueOnError, CreateOrUpdateAnnotation, the create request with fieldManager,
//             fieldValidation and dryRun, info.Refresh, "no objects passed to create")
//   upstream: staging/src/k8s.io/cli-runtime/pkg/resource/helper.go Create (modify: the
//             resourceVersion cleared; create/resource-version.yaml)
//   fixtures/golden/v1.37.2/create/from-files.yaml, create/no-server.yaml, errors/validation.yaml,
//   configmaps/list-output.yaml, client/help.yaml (`kubectl create` alone)

import type { Op } from '@simlab/host';
import type { JsonObject } from '../../apimachinery/json.ts';
import type { Invocation, Verb } from '../cli/command.ts';
import { messageError, type KubectlError } from '../cli/errors.ts';
import type { FlagDef } from '../cli/flagset.ts';
import { fail, overridesOf, request, resolveConfig } from '../client/session.ts';
import { continueOnError, visitFiles } from '../resource/files.ts';
import { openServer, sessionOf } from '../resource/server.ts';
import { createOrUpdateAnnotation } from '../util/apply.ts';
import { addSourceToErr, CHANGE_FORMATS, clearResourceVersionForCreate, DRY_RUN_NO_OPT, dryRunStrategy, goStrings, toPrinter, usageError, validationDirective } from './helpers.ts';
import { parseYaml, YamlMarshalError } from './printing.ts';

const FLAGS: FlagDef[] = [
  { name: 'filename', shorthand: 'f', kind: 'stringSlice', default: [] },
  { name: 'recursive', shorthand: 'R', kind: 'bool', default: false },
  { name: 'kustomize', shorthand: 'k', kind: 'string', default: '' },
  { name: 'validate', kind: 'string', default: 'strict', noOptDefVal: 'strict' },
  { name: 'dry-run', kind: 'string', default: 'none', noOptDefVal: DRY_RUN_NO_OPT },
  { name: 'output', shorthand: 'o', kind: 'string', default: '' },
  { name: 'template', kind: 'string', default: '' },
  { name: 'save-config', kind: 'bool', default: false },
  { name: 'selector', shorthand: 'l', kind: 'string', default: '' },
  { name: 'field-manager', kind: 'string', default: 'kubectl-create' },
  { name: 'edit', kind: 'bool', default: false },
  { name: 'raw', kind: 'string', default: '' },
];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function* run(inv: Invocation): Op<number> {
  const { p, flags } = inv;
  const v = flags.values;
  // Complete
  if (inv.args.length !== 0) return yield* fail(p, usageError('create', `Unexpected args: ${goStrings(inv.args)}`));
  const dryRun = yield* dryRunStrategy(p, str(v['dry-run']));
  if (typeof dryRun !== 'string') return yield* fail(p, dryRun);
  const directive = validationDirective(str(v.validate));
  if (typeof directive !== 'string') return yield* fail(p, directive);
  const edit = v.edit === true;
  const filenames = (v.filename as string[] | undefined) ?? [];
  const kustomize = str(v.kustomize);
  const raw = str(v.raw);
  if (edit) return yield* p.unsupported({ kind: 'flag', what: 'the flag --edit (kubectl create --edit opens the manifest in an editor before creating it)' });
  const printer = toPrinter(str(v.output), 'created', dryRun, str(v.template));
  if ('type' in printer) return yield* fail(p, printer);
  // Validate
  if (filenames.length === 0 && kustomize === '') return yield* fail(p, messageError('must specify one of -f and -k'));
  if (raw !== '') {
    if (filenames.length !== 1) return yield* fail(p, messageError('--raw can only use a single local file or stdin'));
    const f = filenames[0] as string;
    if (f.startsWith('http://') || f.startsWith('https://')) return yield* fail(p, messageError('--raw cannot read from a url'));
    if (v.recursive === true) return yield* fail(p, messageError('--raw and --recursive are mutually exclusive'));
    if (str(v.selector) !== '') return yield* fail(p, messageError('--raw and --selector (-l) are mutually exclusive'));
    if (str(v.output) !== '') return yield* fail(p, messageError('--raw and --output are mutually exclusive'));
    return yield* p.unsupported({ kind: 'flag', what: 'the flag --raw (a raw POST to an API path)' });
  }
  // RunCreate
  const config = resolveConfig(p, overridesOf(v), parseYaml);
  if ('type' in config) return yield* fail(p, config);
  const server = yield* openServer(p, config);
  if (typeof server === 'number') return server;
  const items = yield* visitFiles(p, { filenames, recursive: v.recursive === true, ...(kustomize ? { kustomize } : {}) }, config.namespace, config.explicitNamespace, {
    ...(directive !== 'Ignore' ? { validation: directive } : {}),
    selector: str(v.selector),
    server,
  });
  if (!Array.isArray(items)) return yield* fail(p, items);
  const errors: KubectlError[] = [];
  const readErrors: KubectlError[] = [];
  let count = 0;
  for (const item of items) {
    if ('error' in item) {
      (item.stage === 'read' ? readErrors : errors).push(item.error);
      continue;
    }
    let obj: JsonObject = item.object;
    createOrUpdateAnnotation(v['save-config'] === true, obj);
    if (dryRun !== 'client') {
      const session = sessionOf(server);
      if (!session) return yield* p.unsupported({ kind: 'behavior', what: 'a create request with no server listening' });
      const m = item.mapping;
      clearResourceVersionForCreate(obj);
      const r = yield* request(session, {
        verb: 'create',
        group: m.group,
        version: m.version,
        resource: m.resource,
        ...(m.namespaced ? { namespace: item.namespace } : {}),
        body: obj,
        options: { fieldManager: str(v['field-manager']), fieldValidation: directive, ...(dryRun === 'server' ? { dryRun: true } : {}) },
      });
      if (!r.ok) {
        if ('notSimulated' in r) return yield* p.unsupported({ kind: 'resource', what: r.notSimulated });
        errors.push(addSourceToErr('creating', item.source, { type: 'status', status: r.status }));
        continue;
      }
      obj = r.object as JsonObject;
    }
    count++;
    let text: string;
    try {
      text = printer.print(obj);
    } catch (e) {
      if (!(e instanceof YamlMarshalError)) throw e;
      errors.push(messageError(e.message));
      continue;
    }
    yield* p.write(1, text);
  }
  const err = continueOnError(errors, readErrors);
  if (err) return yield* fail(p, err);
  if (count === 0) return yield* fail(p, messageError('no objects passed to create'));
  return 0;
}

export const createVerb: Verb = {
  path: 'create',
  flags: FLAGS,
  noEffect: {
    'windows-line-endings': 'only used with --edit, which prints a notice',
    'allow-missing-template-keys': 'only used by template output formats, which print a notice',
    'show-managed-fields': 'objects have no managedFields (DIV-015)',
  },
  partial: {
    filename: 'URLs (http://, https://) print a notice: the simulated machines have no network access',
    kustomize: 'prints a notice: kustomize is not simulated',
    output: 'kyaml and the template formats print a notice',
    template: 'prints a notice: template output is not simulated',
    edit: 'prints a notice: editing before create is not simulated',
    raw: 'prints a notice after its own checks: raw POSTs are not simulated',
  },
  outputFormats: { allowed: CHANGE_FORMATS, simulated: ['json', 'yaml', 'name'] },
  run,
};
