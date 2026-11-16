// kube-controller-manager as far as this phase models it: a set of controllers started and
// stopped together against one API server. Phase 27 ties start and stop to the static Pod's
// process and reads the enabled set from its --controllers flag.
//
// Start order is the registration order of upstream's NewControllerDescriptors
// (cmd/kube-controller-manager/app/controller_descriptor.go); upstream then starts them while
// iterating a Go map, which has no defined order, so this list is the simulator's fixed choice.

import type { Ctx } from '@simlab/kernel';
import type { ApiServerConfig } from '../apiserver/config.ts';
import { controllerSpecs, runningControllers, startController, stopController } from './runtime.ts';

export const KUBE_CONTROLLER_MANAGER = 'kube-controller-manager';

/** NewControllerDescriptors' registration order, for the controllers that exist in the simulator. */
export const START_ORDER: readonly string[] = [
  'serviceaccount-token',
  'endpoints',
  'endpointslice',
  'endpointslice-mirroring',
  'replicationcontroller',
  'pod-garbage-collector',
  'resourcequota',
  'namespace',
  'serviceaccount',
  'garbage-collector',
  'daemonset',
  'job',
  'deployment',
  'replicaset',
  'horizontalpodautoscaling',
  'disruption',
  'statefulset',
  'cronjob',
  'ttl',
  'node-lifecycle',
  'root-ca-certificate-publisher',
];

export interface ControllerManagerOptions {
  instance?: string;
  /** Controllers to run (--controllers); default: every registered one. */
  controllers?: readonly string[];
}

/** Starts the controllers of a controller manager against `server`. */
export function startControllerManager(ctx: Ctx, server: ApiServerConfig, opts: ControllerManagerOptions = {}): void {
  const instance = opts.instance ?? KUBE_CONTROLLER_MANAGER;
  const registered = controllerSpecs(ctx).filter((s) => s.component === 'kube-controller-manager').map((s) => s.name);
  const wanted = opts.controllers ?? registered;
  for (const name of wanted) if (!registered.includes(name)) throw new Error(`unknown controller ${name}`);
  const rank = (n: string): number => {
    const i = START_ORDER.indexOf(n);
    return i < 0 ? START_ORDER.length : i;
  };
  const ordered = [...wanted].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const name of ordered) startController(ctx, instance, name, server);
}

export function stopControllerManager(ctx: Ctx, instance: string = KUBE_CONTROLLER_MANAGER): void {
  for (const name of runningControllers(ctx, instance)) stopController(ctx, instance, name);
}
