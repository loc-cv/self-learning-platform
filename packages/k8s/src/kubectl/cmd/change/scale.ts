// kubectl scale: set spec.replicas through the scale subresource of each object, with the
// --current-replicas and --resource-version preconditions, and wait (with --timeout, in virtual
// time) until the replicas are there.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/scale/scale.go NewCmdScale (flags; replicas is a
//             required flag), Complete, Validate, RunScale (the builder without Latest, "cannot use
//             --resource-version with multiple resources", "no objects passed to scale", the client
//             dry run printing the object with spec.replicas set, the first scale error returned at
//             once, the visit errors after the loop), updateReplicas (core and apps objects only)
//   upstream: staging/src/k8s.io/kubectl/pkg/scale/scale.go ScaleSimple (with a precondition: get the
//             Scale, validate, update it; without: a JSON merge patch {"spec":{"replicas":N}}),
//             ScalePrecondition.validate and PreconditionError ("Expected %s to be %s, was %s"),
//             Scale (retries on a conflict, once a millisecond for a millisecond), WaitForScaleHasDesiredReplicas
//             and scaleHasDesiredReplicas (every second, immediately first; `timed out waiting for %q
//             to be synced`)
//   upstream: staging/src/k8s.io/apimachinery/pkg/util/wait/loop.go loopConditionUntilContext
//   upstream: vendor/github.com/spf13/cobra/command.go validateRequiredFlags
//             (`required flag(s) "%s" not set`)
//   fixtures/golden/v1.37.2/change/scale.yaml

import type { Op, ProcApi } from '@simlab/host';
import { isObject, type JsonObject } from '../../../apimachinery/json.ts';
import type { Status } from '../../../apimachinery/errors.ts';
import { registry } from '../../../discovery/registry.ts';
import type { Invocation, Verb } from '../../cli/command.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import type { FlagDef } from '../../cli/flagset.ts';
import { parseGoDuration } from '../../cli/goduration.ts';
import { fail, overridesOf, request, resolveConfig, type Session } from '../../client/session.ts';
import { continueOnError } from '../../resource/files.ts';
import { CHANGE_FORMATS, DRY_RUN_NO_OPT, dryRunStrategy, toPrinter, type DryRun, type Printer } from '../helpers.ts';
import { parseYaml, YamlMarshalError } from '../printing.ts';
import { find, infoBase, type Info } from './finder.ts';

const FLAGS: FlagDef[] = [
  { name: 'all', kind: 'bool', default: false },
  { name: 'current-replicas', kind: 'int', default: -1 },
  { name: 'dry-run', kind: 'string', default: 'none', noOptDefVal: DRY_RUN_NO_OPT },
  { name: 'filename', shorthand: 'f', kind: 'stringSlice', default: [] },
  { name: 'kustomize', shorthand: 'k', kind: 'string', default: '' },
  { name: 'output', shorthand: 'o', kind: 'string', default: '' },
  { name: 'recursive', shorthand: 'R', kind: 'bool', default: false },
  { name: 'replicas', kind: 'int', default: 0 },
  { name: 'resource-version', kind: 'string', default: '' },
  { name: 'selector', shorthand: 'l', kind: 'string', default: '' },
  { name: 'template', kind: 'string', default: '' },
  { name: 'timeout', kind: 'duration', default: '0s' },
];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface Precondition {
  size: number;
  resourceVersion: string;
}

/** ScalePrecondition.validate */
function checkPrecondition(pre: Precondition, scale: JsonObject): KubectlError | undefined {
  const replicas = isObject(scale.spec) && typeof scale.spec.replicas === 'number' ? scale.spec.replicas : 0;
  const rv = isObject(scale.metadata) ? str(scale.metadata.resourceVersion) : '';
  if (pre.size !== -1 && replicas !== pre.size) return messageError(`Expected replicas to be ${pre.size}, was ${replicas}`);
  if (pre.resourceVersion !== '' && rv !== pre.resourceVersion) return messageError(`Expected resource version to be ${pre.resourceVersion}, was ${rv}`);
  return undefined;
}

const scaleOf = (o: JsonObject) => ({
  spec: isObject(o.spec) && typeof o.spec.replicas === 'number' ? o.spec.replicas : 0,
  status: isObject(o.status) && typeof o.status.replicas === 'number' ? o.status.replicas : 0,
});

type Scaled = { actual: number } | { error: KubectlError };

/** genericScaler.ScaleSimple: the replicas the server answered with. */
function* scaleSimple(s: Session, info: Info, pre: Precondition | undefined, replicas: number, serverDryRun: boolean): Op<Scaled> {
  const target = { ...infoBase(info), name: info.name, subresource: 'scale' };
  const dry = serverDryRun ? { dryRun: true } : {};
  if (pre) {
    const got = yield* request(s, { verb: 'get', ...target });
    if (!got.ok) return { error: 'notSimulated' in got ? { type: 'notSimulated', what: got.notSimulated } : { type: 'status', status: got.status } };
    const scale = got.object as JsonObject;
    const err = checkPrecondition(pre, scale);
    if (err) return { error: err };
    const body: JsonObject = { ...scale, spec: { ...(isObject(scale.spec) ? scale.spec : {}), replicas } };
    const r = yield* request(s, { verb: 'update', ...target, body, options: { ...dry } });
    return handleResult(r);
  }
  const r = yield* request(s, { verb: 'patch', ...target, body: { spec: { replicas } }, options: { patchType: 'merge', ...dry } });
  return handleResult(r);
}

function handleResult(r: { ok: true; object: unknown } | { ok: false; status?: unknown; notSimulated?: string }): Scaled {
  if (!r.ok) {
    if (r.notSimulated !== undefined) return { error: { type: 'notSimulated', what: r.notSimulated } };
    return { error: { type: 'status', status: r.status as never } };
  }
  return { actual: scaleOf(r.object as JsonObject).spec };
}

/** Milliseconds of virtual time for a duration, rounded up. */
const nsToMs = (ns: bigint): number => Number((ns + 999_999n) / 1_000_000n);

/** WaitForScaleHasDesiredReplicas: undefined when synced, or the error. */
function* waitForReplicas(s: Session, info: Info, desired: number, timeoutNs: bigint): Op<KubectlError | undefined> {
  // PollUntilContextTimeout(…, immediate = true, …): checked at once, then every second.
  const p = s.p;
  const deadline = p.ctx.now + nsToMs(timeoutNs);
  const target = { ...infoBase(info), name: info.name, subresource: 'scale' };
  for (;;) {
    const got = yield* request(s, { verb: 'get', ...target });
    if (!got.ok) return 'notSimulated' in got ? { type: 'notSimulated', what: got.notSimulated } : { type: 'status', status: got.status };
    const sc = scaleOf(got.object as JsonObject);
    if (sc.spec !== desired) return undefined;
    if (sc.spec === sc.status && desired === sc.status) return undefined;
    const next = p.ctx.now + 1000;
    if (next >= deadline) {
      if (deadline > p.ctx.now) yield* p.sleep(deadline - p.ctx.now);
      return messageError(`timed out waiting for ${JSON.stringify(info.name)} to be synced`);
    }
    yield* p.sleep(1000);
  }
}

/** updateReplicas: only core and apps objects get spec.replicas in what is printed. */
function updateReplicas(info: Info, replicas: number): void {
  const apiVersion = str(info.object.apiVersion);
  const group = apiVersion.includes('/') ? apiVersion.slice(0, apiVersion.indexOf('/')) : '';
  if (group !== 'apps' && group !== '') return;
  if (!isObject(info.object.spec)) info.object.spec = {};
  (info.object.spec as JsonObject).replicas = replicas;
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

function* run(inv: Invocation): Op<number> {
  const { p, flags } = inv;
  const v = flags.values;
  // cobra validateRequiredFlags, before Run.
  if (!flags.changed.includes('replicas')) return yield* fail(p, messageError('required flag(s) "replicas" not set'));
  // Complete
  const dryRun: DryRun | KubectlError = yield* dryRunStrategy(p, str(v['dry-run']));
  if (typeof dryRun !== 'string') return yield* fail(p, dryRun);
  const printer = toPrinter(str(v.output), 'scaled', dryRun, str(v.template));
  if ('type' in printer) return yield* fail(p, printer);
  const config = resolveConfig(p, overridesOf(v), parseYaml);
  if ('type' in config) return yield* fail(p, config);
  // Validate
  const replicas = v.replicas as number;
  const currentReplicas = v['current-replicas'] as number;
  if (replicas < 0) return yield* fail(p, messageError('The --replicas=COUNT flag is required, and COUNT must be greater than or equal to 0'));
  if (currentReplicas < -1) return yield* fail(p, messageError('The --current-replicas must specify an integer of -1 or greater'));
  const timeout = parseGoDuration(str(v.timeout));
  const timeoutNs = 'ns' in timeout ? timeout.ns : 0n;
  // RunScale
  const found = yield* find(p, {
    config,
    args: inv.args,
    filenames: (v.filename as string[] | undefined) ?? [],
    recursive: v.recursive === true,
    kustomize: str(v.kustomize),
    local: false,
    all: v.all === true,
    selector: str(v.selector),
    fieldSelector: '',
    allNamespaces: false,
    latest: false,
  });
  if (typeof found === 'number') return found;
  if ('error' in found) return yield* fail(p, found.error);
  const infos: Info[] = [];
  const visitErrors: KubectlError[] = [];
  for (const e of found.entries) {
    if ('error' in e) visitErrors.push(e.error);
    else infos.push(e.info);
  }
  const notSimulated = visitErrors.find((e) => e.type === 'notSimulated');
  if (notSimulated) return yield* fail(p, notSimulated);
  const infoErr = continueOnError(visitErrors, found.readErrors);
  const resourceVersion = str(v['resource-version']);
  if (resourceVersion !== '' && infos.length > 1) return yield* fail(p, messageError('cannot use --resource-version with multiple resources'));
  const pre: Precondition | undefined = currentReplicas !== -1 || resourceVersion !== '' ? { size: currentReplicas, resourceVersion } : undefined;
  if (infos.length === 0) return yield* fail(p, infoErr ?? messageError('no objects passed to scale'));
  if (timeoutNs < 0n && dryRun === 'none') return yield* p.unsupported({ kind: 'flag-value', what: 'the flag --timeout with a negative duration' });
  for (const info of infos) {
    if (dryRun === 'client') {
      updateReplicas(info, replicas);
      const err = yield* print(p, printer, info.object);
      if (err) return yield* fail(p, err);
      continue;
    }
    const s = found.session as Session;
    // The scale client finds the subresource in discovery.
    // A resource without one (Pods) answers the request with a plain 404, which client-go makes
    // a generic NotFound (rest/request.go newUnstructuredResponseError, apierrors
    // NewGenericServerResponse; fixtures/golden/v1.37.2/change/scale.yaml).
    if (!registry().get(info.mapping.group, info.mapping.version, info.mapping.resource, 'scale')) {
      return yield* fail(p, { type: 'status', status: { kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', code: 404, reason: 'NotFound', message: 'the server could not find the requested resource' } satisfies Status });
    }
    const r = yield* scaleSimple(s, info, pre, replicas, dryRun === 'server');
    if ('error' in r) return yield* fail(p, r.error);
    if (timeoutNs !== 0n && dryRun === 'none') {
      const err = yield* waitForReplicas(s, info, replicas, timeoutNs);
      if (err) return yield* fail(p, err);
    }
    updateReplicas(info, r.actual);
    const err = yield* print(p, printer, info.object);
    if (err) return yield* fail(p, err);
  }
  if (infoErr) return yield* fail(p, infoErr);
  return 0;
}

export const scaleVerb: Verb = {
  path: 'scale',
  flags: FLAGS,
  noEffect: {
    'allow-missing-template-keys': 'only used by template output formats, which print a notice',
    'show-managed-fields': 'objects have no managedFields (DIV-015)',
  },
  partial: {
    filename: 'URLs (http://, https://) print a notice: the simulated machines have no network access',
    kustomize: 'prints a notice: kustomize is not simulated',
    output: 'kyaml and the template formats print a notice',
    template: 'prints a notice: template output is not simulated',
  },
  outputFormats: { allowed: CHANGE_FORMATS, simulated: ['json', 'yaml', 'name'] },
  run,
};
