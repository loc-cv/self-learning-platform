// kubectl rollout history: a Deployment's revisions from its ReplicaSets, with their change-cause,
// or one revision's pod template; with -o, the ReplicaSets themselves.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/rollout/rollout_history.go NewCmdRolloutHistory
//             (flags), Complete, Validate ("revision must be a positive integer"), Run (with -o:
//             the printer over GetHistory's objects in revision order, "unable to find the
//             specified revision"; without: ViewHistory as the NamePrinter's operation,
//             `with revision #N`)
//   upstream: staging/src/k8s.io/kubectl/pkg/polymorphichelpers/history.go HistoryViewerFor (the
//             errors for kinds without a viewer), DeploymentHistoryViewer.ViewHistory (the change-cause
//             copied onto each template's annotations, "No rollout history found.", the
//             `REVISION\tCHANGE-CAUSE` table through tabbedString, `<none>`), GetHistory,
//             the klog warning for an unparsable revision (history.go:114 and :172)
//   upstream: staging/src/k8s.io/kubectl/pkg/apps/kind_visitor.go GroupKindElement.Accept

import type { Op } from '@simlab/host';
import { cloneJson, isObject, type JsonObject } from '../../../apimachinery/json.ts';
import type { Invocation, Verb } from '../../cli/command.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import type { FlagDef } from '../../cli/flagset.ts';
import type { Mapping } from '../../client/restmapper.ts';
import { fail, klogLine, type Session } from '../../client/session.ts';
import { DESCRIBE_TABWRITER, newTabWriter, tabFlush, tabWrite } from '../../printers/tabwriter.ts';
import { CHANGE_FORMATS, toPrinter, type Printer } from '../helpers.ts';
import { annotations, CHANGE_CAUSE_ANNOTATION, deploymentReplicaSets, meta, printTemplate, revisionOf } from './deployment.ts';
import { aggregateOf, buildInfos, configOf, groupKindString, kustomizeNotice, requiredResource } from './infos.ts';
import { typedPrinter } from '../typed.ts';
import { appsKindNotice, visitorAccepts } from './kinds.ts';

export const HISTORY_FLAGS: FlagDef[] = [
  { name: 'revision', kind: 'int64', default: 0 },
  { name: 'selector', shorthand: 'l', kind: 'string', default: '' },
  { name: 'filename', shorthand: 'f', kind: 'stringSlice', default: [] },
  { name: 'recursive', shorthand: 'R', kind: 'bool', default: false },
  { name: 'kustomize', shorthand: 'k', kind: 'string', default: '' },
  { name: 'output', shorthand: 'o', kind: 'string', default: '' },
  { name: 'template', kind: 'string', default: '' },
];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** HistoryViewerFor: the viewer for a kind, or its error. Only Deployments have one here. */
function* historyViewer(inv: Invocation, m: Mapping): Op<'deployment' | KubectlError | number> {
  const gk = groupKindString(m);
  if (!visitorAccepts(m)) return messageError(`error retrieving history for "${gk}", no visitor method exists for {${m.group} ${m.kind}}`);
  if (m.kind === 'Deployment') return 'deployment';
  if (m.kind === 'DaemonSet' || m.kind === 'StatefulSet') return yield* appsKindNotice(inv.p, 'rollout history', m.kind);
  return messageError(`no history viewer has been implemented for "${gk}"`);
}

/** The ReplicaSets by revision; unparsable revisions are skipped with klog's warning. */
function* byRevision(s: Session, rss: JsonObject[], name: string, namespace: string, line: number): Op<Map<bigint, JsonObject>> {
  const out = new Map<bigint, JsonObject>();
  for (const rs of rss) {
    const r = revisionOf(rs);
    if ('error' in r) {
      yield* s.p.write(2, klogLine(s.p, 'W', `history.go:${line}`, `unable to get revision from replicaset ${str(meta(rs).name)} for deployment ${name} in namespace ${namespace}: ${r.error}`));
      continue;
    }
    out.set(r.value, rs);
  }
  return out;
}

const sortedKeys = (m: Map<bigint, unknown>): bigint[] => [...m.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** DeploymentHistoryViewer.ViewHistory */
function* viewHistory(s: Session, namespace: string, name: string, revision: bigint): Op<string | KubectlError> {
  const got = yield* deploymentReplicaSets(s, namespace, name);
  if ('error' in got) return got.error;
  const revs = yield* byRevision(s, got.replicaSets, name, namespace, 114);
  const templates = new Map<bigint, JsonObject>();
  for (const [v, rs] of revs) {
    const spec = isObject(rs.spec) ? rs.spec : {};
    const t: JsonObject = isObject(spec.template) ? cloneJson(spec.template) : {};
    const md: JsonObject = isObject(t.metadata) ? t.metadata : (t.metadata = {});
    const changeCause = annotations(rs)[CHANGE_CAUSE_ANNOTATION] ?? '';
    if (!isObject(md.annotations)) md.annotations = {};
    if (changeCause.length > 0) (md.annotations as JsonObject)[CHANGE_CAUSE_ANNOTATION] = changeCause;
    templates.set(v, t);
  }
  if (templates.size === 0) return 'No rollout history found.';
  if (revision > 0n) {
    const t = templates.get(revision);
    if (!t) return messageError('unable to find the specified revision');
    return printTemplate(t);
  }
  // tabbedString: tabwriter.Init(buf, 0, 8, 2, ' ', 0)
  const tw = newTabWriter(DESCRIBE_TABWRITER);
  let out = tabWrite(tw, 'REVISION\tCHANGE-CAUSE\n');
  for (const r of sortedKeys(templates)) {
    const t = templates.get(r) as JsonObject;
    const a = isObject(t.metadata) && isObject(t.metadata.annotations) ? t.metadata.annotations : {};
    const changeCause = str(a[CHANGE_CAUSE_ANNOTATION]);
    out += tabWrite(tw, `${r}\t${changeCause.length === 0 ? '<none>' : changeCause}\n`);
  }
  return out + tabFlush(tw);
}

/** DeploymentHistoryViewer.GetHistory: the ReplicaSets by revision. */
function* getHistory(s: Session, namespace: string, name: string): Op<Map<bigint, JsonObject> | KubectlError> {
  const got = yield* deploymentReplicaSets(s, namespace, name);
  if ('error' in got) return got.error;
  return yield* byRevision(s, got.replicaSets, name, namespace, 172);
}

function* run(inv: Invocation): Op<number> {
  const { p, flags } = inv;
  const v = flags.values;
  const config = yield* configOf(inv);
  if (typeof config === 'number') return config;
  const required = requiredResource(inv);
  if (required) return yield* fail(p, required);
  const revision = BigInt(v.revision as number | bigint);
  if (revision < 0n) return yield* fail(p, messageError(`revision must be a positive integer: ${revision}`));
  const k = yield* kustomizeNotice(inv);
  if (k !== undefined) return k;
  const built = yield* buildInfos(inv, config);
  if (typeof built === 'number') return built;
  const outputSpecified = flags.changed.includes('output');
  const template = str(v.template);
  let printer: Printer | undefined;
  if (outputSpecified) {
    const pr = typedPrinter(str(v.output), '', 'none', template);
    if ('type' in pr) return yield* fail(p, pr);
    printer = pr;
  }
  const errors: KubectlError[] = [];
  for (const item of built.visited) {
    if ('error' in item) {
      errors.push(item.error);
      continue;
    }
    const { info } = item;
    const viewer = yield* historyViewer(inv, info.mapping);
    if (typeof viewer === 'number') return viewer;
    if (viewer !== 'deployment') {
      errors.push(viewer);
      continue;
    }
    const s = built.session as Session;
    if (printer) {
      const history = yield* getHistory(s, info.namespace, info.name);
      if (!(history instanceof Map)) {
        errors.push(history);
        continue;
      }
      if (revision > 0n) {
        const rs = history.get(revision);
        if (!rs) {
          errors.push(messageError('unable to find the specified revision'));
          continue;
        }
        yield* p.write(1, printer.print(rs));
      } else {
        let text = '';
        for (const r of sortedKeys(history)) text += printer.print(history.get(r) as JsonObject);
        yield* p.write(1, text);
      }
      continue;
    }
    const historyInfo = yield* viewHistory(s, info.namespace, info.name, revision);
    if (typeof historyInfo !== 'string') {
      errors.push(historyInfo);
      continue;
    }
    const withRevision = revision > 0n ? `with revision #${revision}` : '';
    const pr = toPrinter('', `${withRevision}\n${historyInfo}`, 'none', template);
    if ('type' in pr) return yield* fail(p, pr);
    yield* p.write(1, pr.print(info.object));
  }
  const err = aggregateOf(errors);
  return err ? yield* fail(p, err) : 0;
}

export const historyVerb: Verb = {
  path: 'rollout history',
  flags: HISTORY_FLAGS,
  noEffect: {
    'allow-missing-template-keys': 'only matters to template output formats, which print a notice',
    'show-managed-fields': 'objects have no managedFields (DIV-015)',
  },
  partial: { kustomize: 'every value', template: 'every value' },
  outputFormats: { allowed: CHANGE_FORMATS, simulated: ['json', 'yaml', 'name'] },
  run,
};
