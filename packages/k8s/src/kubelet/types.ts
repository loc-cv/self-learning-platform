// The kubelet's memory, kept in its controller state (lost when it stops, as a process's memory
// is). What survives a restart lives in the node's runtime (runtime/types.ts) and in the API.

import type { Millis } from '@simlab/kernel';
import type { BackoffTable } from './backoff.ts';
import type { ReasonEntry } from './status.ts';

export interface SyncResultEntry {
  container: string;
  /** Absent: the container started. */
  err?: string;
  message?: string;
}

/** One SyncPod in progress (kuberuntime_manager.go SyncPod), suspended on a CRI call. */
export interface SyncPodRun {
  attempted: string[];
  results: SyncResultEntry[];
  error: boolean;
  /** The earliest back-off expiry among this sync's errors (BackoffError). */
  backoffAt?: Millis;
}

export type PodOp =
  | { kind: 'sandbox'; until: Millis; run: SyncPodRun; previous?: string }
  | { kind: 'pull'; container: string; pull: string; startedAt: Millis; run: SyncPodRun }
  | { kind: 'create'; container: string; until: Millis; run: SyncPodRun; imageId: string; imageRef: string; imageName: string; imageDigest: string }
  | { kind: 'start'; container: string; until: Millis; run: SyncPodRun; containerId: string }
  /** Stopping containers: StopContainer calls outstanding; `then` says what follows. */
  | { kind: 'kill'; containers: string[]; then: 'restart' | 'terminate' | 'remove'; run?: SyncPodRun }
  | { kind: 'stopSandbox'; until: Millis; then: 'terminate' | 'remove' };

export interface PodWorker {
  uid: string;
  namespace: string;
  name: string;
  op?: PodOp;
  /** An update arrived while the worker was busy: it syncs again right after. */
  pending?: boolean;
  /** The Pod finished (terminal phase, or deleted and confirmed): no more syncs. */
  done?: boolean;
  /** A deleted Pod's containers are removed at this container GC tick. */
  gcAt?: Millis;
}

export interface PullRequest {
  id: string;
  key: string;
  /** The image as written in the Pod spec. */
  image: string;
  /** The reference sent to the CRI, `nginx:latest`. */
  ref: string;
  requestedAt: Millis;
}

export interface PullResult {
  ok: boolean;
  /** Pull duration (excluding the wait in the serial queue). */
  pullMs: Millis;
  size?: number;
  imageId?: string;
  error?: string;
  notSimulated?: string;
}

export interface KubeletData {
  node: string;
  nodeIP: string;
  podCIDR: string;
  /** Start time: the PLEG relist grid and the housekeeping grids start here. */
  started: Millis;
  pods: Record<string, PodWorker>;
  /** reasonCache: the last sync's failures per Pod UID and container. */
  reasons: Record<string, Record<string, ReasonEntry>>;
  imageBackoff: BackoffTable;
  /** prevPullErrMsg per image back-off key: `ErrImagePull: <message>`. */
  pullErrors: Record<string, string>;
  crashBackoff: BackoffTable;
  /** The serial image puller (serializeImagePulls: true). */
  pulls: { queue: PullRequest[]; current?: PullRequest & { until: Millis; result: PullResult }; done: Record<string, PullResult> };
  /** Node status and Lease loops (node.ts). */
  heartbeat: HeartbeatState;
  nextId: number;
}

export interface HeartbeatState {
  leaseEvent?: string;
  statusEvent?: string;
  /** lastStatusReportTime; absent until the first patch of this process. */
  lastReport?: Millis;
  /** delayAfterNodeStatusChange, ms. */
  reportDelay: Millis;
  /** The image list as last refreshed (every 30 s). */
  images?: { at: Millis; list: { names: string[]; sizeBytes: number }[] };
  /** The Ready status this process last posted. */
  ready?: string;
}
