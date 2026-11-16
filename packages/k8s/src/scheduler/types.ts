// The scheduling framework's vocabulary, reduced to what the simulator's plugins use.
// upstream: staging/src/k8s.io/kube-scheduler/framework/interface.go (Code, Status,
// PreFilterResult, plugin interfaces), pkg/scheduler/framework/types.go (NodeInfo, Resource).

import type { ApiObject } from '../apiserver/store.ts';
import type { ControllerEvent } from '../controllers/types.ts';
import type { ResourceList } from './resources.ts';

/** upstream: fwk.Code. */
export type Code = 'Success' | 'Error' | 'Unschedulable' | 'UnschedulableAndUnresolvable' | 'Wait' | 'Skip' | 'Pending';

export interface Status {
  code: Code;
  reasons: string[];
  /** The plugin that returned it (Status.plugin, set by the framework). */
  plugin?: string;
}

export const SUCCESS: Status = { code: 'Success', reasons: [] };

export function status(code: Code, ...reasons: string[]): Status {
  return { code, reasons };
}

export interface HostPort {
  ip: string;
  protocol: string;
  port: number;
}

/** What the scheduler's cache knows about one node. upstream: framework.NodeInfo. */
export interface NodeInfo {
  name: string;
  node: ApiObject;
  /** Pods assigned to the node, as stored. */
  pods: ApiObject[];
  /** Sum of the Pods' requests (PodRequests). */
  requested: ResourceList;
  /** Sum of the Pods' requests with the non-zero defaults (scoring). */
  nonZeroRequested: ResourceList;
  allocatable: ResourceList;
  usedPorts: HostPort[];
  /** Image name → size in bytes, from Node.status.images (ImageLocality). */
  images: Record<string, number>;
}

/** Per-cycle data a plugin's PreFilter or PreScore computed for later steps. */
export type CycleState = Record<string, unknown>;

export interface PreFilterResult {
  /** Only these nodes can pass (nil in upstream means all). */
  nodeNames?: string[];
}

/** A cluster event as the scheduling queue sees it: a watch event of a Node or a Pod. */
export interface ClusterEvent {
  resource: 'Node' | 'Pod';
  ev: ControllerEvent;
}

export type QueueingHint = 'Queue' | 'QueueSkip';

export interface FilterPlugin {
  name: string;
  /** Returns a status, or a status with a result narrowing the nodes. */
  preFilter?(state: CycleState, pod: ApiObject, nodes: NodeInfo[]): { status: Status; result?: PreFilterResult };
  filter(state: CycleState, pod: ApiObject, node: NodeInfo): Status;
  /**
   * Whether an event may make a Pod this plugin rejected schedulable (EventsToRegister with its
   * QueueingHintFn). Absent means the plugin registers no events.
   */
  hint?(pod: ApiObject, e: ClusterEvent): QueueingHint;
}

export interface ScorePlugin {
  name: string;
  weight: number;
  preScore?(state: CycleState, pod: ApiObject, nodes: NodeInfo[]): Status;
  score(state: CycleState, pod: ApiObject, node: NodeInfo): number;
  /** NormalizeScore over the scores of every feasible node, in place. */
  normalize?(state: CycleState, pod: ApiObject, scores: { name: string; score: number }[]): void;
}

/** upstream: fwk.MaxNodeScore. */
export const MAX_NODE_SCORE = 100;
