// How the runtime's changes reach the kubelet: the generic PLEG relists every second
// (pkg/kubelet/kubelet.go genericPlegRelistPeriod = 1 s; EventedPLEG is alpha and off at v1.37), so
// a container that starts or dies is noticed at the next relist tick, on a grid that starts with
// the kubelet. A kubelet that is not running notices nothing; when it starts it relists everything.

import type { Ctx, Millis } from '@simlab/kernel';
import { k8sSlice } from '../apiserver/store.ts';
import { enqueue } from '../controllers/runtime.ts';

/** The kubelet runs as a controller named `kubelet` whose instance is the node. */
export const KUBELET = 'kubelet';
export const PLEG_RELIST_MS: Millis = 1000;

export const kubeletId = (node: string): string => `${node}/${KUBELET}`;

/** The work-queue key of a Pod: the pod worker is per UID; namespace and name keep traces readable. */
export const podKey = (namespace: string, name: string, uid: string): string => `${namespace}/${name}/${uid}`;

/** Delay until the next relist tick of the kubelet on `node`, or undefined when it is not running. */
export function untilRelist(ctx: Ctx, node: string): Millis | undefined {
  const st = k8sSlice(ctx).controllers[kubeletId(node)];
  if (!st) return undefined;
  const started = st.data.started as number;
  return PLEG_RELIST_MS - ((ctx.now - started) % PLEG_RELIST_MS);
}

/** A runtime change to a Pod's sandbox or containers: the PLEG reports it at its next relist. */
export function plegEvent(ctx: Ctx, node: string, key: string, cause: string): void {
  const delay = untilRelist(ctx, node);
  if (delay === undefined) return;
  enqueue(ctx, kubeletId(node), key, delay, `PLEG: ${cause}`);
}

/** A CRI call the kubelet is blocked on returned (a pull, StopContainer): it continues at once. */
export function criReturned(ctx: Ctx, node: string, key: string, cause: string): void {
  if (!k8sSlice(ctx).controllers[kubeletId(node)]) return;
  enqueue(ctx, kubeletId(node), key, 0, cause);
}
