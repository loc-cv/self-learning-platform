// The controller contract (docs/ARCHITECTURE.md §4.3): what a controller watches, how a watch
// event maps to work queue keys, and how one key is reconciled. A controller holds no state
// outside the store and its ControllerState; what a real controller keeps in its informer cache is
// read from the store through `Reader`, and writes go through the request pipeline as the
// controller's own identity.

import type { Ctx, Millis } from '@simlab/kernel';
import type { Json } from '../apimachinery/json.ts';
import type { ApiServerConfig } from '../apiserver/config.ts';
import type { ApiObject, WatchEventType } from '../apiserver/store.ts';
import type { Client } from '../client/client.ts';

/** A watch event as a controller's event handler sees it (informer Add/Update/Delete). */
export interface ControllerEvent {
  type: WatchEventType;
  /** The object as stored now; for DELETED, its last state. */
  object: ApiObject;
  /** MODIFIED: the previous state (the informer's old object). */
  old?: ApiObject;
  /**
   * An ADDED event of the initial list at controller start (the informer's first sync), for
   * handlers that act once at start, like the endpoints controller's checkLeftoverEndpoints.
   */
  initial?: true;
}

/** The informer cache: objects as stored, in key order. Resources are `apps/v1/replicasets`, `v1/pods`. */
export interface Reader {
  get(resource: string, namespace: string | undefined, name: string): ApiObject | undefined;
  list(resource: string, namespace?: string): ApiObject[];
}

export interface WatchSpec {
  /** `group/version/resource`, or `version/resource` for the core group. */
  resource: string;
  /**
   * The work queue keys an event produces (the controller's event handler). `data` is the
   * controller's bookkeeping (SyncCtx.data), read-only here: the scheduler's queueing hints
   * consult the Pods it holds as unschedulable.
   */
  keys(ev: ControllerEvent, read: Reader, data: Readonly<Record<string, Json>>): string[];
}

export type SyncResult =
  | { done: true }
  /** Done, and the key comes back after this delay (AddAfter). */
  | { requeueAfter: Millis }
  /** Requeued with the rate limiter's backoff (AddRateLimited), up to `maxRetries`. */
  | { error: string };

export type EventType = 'Normal' | 'Warning';

export interface SyncCtx extends Reader {
  readonly ctx: Ctx;
  readonly server: ApiServerConfig;
  readonly now: Millis;
  /** Requests go through the pipeline as the controller's service account; writes are traced. */
  readonly client: Client;
  /** EventRecorder.Event for the controller's event source. */
  event(object: ApiObject, type: EventType, reason: string, message: string): void;
  /** Adds a key of this controller's queue after a delay (workqueue AddAfter). */
  enqueueAfter(key: string, delay: Millis): void;
  /** The id of this sync's `controller.sync` trace record: a cause for records emitted on its behalf. */
  readonly syncId: number;
  /** A trace record caused by this sync (and by `causes`, records of the same sync it follows from). */
  trace(kind: string, message: string, data?: Json, subject?: string, causes?: readonly number[]): number;
  /** Bookkeeping that changes behavior and must survive fork and restore (rarely needed). */
  data(): Record<string, Json>;
  setData(key: string, value: Json | undefined): void;
}

export interface ControllerSpec {
  /** Upstream controller name, as `--controllers` names it: `deployment`, `replicaset`. */
  name: string;
  /** The component that runs it. */
  component: 'kube-controller-manager' | 'kube-scheduler' | 'kubelet';
  /**
   * Service account the controller acts as (kubeadm runs the controller manager with
   * --use-service-account-credentials=true): `deployment-controller`.
   */
  serviceAccount: string;
  /**
   * The identity when it is not a service account: kube-scheduler authenticates with its
   * kubeconfig's client certificate as `system:kube-scheduler`.
   */
  user?: { username: string; groups: string[] };
  /** The identity when it depends on the instance: each kubelet is `system:node:<node>`. */
  userOf?(instance: string): { username: string; groups: string[] };
  /** EventSource.Component of its event recorder, when it records events. */
  eventSource?: string;
  watches: WatchSpec[];
  sync(c: SyncCtx, key: string): SyncResult;
  /** Delay between a watch event and the sync of the keys it produced: modeled reaction time. */
  latency: Millis;
  /**
   * The per-key ItemExponentialFailureRateLimiter when the controller's queue is not built with
   * DefaultTypedControllerRateLimiter (endpointslice: 1 s base, 1000 s max); absent means 5 ms and
   * 1000 s.
   */
  backoff?: { baseMs: Millis; maxMs: Millis };
  /** Errors after which a key is dropped (deployment: 15); absent means retry forever. */
  maxRetries?: number;
}
