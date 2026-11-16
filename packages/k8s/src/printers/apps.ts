// Printers of the apps group's kinds and of the scale subresource.
// upstream: pkg/printers/internalversion/printers.go printDeployment, printReplicaSet,
// printDaemonSet, printScale.

import type { Json, JsonObject } from '../apimachinery/json.ts';
import { formatLabelSelector, formatLabels, labelSelectorAsSelector, selectorString } from '../apimachinery/labels.ts';
import { age, layoutContainerCells, nameOf, num, obj, objs, row, strMap, type GenerateOptions } from './helpers.ts';
import type { TableRow } from './types.ts';

const templateContainers = (o: JsonObject): JsonObject[] => objs(obj(obj(obj(o.spec).template).spec).containers);

export function printDeployment(d: JsonObject, o: GenerateOptions): TableRow[] {
  const spec = obj(d.spec);
  const status = obj(d.status);
  const sel = labelSelectorAsSelector(spec.selector);
  const selectorText = 'error' in sel ? '<invalid>' : selectorString(sel);
  const cells: Json[] = [nameOf(d), `${num(status.readyReplicas)}/${num(spec.replicas)}`, num(status.updatedReplicas), num(status.availableReplicas), age(d, o)];
  if (o.wide) {
    const [names, images] = layoutContainerCells(templateContainers(d));
    cells.push(names, images, selectorText);
  }
  return [row(d, cells)];
}

export function printReplicaSet(rs: JsonObject, o: GenerateOptions): TableRow[] {
  const spec = obj(rs.spec);
  const status = obj(rs.status);
  const cells: Json[] = [nameOf(rs), num(spec.replicas), num(status.replicas), num(status.readyReplicas), age(rs, o)];
  if (o.wide) {
    const [names, images] = layoutContainerCells(templateContainers(rs));
    cells.push(names, images, formatLabelSelector(spec.selector));
  }
  return [row(rs, cells)];
}

export function printDaemonSet(ds: JsonObject, o: GenerateOptions): TableRow[] {
  const status = obj(ds.status);
  const nodeSelector = strMap(obj(obj(obj(ds.spec).template).spec).nodeSelector);
  const cells: Json[] = [
    nameOf(ds),
    num(status.desiredNumberScheduled),
    num(status.currentNumberScheduled),
    num(status.numberReady),
    num(status.updatedNumberScheduled),
    num(status.numberAvailable),
    formatLabels(nodeSelector),
    age(ds, o),
  ];
  if (o.wide) {
    const [names, images] = layoutContainerCells(templateContainers(ds));
    cells.push(names, images, formatLabelSelector(obj(ds.spec).selector));
  }
  return [row(ds, cells)];
}

/** autoscaling Scale (the scale subresource of Deployments and ReplicaSets). */
export function printScale(scale: JsonObject, o: GenerateOptions): TableRow[] {
  return [row(scale, [nameOf(scale), num(obj(scale.spec).replicas), num(obj(scale.status).replicas), age(scale, o)])];
}
