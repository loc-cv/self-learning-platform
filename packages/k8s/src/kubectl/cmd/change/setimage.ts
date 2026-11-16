// kubectl set image: change the images of named containers (or all, with `*`) in the Pod spec of
// Pods and of the workloads with a Pod template, sent as a strategic merge patch computed from the
// typed object before and after.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/set/set_image.go NewCmdImage (flags, the
//             "image updated" operation), Complete (the dry-run strategy, the printer, the builder
//             WithScheme with Latest unless --local, and Infos(): a visit error ends the command
//             before anything is patched), Validate (one aggregate: --all with --selector, no
//             resources, no image, `*` with other pairs, --local with --dry-run=server), Run
//             (setImage over init containers, then containers; `unable to find container named %q`
//             once per name and object; the patch skipped when it is {}; the local or client dry
//             run printing the changed object; the patch error "failed to patch image update to pod
//             template: %v"; all errors as one aggregate at the end, after the lines printed)
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/set/helper.go CalculatePatches (the typed object
//             encoded before and after, strategicpatch.CreateTwoWayMergePatch; an error as
//             "error: %s %v\n" with info.ObjectName())
//   upstream: staging/src/k8s.io/kubectl/pkg/polymorphichelpers/updatepodspec.go
//             updatePodSpecForObject ("the object is not a pod or does not have a pod template: %T")
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go GetResourcesAndPairs ("all
//             resources must be specified before %s changes: %s"), ParsePairs ("invalid %s format: %s")
//   fixtures/golden/v1.37.2/change/set-image.yaml

import type { Op } from '@simlab/host';
import { isObject, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import { marshalJson } from '../../../apimachinery/yaml/jsonprint.ts';
import { createTwoWayMergePatch } from '../../../apimachinery/strategicpatch/index.ts';
import type { Invocation, Verb } from '../../cli/command.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import type { FlagDef } from '../../cli/flagset.ts';
import { fail, overridesOf, request, resolveConfig, type Session } from '../../client/session.ts';
import { continueOnError } from '../../resource/files.ts';
import { CHANGE_FORMATS, DRY_RUN_NO_OPT, dryRunStrategy, type DryRun } from '../helpers.ts';
import { parseYaml, YamlMarshalError } from '../printing.ts';
import { find, infoBase, type Info } from './finder.ts';
import { resourcesAndPairs } from './pairs.ts';
import { typed, typedPrinter, typeIdOf } from '../typed.ts';

const FLAGS: FlagDef[] = [
  { name: 'all', kind: 'bool', default: false },
  { name: 'dry-run', kind: 'string', default: 'none', noOptDefVal: DRY_RUN_NO_OPT },
  { name: 'field-manager', kind: 'string', default: 'kubectl-set' },
  { name: 'filename', shorthand: 'f', kind: 'stringSlice', default: [] },
  { name: 'kustomize', shorthand: 'k', kind: 'string', default: '' },
  { name: 'local', kind: 'bool', default: false },
  { name: 'output', shorthand: 'o', kind: 'string', default: '' },
  { name: 'recursive', shorthand: 'R', kind: 'bool', default: false },
  { name: 'selector', shorthand: 'l', kind: 'string', default: '' },
  { name: 'template', kind: 'string', default: '' },
];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** ParsePairs(…, "image", false): the pairs in order (a later name replaces an earlier one), or the error. */
function parseImages(args: readonly string[]): [string, string][] | KubectlError {
  const pairs = new Map<string, string>();
  const invalid: string[] = [];
  for (const a of args) {
    if (a.includes('=') && a[0] !== '=') {
      const i = a.indexOf('=');
      pairs.set(a.slice(0, i), a.slice(i + 1));
    } else invalid.push(a);
  }
  if (invalid.length > 0) return messageError(`invalid image format: ${invalid.join(', ')}`);
  return [...pairs.entries()];
}

/** The Pod spec of an object (updatePodSpecForObject), or undefined for a kind without one. */
function podSpecOf(obj: JsonObject): JsonObject | undefined {
  const kind = str(obj.kind);
  const apiVersion = str(obj.apiVersion);
  const group = apiVersion.includes('/') ? apiVersion.slice(0, apiVersion.indexOf('/')) : '';
  const obj2 = (o: JsonObject, k: string): JsonObject => {
    if (!isObject(o[k])) o[k] = {};
    return o[k] as JsonObject;
  };
  if (group === '' && kind === 'Pod') return obj2(obj, 'spec');
  const templated: Record<string, string[]> = {
    '': ['ReplicationController'],
    apps: ['Deployment', 'DaemonSet', 'ReplicaSet', 'StatefulSet'],
    extensions: ['Deployment', 'DaemonSet', 'ReplicaSet'],
    batch: ['Job'],
  };
  if (templated[group]?.includes(kind)) return obj2(obj2(obj2(obj, 'spec'), 'template'), 'spec');
  if (group === 'batch' && kind === 'CronJob') return obj2(obj2(obj2(obj2(obj2(obj, 'spec'), 'jobTemplate'), 'spec'), 'template'), 'spec');
  return undefined;
}

/** setImage over one container list: whether the name matched. */
function setImage(containers: Json | undefined, name: string, image: string): boolean {
  if (!Array.isArray(containers)) return false;
  let found = false;
  for (const c of containers) {
    if (!isObject(c)) continue;
    if (c.name === name || name === '*') {
      c.image = image;
      found = true;
    }
  }
  return found;
}

interface Patch {
  info: Info;
  patch?: JsonObject;
  error?: KubectlError;
}

function* run(inv: Invocation): Op<number> {
  const { p, flags } = inv;
  const v = flags.values;
  const local = v.local === true;
  // Complete
  const dryRun: DryRun | KubectlError = yield* dryRunStrategy(p, str(v['dry-run']));
  if (typeof dryRun !== 'string') return yield* fail(p, dryRun);
  const printer = typedPrinter(str(v.output), 'image updated', dryRun, str(v.template));
  if ('type' in printer) return yield* fail(p, printer);
  const config = resolveConfig(p, overridesOf(v), parseYaml);
  if ('type' in config) return yield* fail(p, config);
  const split = resourcesAndPairs(inv.args, 'image');
  if ('type' in split) return yield* fail(p, split);
  const images = parseImages(split.pairs);
  if (!Array.isArray(images)) return yield* fail(p, images);
  const filenames = (v.filename as string[] | undefined) ?? [];
  const kustomize = str(v.kustomize);
  const selector = str(v.selector);
  const found = yield* find(p, {
    config,
    args: split.resources,
    filenames,
    recursive: v.recursive === true,
    kustomize,
    local,
    all: v.all === true,
    selector: local ? '' : selector,
    fieldSelector: '',
    allNamespaces: false,
    latest: !local,
  });
  if (typeof found === 'number') return found;
  if ('error' in found) return yield* fail(p, found.error);
  // Infos(): any visit error ends the command here.
  const visitErrors = found.entries.flatMap((e) => ('error' in e ? [e.error] : []));
  const notSimulated = visitErrors.find((e) => e.type === 'notSimulated');
  if (notSimulated) return yield* fail(p, notSimulated);
  const infoErr = continueOnError(visitErrors, found.readErrors);
  if (infoErr) return yield* fail(p, infoErr);
  const infos = found.entries.flatMap((e) => ('info' in e ? [e.info] : []));
  // Validate
  const errs: KubectlError[] = [];
  if (v.all === true && selector !== '') errs.push(messageError('cannot set --all and --selector at the same time'));
  if (split.resources.length < 1 && filenames.length === 0 && kustomize === '') errs.push(messageError('one or more resources must be specified as <resource> <name> or <resource>/<name>'));
  if (images.length < 1) errs.push(messageError('at least one image update is required'));
  else if (images.length > 1 && images.some(([n]) => n === '*')) errs.push(messageError('all containers are already specified by *, but saw more than one container_name=container_image pairs'));
  if (local && dryRun === 'server') errs.push(messageError('cannot specify --local and --dry-run=server - did you mean --dry-run=client?'));
  if (errs.length > 0) return yield* fail(p, errs.length === 1 ? (errs[0] as KubectlError) : { type: 'aggregate', errors: errs });
  // Run: CalculatePatches
  const allErrs: KubectlError[] = [];
  const patches: Patch[] = [];
  for (const info of infos) {
    const id = typeIdOf(info.object);
    if (!id) return yield* p.unsupported({ kind: 'behavior', what: `kubectl set image on a ${str(info.object.kind)}, which has no built-in type` });
    const before = typed(info.object);
    const after = typed(info.object);
    const spec = podSpecOf(after);
    if (!spec) {
      // %T of the typed object: the version package's name and the kind.
      const version = str(after.apiVersion).split('/').pop() as string;
      patches.push({ info, error: messageError(`error: ${info.mapping.resource}/${info.name} the object is not a pod or does not have a pod template: *${version}.${str(after.kind)}\n`) });
      continue;
    }
    for (const [name, image] of images) {
      const inInit = setImage(spec.initContainers, name, image);
      const inMain = setImage(spec.containers, name, image);
      if (!inInit && !inMain) allErrs.push(messageError(`error: unable to find container named ${JSON.stringify(name)}`));
    }
    const patch = createTwoWayMergePatch(before, after, id);
    if ('error' in patch) return yield* p.unsupported({ kind: 'behavior', what: `a set image patch that cannot be computed (${patch.error})` });
    info.object = after;
    patches.push({ info, patch: patch.ok });
  }
  for (const pt of patches) {
    if (pt.error) {
      allErrs.push(pt.error);
      continue;
    }
    const info = pt.info;
    if (marshalJson(pt.patch as JsonObject) === '{}') continue;
    let out = info.object;
    if (!local && dryRun !== 'client') {
      const s = found.session as Session;
      const r = yield* request(s, {
        verb: 'patch',
        ...infoBase(info),
        name: info.name,
        body: pt.patch as JsonObject,
        options: { patchType: 'strategic', fieldManager: str(v['field-manager']), ...(dryRun === 'server' ? { dryRun: true } : {}) },
      });
      if (!r.ok) {
        if ('notSimulated' in r) return yield* p.unsupported({ kind: 'behavior', what: r.notSimulated });
        allErrs.push(messageError(`failed to patch image update to pod template: ${r.status.message ?? ''}`));
        continue;
      }
      out = r.object as JsonObject;
    }
    try {
      yield* p.write(1, printer.print(out));
    } catch (e) {
      if (!(e instanceof YamlMarshalError)) throw e;
      allErrs.push(messageError(e.message));
    }
  }
  if (allErrs.length > 0) return yield* fail(p, allErrs.length === 1 ? (allErrs[0] as KubectlError) : { type: 'aggregate', errors: allErrs });
  return 0;
}

export const setImageVerb: Verb = {
  path: 'set image',
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
