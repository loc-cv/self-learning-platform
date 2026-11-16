// describe deployment.
//   upstream: staging/src/k8s.io/kubectl/pkg/describe/describe.go describeDeployment,
//             printReplicaSetsByLabels, DescribePodTemplate, DescribeEvents

import type { Millis } from '@simlab/kernel';
import type { Json, JsonObject } from '../../apimachinery/json.ts';
import { isSelectorError, labelSelectorAsSelector, selectorString } from '../../apimachinery/labels.ts';
import { describeEvents, meta, obj, objs, printAnnotationsMultiline, printLabelsMultiline } from './common.ts';
import { describePodTemplate } from './pod.ts';
import { d, LEVEL_0, LEVEL_1, rfc1123z, s, tabbedString } from './writer.ts';

const intOrString = (v: Json | undefined): string => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '0');

/** printReplicaSetsByLabels */
function replicaSetsText(sets: JsonObject[]): string {
  const list = sets.map((rs) => `${s(meta(rs).name)} (${d(obj(rs.status).replicas)}/${d(obj(rs.spec).replicas)} replicas created)`).join(', ');
  return list === '' ? '<none>' : list;
}

/** describeDeployment; an invalid selector is the error LabelSelectorAsSelector returns. */
export function describeDeployment(dep: JsonObject, oldRSs: JsonObject[], newRSs: JsonObject[], events: JsonObject[] | undefined, now: Millis): string | { error: string } {
  const spec = obj(dep.spec);
  const status = obj(dep.status);
  const selector = labelSelectorAsSelector(spec.selector);
  if (isSelectorError(selector)) return { error: selector.error };
  const m = meta(dep);
  return tabbedString((w) => {
    w.write(LEVEL_0, `Name:\t${s(m.name)}\n`);
    w.write(LEVEL_0, `Namespace:\t${s(m.namespace)}\n`);
    w.write(LEVEL_0, `CreationTimestamp:\t${rfc1123z(m.creationTimestamp)}\n`);
    printLabelsMultiline(w, 'Labels', m.labels);
    printAnnotationsMultiline(w, 'Annotations', m.annotations);
    w.write(LEVEL_0, `Selector:\t${selectorString(selector)}\n`);
    w.write(
      LEVEL_0,
      `Replicas:\t${d(spec.replicas)} desired | ${d(status.updatedReplicas)} updated | ${d(status.replicas)} total | ${d(status.availableReplicas)} available | ${d(status.unavailableReplicas)} unavailable\n`,
    );
    const strategy = obj(spec.strategy);
    w.write(LEVEL_0, `StrategyType:\t${s(strategy.type)}\n`);
    w.write(LEVEL_0, `MinReadySeconds:\t${d(spec.minReadySeconds)}\n`);
    if (strategy.rollingUpdate !== undefined && strategy.rollingUpdate !== null) {
      const ru = obj(strategy.rollingUpdate);
      w.write(LEVEL_0, `RollingUpdateStrategy:\t${intOrString(ru.maxUnavailable)} max unavailable, ${intOrString(ru.maxSurge)} max surge\n`);
    }
    describePodTemplate(spec.template, w);
    const conditions = objs(status.conditions);
    if (conditions.length > 0) {
      w.write(LEVEL_0, 'Conditions:\n  Type\tStatus\tReason\n');
      w.write(LEVEL_1, '----\t------\t------\n');
      for (const c of conditions) w.write(LEVEL_1, `${s(c.type)} \t${s(c.status)}\t${s(c.reason)}\n`);
    }
    if (oldRSs.length > 0 || newRSs.length > 0) {
      w.write(LEVEL_0, `OldReplicaSets:\t${replicaSetsText(oldRSs)}\n`);
      w.write(LEVEL_0, `NewReplicaSet:\t${replicaSetsText(newRSs)}\n`);
    }
    if (events) describeEvents(events, w, now);
  });
}
