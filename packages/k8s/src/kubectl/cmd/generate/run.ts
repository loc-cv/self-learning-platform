// kubectl run: a Pod from an image (and with --expose a ClusterIP Service for it), created or,
// with --dry-run=client, only printed. Even a client dry run needs the server: the REST mapping
// of the generated object comes from discovery (createGeneratedObject calls f.ToRESTMapper()
// before it looks at the dry-run strategy), so with nothing listening it fails as `get` does.
// Attaching (-i, -t, --attach, --rm) is phase 17: a notice.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/run/run.go NewCmdRun, addRunFlags, Complete,
//             Validate, Run, createPod, createService, createGeneratedObject, parseLabels,
//             parseEnvs, getRestartPolicy, getImagePullPolicy
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go ParsePairs ("invalid %s format: %s"),
//             GetPodRunningTimeoutFlag; delete/delete_flags.go ToOptions (parseCascadingFlag)
//   upstream: vendor/github.com/distribution/reference/regexp.go ReferenceRegexp
//   fixtures/golden/v1.37.2/client/generators.yaml, generate/run.yaml, generate/client.yaml

import type { Op } from '@simlab/host';
import type { JsonObject } from '../../../apimachinery/json.ts';
import { isEnvVarName } from '../../../apimachinery/validation/names.ts';
import { matchesReference } from '../../../runtime/images/reference.ts';
import type { Invocation, Verb } from '../../cli/command.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import { goQuote, type FlagDef } from '../../cli/flagset.ts';
import { parseGoDuration } from '../../cli/goduration.ts';
import { fail, overridesOf, resolveConfig } from '../../client/session.ts';
import { discoveryError, openServer } from '../../resource/server.ts';
import { parseCascade } from '../delete.ts';
import { dryRunStrategy } from '../helpers.ts';
import { parseYaml } from '../printing.ts';
import { createRequest, printObject, requiredFlag, str, strs, typedApplyAnnotation } from './common.ts';
import { typedPrinter } from '../typed.ts';
import { OUTPUT_FORMATS, OUTPUT_NO_EFFECT, OUTPUT_PARTIAL, outputFlags } from './generator.ts';
import { applyOverrides, OVERRIDE_FLAGS, OVERRIDE_PARTIAL } from './overrides.ts';

const FLAGS: FlagDef[] = [
  ...outputFlags('kubectl-run'),
  { name: 'image', kind: 'string', default: '' },
  { name: 'port', kind: 'string', default: '' },
  { name: 'env', kind: 'stringArray', default: [] },
  { name: 'annotations', kind: 'stringArray', default: [] },
  { name: 'labels', shorthand: 'l', kind: 'string', default: '' },
  { name: 'restart', kind: 'string', default: 'Always' },
  { name: 'image-pull-policy', kind: 'string', default: '' },
  { name: 'command', kind: 'bool', default: false },
  { name: 'expose', kind: 'bool', default: false },
  { name: 'privileged', kind: 'bool', default: false },
  { name: 'stdin', shorthand: 'i', kind: 'bool', default: false },
  { name: 'tty', shorthand: 't', kind: 'bool', default: false },
  { name: 'attach', kind: 'bool', default: false },
  { name: 'rm', kind: 'bool', default: false },
  { name: 'pod-running-timeout', kind: 'duration', default: '1m0s' },
  { name: 'cascade', kind: 'string', default: 'background', noOptDefVal: 'background' },
  ...OVERRIDE_FLAGS,
];

const ATTACH_ONLY = 'only used when attaching (-i, -t, --attach), which prints a notice (phase 17)';
const REMOVE_ONLY = 'only used by --rm, which needs attaching and prints a notice (phase 17)';

/** ParsePairs(…, supportRemove=false) */
function parsePairs(pairs: readonly string[], kind: string): Record<string, string> | KubectlError {
  const out: Record<string, string> = {};
  const invalid: string[] = [];
  for (const pair of pairs) {
    if (pair.includes('=') && pair[0] !== '=') {
      const i = pair.indexOf('=');
      out[pair.slice(0, i)] = pair.slice(i + 1);
    } else invalid.push(pair);
  }
  if (invalid.length > 0) return messageError(`invalid ${kind} format: ${invalid.join(', ')}`);
  return out;
}

/** run.go parseLabels */
function parseLabels(spec: string): Record<string, string> | undefined | KubectlError {
  if (spec === '') return undefined;
  const out: Record<string, string> = {};
  for (const item of spec.split(',')) {
    const kv = item.split('=');
    if (kv.length !== 2) return messageError(`unexpected label spec: ${item}`);
    if (kv[0] === '') return messageError('unexpected empty label key');
    out[kv[0] as string] = kv[1] as string;
  }
  return out;
}

/** parseEnvs */
function parseEnvs(envs: readonly string[]): JsonObject[] | KubectlError {
  const out: JsonObject[] = [];
  for (const env of envs) {
    const i = env.indexOf('=');
    const name = i < 0 ? '' : env.slice(0, i);
    if (i < 0 || name === '' || isEnvVarName(name).length !== 0) return messageError(`invalid env: ${env}`);
    out.push({ name, value: env.slice(i + 1) });
  }
  return out;
}

const RESTART = ['Always', 'OnFailure', 'Never'];
const PULL = ['Always', 'IfNotPresent', 'Never'];

/** strconv.Atoi's acceptance: a decimal int64 with an optional sign. */
const isAtoi = (s: string): boolean => /^[+-]?[0-9]+$/.test(s) && BigInt(s) <= 9223372036854775807n && BigInt(s) >= -9223372036854775808n;

const isErr = (x: unknown): x is KubectlError => typeof x === 'object' && x !== null && 'type' in x && typeof (x as { type: unknown }).type === 'string' && !Array.isArray(x);

function* run(inv: Invocation): Op<number> {
  const { p } = inv;
  const v = inv.flags.values;
  const imageErr = requiredFlag(inv, 'image');
  if (imageErr) return yield* fail(p, imageErr);
  // Complete
  const annotations = parsePairs(strs(v.annotations), 'annotations');
  if (isErr(annotations)) return yield* fail(p, annotations);
  const labels = parseLabels(str(v.labels));
  if (isErr(labels)) return yield* fail(p, labels);
  const envs = parseEnvs(strs(v.env));
  if (isErr(envs)) return yield* fail(p, envs);
  const interactive = v.stdin === true;
  const restartFlag = str(v.restart);
  if (restartFlag !== '' && !RESTART.includes(restartFlag)) return yield* fail(p, messageError(`invalid restart policy: ${restartFlag}, valid values are: Always, OnFailure, Never`));
  const restartPolicy = restartFlag !== '' ? restartFlag : interactive ? 'OnFailure' : 'Always';
  const pullPolicy = str(v['image-pull-policy']);
  if (pullPolicy !== '' && !PULL.includes(pullPolicy)) return yield* fail(p, messageError(`invalid image pull policy: ${pullPolicy}, valid values are: Always, IfNotPresent, Never`));
  const timeout = parseGoDuration(str(v['pod-running-timeout']));
  if ('ns' in timeout && timeout.ns <= 0n) return yield* fail(p, messageError('--pod-running-timeout must be higher than zero'));
  const attach = inv.flags.changed.includes('attach') ? v.attach === true : interactive || v.attach === true;
  const dryRun = yield* dryRunStrategy(p, str(v['dry-run']));
  if (typeof dryRun !== 'string') return yield* fail(p, dryRun);
  const config = resolveConfig(p, overridesOf(v), parseYaml);
  if ('type' in config) return yield* fail(p, config);
  const printer = typedPrinter(str(v.output), 'created', dryRun, str(v.template));
  if ('type' in printer) return yield* fail(p, printer);
  const cascade = yield* parseCascade(p, str(v.cascade));
  if (typeof cascade !== 'string') return yield* fail(p, cascade);
  // Validate
  // Validate also refuses ArgsLenAtDash == 0, but Complete's RecordFlags.Complete re-parses
  // os.Args[1:] (record_flags.go parseCommandArguments: cmd.Flags().ParseAll), where the word
  // `run` itself stands before any `--`: `kubectl run --image=x -- name` passes (generate/client).
  if (inv.args.length === 0) return yield* fail(p, messageError('NAME is required for run'));
  const image = str(v.image);
  if (image === '') return yield* fail(p, messageError('--image is required'));
  if (!matchesReference(image)) return yield* fail(p, messageError(`invalid image name ${goQuote(image)}: invalid reference format`));
  const tty = v.tty === true;
  if (tty && !interactive) return yield* fail(p, messageError('-i/--stdin is required for containers with -t/--tty=true'));
  const port = str(v.port);
  if (v.expose === true && port === '') return yield* fail(p, messageError('--port must be set when exposing a service'));
  if (port !== '' && !isAtoi(port)) return yield* fail(p, messageError('--port must be a number'));
  if (!attach && v.rm === true) return yield* fail(p, messageError('--rm should only be used for attached containers'));
  if (attach && dryRun !== 'none') return yield* fail(p, messageError("--dry-run=[server|client] can't be used with attached containers options (--attach, --stdin, or --tty)"));
  if (attach) return yield* p.unsupported({ kind: 'flag', what: 'attaching to the Pod (kubectl run -i, -t, --attach, --rm; phase 17)' });
  // Run
  const name = inv.args[0] as string;
  const args = inv.args.slice(1);
  const podLabels = labels ?? { run: name };
  const container: JsonObject = {
    name,
    image,
    env: envs,
    ...(interactive ? { stdin: true, stdinOnce: true } : {}),
    ...(tty ? { tty: true } : {}),
    ...(pullPolicy !== '' ? { imagePullPolicy: pullPolicy } : {}),
    ...(v.privileged === true ? { securityContext: { privileged: true } } : {}),
  };
  if (args.length > 0) container[v.command === true ? 'command' : 'args'] = args;
  if (port !== '') container.ports = [{ containerPort: Number(port) }];
  const pod: JsonObject = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, labels: podLabels, annotations },
    spec: { containers: [container], dnsPolicy: 'ClusterFirst', restartPolicy },
  };
  const server = yield* openServer(p, config);
  if (typeof server === 'number') return server;
  const objects: { obj: JsonObject; typeId: string }[] = [];
  const errors: KubectlError[] = [];
  // createGeneratedObject: the mapping first (discovery), then the overrides, then the create.
  const unreachable = yield* discoveryError(p, server);
  if (unreachable !== undefined) {
    const url = `${'refused' in server ? server.refused.base : ''}/api?timeout=32s`;
    return yield* fail(p, { type: 'url', op: 'Get', url, err: unreachable.slice(unreachable.indexOf(': ') + 2) });
  }
  const generated = function* (obj: JsonObject, typeId: string, overrides: boolean): Op<JsonObject | KubectlError | number> {
    let o = obj;
    if (overrides) {
      const r = applyOverrides(o, typeId, str(v.overrides), str(v['override-type']));
      if ('error' in r) return r.error;
      o = r.object;
    }
    if (dryRun === 'client') {
      if (config.explicitNamespace) (o.metadata as JsonObject).namespace = config.namespace;
      return o;
    }
    typedApplyAnnotation(v['save-config'] === true, o, typeId);
    const r = yield* createRequest(p, server, { group: '', version: 'v1', resource: typeId === 'core/v1.Pod' ? 'pods' : 'services', namespace: config.namespace }, o, {
      fieldManager: str(v['field-manager']),
      directive: 'Strict',
      dryRun,
    });
    if (typeof r === 'number') return r;
    return 'error' in r ? r.error : r.object;
  };
  const created = yield* generated(pod, 'core/v1.Pod', true);
  if (typeof created === 'number') return created;
  if (isErr(created)) return yield* fail(p, created);
  objects.push({ obj: created, typeId: 'core/v1.Pod' });
  if (v.expose === true) {
    const portNo = Number(port);
    const service: JsonObject = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, ...(labels ? { labels } : {}) },
      spec: { selector: podLabels, ports: [{ port: portNo, protocol: 'TCP', targetPort: portNo }] },
    };
    const svc = yield* generated(service, 'core/v1.Service', false);
    if (typeof svc === 'number') return svc;
    if (isErr(svc)) errors.push(svc);
    else objects.push({ obj: svc, typeId: 'core/v1.Service' });
  }
  for (const { obj, typeId } of objects) {
    const err = yield* printObject(p, printer, obj, typeId);
    if (err) errors.push(err);
  }
  if (errors.length > 0) return yield* fail(p, { type: 'aggregate', errors });
  return 0;
}

export const runVerb: Verb = {
  path: 'run',
  flags: FLAGS,
  noEffect: {
    ...OUTPUT_NO_EFFECT,
    'leave-stdin-open': ATTACH_ONLY,
    'detach-keys': ATTACH_ONLY,
    quiet: ATTACH_ONLY,
    force: REMOVE_ONLY,
    'grace-period': REMOVE_ONLY,
    kustomize: REMOVE_ONLY,
    recursive: REMOVE_ONLY,
    timeout: REMOVE_ONLY,
    wait: REMOVE_ONLY,
  },
  partial: {
    ...OUTPUT_PARTIAL,
    ...OVERRIDE_PARTIAL,
    stdin: 'attaching prints a notice (phase 17)',
    tty: 'attaching prints a notice (phase 17)',
    attach: 'attaching prints a notice (phase 17)',
    rm: 'needs attaching, which prints a notice (phase 17)',
  },
  outputFormats: OUTPUT_FORMATS,
  run,
};
