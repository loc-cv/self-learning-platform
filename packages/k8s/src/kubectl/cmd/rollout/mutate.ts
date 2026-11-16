// kubectl rollout pause, resume and restart: change the object locally, send the strategic merge
// patch between before and after, print the patched object.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/rollout/rollout_pause.go RunPause,
//             rollout_resume.go RunResume, rollout_restart.go RunRestart (r.Infos() errors first;
//             `error: <resource>[.<group>] "<name>" <err>` for a refused object; an empty patch:
//             "already paused" / "already resumed", or restart's "failed to create patch …";
//             "failed to patch: …"; "No resources found in <ns> namespace." on standard error;
//             --field-manager defaults to kubectl-rollout)
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/set/helper.go CalculatePatches, CalculatePatch
//             (CreateTwoWayMergePatch of the encoded object before and after)
//   upstream: staging/src/k8s.io/kubectl/pkg/polymorphichelpers/objectpauser.go,
//             objectresumer.go, objectrestarter.go (the errors; restartedAt is
//             time.Now().Format(time.RFC3339): the machine's local time, UTC in the simulator)

import { civilFromMillis } from '@simlab/kernel';
import type { Op } from '@simlab/host';
import { cloneJson, isObject, type JsonObject } from '../../../apimachinery/json.ts';
import { createTwoWayMergePatch } from '../../../apimachinery/strategicpatch/index.ts';
import { schema } from '../../../openapi/schema.ts';
import type { Invocation, Verb } from '../../cli/command.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import type { FlagDef } from '../../cli/flagset.ts';
import { fail, request, type Session } from '../../client/session.ts';
import { CHANGE_FORMATS } from '../helpers.ts';
import { aggregateOf, apiVersionOf, buildInfos, configOf, kustomizeNotice, requiredResource, resourceString, type Info } from './infos.ts';
import { typedPrinter } from '../typed.ts';
import { appsKindNotice } from './kinds.ts';

export const MUTATE_FLAGS: FlagDef[] = [
  { name: 'filename', shorthand: 'f', kind: 'stringSlice', default: [] },
  { name: 'recursive', shorthand: 'R', kind: 'bool', default: false },
  { name: 'kustomize', shorthand: 'k', kind: 'string', default: '' },
  { name: 'field-manager', kind: 'string', default: 'kubectl-rollout' },
  { name: 'selector', shorthand: 'l', kind: 'string', default: '' },
  { name: 'output', shorthand: 'o', kind: 'string', default: '' },
  { name: 'template', kind: 'string', default: '' },
];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const two = (n: number): string => String(n).padStart(2, '0');

type Mutation = { after: JsonObject } | { error: string } | { notice: string };

/** time.Now().Format(time.RFC3339) in UTC. */
function rfc3339(ms: number): string {
  const c = civilFromMillis(ms);
  return `${String(c.year).padStart(4, '0')}-${two(c.month)}-${two(c.day)}T${two(c.hour)}:${two(c.minute)}:${two(c.second)}Z`;
}

const isDeployment = (i: Info): boolean => i.mapping.kind === 'Deployment' && (i.mapping.group === 'apps' || i.mapping.group === 'extensions');
const specOf = (o: JsonObject): JsonObject => (isObject(o.spec) ? o.spec : (o.spec = {}));

/** defaultObjectPauser */
function pauser(i: Info): Mutation {
  if (!isDeployment(i)) return { error: 'pausing is not supported' };
  if (specOf(i.object).paused === true) return { error: 'is already paused' };
  const after = cloneJson(i.object);
  specOf(after).paused = true;
  return { after };
}

/** defaultObjectResumer: false is omitted when encoded (omitempty). */
function resumer(i: Info): Mutation {
  if (!isDeployment(i)) return { error: 'resuming is not supported' };
  if (specOf(i.object).paused !== true) return { error: 'is not paused' };
  const after = cloneJson(i.object);
  delete specOf(after).paused;
  return { after };
}

/** defaultObjectRestarter */
function restarter(now: number): (i: Info) => Mutation {
  return (i) => {
    const m = i.mapping;
    const appsKind = m.group === 'apps' || m.group === 'extensions';
    if ((m.kind === 'DaemonSet' && appsKind) || (m.kind === 'StatefulSet' && m.group === 'apps')) return { notice: m.kind };
    if (!isDeployment(i)) return { error: 'restarting is not supported' };
    if (specOf(i.object).paused === true) return { error: "can't restart paused deployment (run rollout resume first)" };
    const after = cloneJson(i.object);
    const spec = specOf(after);
    const template: JsonObject = isObject(spec.template) ? spec.template : (spec.template = {});
    const md: JsonObject = isObject(template.metadata) ? template.metadata : (template.metadata = {});
    const annotations: JsonObject = isObject(md.annotations) ? md.annotations : (md.annotations = {});
    annotations['kubectl.kubernetes.io/restartedAt'] = rfc3339(now);
    return { after };
  };
}

interface Command {
  path: string;
  /** The printed operation after a patch, and after an empty one (undefined: restart's error). */
  done: string;
  already?: string;
  mutate(inv: Invocation): (i: Info) => Mutation;
}

function runner(c: Command): (inv: Invocation) => Op<number> {
  return function* (inv) {
    const { p, flags } = inv;
    const v = flags.values;
    const config = yield* configOf(inv);
    if (typeof config === 'number') return config;
    const required = requiredResource(inv);
    if (required) return yield* fail(p, required);
    const k = yield* kustomizeNotice(inv);
    if (k !== undefined) return k;
    const built = yield* buildInfos(inv, config);
    if (typeof built === 'number') return built;
    // r.Infos(): the objects, and every error of their retrieval as one.
    const allErrs: KubectlError[] = [];
    const infos: Info[] = [];
    const infoErrors: KubectlError[] = [];
    for (const item of built.visited) {
      if ('error' in item) infoErrors.push(item.error);
      else infos.push(item.info);
    }
    const infosErr = aggregateOf(infoErrors);
    if (infosErr) allErrs.push(infosErr);
    if (infos.length === 0 && allErrs.length === 0) {
      yield* p.write(2, `No resources found in ${config.namespace} namespace.\n`);
      return 0;
    }
    const mutate = c.mutate(inv);
    const s = built.session as Session;
    const fieldManager = str(v['field-manager']);
    for (const info of infos) {
      const mutation = mutate(info);
      if ('notice' in mutation) return yield* appsKindNotice(p, c.path, mutation.notice);
      if ('error' in mutation) {
        allErrs.push(messageError(`error: ${resourceString(info.mapping)} ${JSON.stringify(info.name)} ${mutation.error}`));
        continue;
      }
      const t = schema().kind(apiVersionOf(info.mapping), info.mapping.kind);
      if (!t) throw new Error(`no schema for ${info.mapping.kind}`);
      const patch = createTwoWayMergePatch(info.object, mutation.after, t.id);
      if ('error' in patch) throw new Error(`two-way merge patch of ${info.name}: ${patch.error}`);
      const m = info.mapping;
      let shown: JsonObject = info.object;
      let operation = c.done;
      if (Object.keys(patch.ok).length === 0) {
        if (c.already === undefined) {
          allErrs.push(messageError(`failed to create patch for ${info.name}: if restart has already been triggered within the past second, please wait before attempting to trigger another`));
          continue;
        }
        operation = c.already;
      } else {
        const r = yield* request(s, {
          verb: 'patch',
          group: m.group,
          version: m.version,
          resource: m.resource,
          ...(info.namespace ? { namespace: info.namespace } : {}),
          name: info.name,
          body: patch.ok,
          options: { patchType: 'strategic', fieldManager },
        });
        if (!r.ok) {
          if ('notSimulated' in r) return yield* p.unsupported({ kind: 'behavior', what: r.notSimulated });
          allErrs.push(messageError(`failed to patch: ${r.status.message ?? ''}`));
          continue;
        }
        // info.Refresh(obj, true)
        shown = { apiVersion: apiVersionOf(m), kind: m.kind, ...(r.object as JsonObject) };
      }
      const printer = typedPrinter(str(v.output), operation, 'none', str(v.template));
      if ('type' in printer) {
        if (printer.type === 'notSimulated') return yield* p.unsupported({ kind: 'output-format', what: printer.what });
        allErrs.push(printer);
        continue;
      }
      yield* p.write(1, printer.print(shown));
    }
    const err = aggregateOf(allErrs);
    return err ? yield* fail(p, err) : 0;
  };
}

const common = {
  flags: MUTATE_FLAGS,
  noEffect: {
    'allow-missing-template-keys': 'only matters to template output formats, which print a notice',
    'show-managed-fields': 'objects have no managedFields (DIV-015)',
  },
  partial: { kustomize: 'every value', template: 'every value' },
  outputFormats: { allowed: CHANGE_FORMATS, simulated: ['json', 'yaml', 'name'] },
};

export const pauseVerb: Verb = { path: 'rollout pause', ...common, run: runner({ path: 'rollout pause', done: 'paused', already: 'already paused', mutate: () => pauser }) };
export const resumeVerb: Verb = { path: 'rollout resume', ...common, run: runner({ path: 'rollout resume', done: 'resumed', already: 'already resumed', mutate: () => resumer }) };
export const restartVerb: Verb = { path: 'rollout restart', ...common, run: runner({ path: 'rollout restart', done: 'restarted', mutate: (inv) => restarter(inv.p.ctx.now) }) };
