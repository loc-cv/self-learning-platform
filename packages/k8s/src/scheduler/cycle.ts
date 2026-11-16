// One scheduling cycle for one Pod: PreFilter, Filter on every node, PostFilter (the preemption
// message), Score and host selection. Pure: it reads a snapshot and returns a decision with the
// per-node detail the trace records; the caller writes the binding or the failure.
//
// upstream: pkg/scheduler/schedule_one.go schedulePod, findNodesThatFitPod (PreFilterResult and
// "node(s) didn't satisfy plugin(s) %v" for nodes it excludes), findNodesThatPassFilters,
// prioritizeNodes; framework/runtime/framework.go RunPreFilterPlugins (Skip, rejection, merged
// results, "node(s) didn't satisfy plugin %v"), RunFilterPlugins (the first rejecting plugin per
// node decides), RunScorePlugins (NormalizeScore, weights); framework/types.go FitError.Error,
// NoNodeAvailableMsg; framework/preemption/preemption.go Evaluator.evaluate, findCandidates;
// plugins/defaultpreemption/default_preemption.go PostFilter ("preemption: " prefix),
// PodEligibleToPreemptOthers, SelectVictimsOnNode ("No preemption victims found for incoming pod").
//
// numFeasibleNodesToFind is at least 100 nodes, so every node of a simulated cluster is checked.

import type { ApiObject } from '../apiserver/store.ts';
import { compareCodeUnits } from '../apiserver/store.ts';
import { FILTERS } from './plugins/filters.ts';
import { SCORES } from './plugins/scores.ts';
import type { CycleState, NodeInfo, PreFilterResult, Status } from './types.ts';
import { specOf, str } from './util.ts';

/** upstream: framework/types.go NoNodeAvailableMsg. */
const NO_NODE_AVAILABLE = (n: number): string => `0/${n} nodes are available`;
const NOT_HELPFUL = 'Preemption is not helpful for scheduling';
const NO_VICTIMS = 'No preemption victims found for incoming pod';
const NOT_ELIGIBLE_NEVER = 'not eligible due to preemptionPolicy=Never.';

export interface NodeVerdict {
  node: string;
  /** The rejecting plugin, or absent when the node passed every filter. */
  plugin?: string;
  status: Status;
}

export interface NodeScore {
  node: string;
  total: number;
  /** Weighted score per plugin. */
  plugins: Record<string, number>;
}

export type CycleResult =
  | { kind: 'scheduled'; node: string; verdicts: NodeVerdict[]; scores: NodeScore[]; feasible: number }
  | {
      kind: 'unschedulable';
      /** The FitError message, preemption part included. */
      message: string;
      verdicts: NodeVerdict[];
      /** Plugins that rejected the Pod (UnschedulablePlugins), for the queueing hints. */
      plugins: string[];
    };

/** Per-node statuses: explicit ones, plus one status for every node not listed (NodeToStatus). */
interface NodeToStatus {
  explicit: { node: string; status: Status }[];
  absent?: Status;
}

/** upstream: FitError.Error. */
export function fitErrorMessage(numAllNodes: number, m: NodeToStatus, preFilterMsg: string, postFilterMsg: string): string {
  let msg = `${NO_NODE_AVAILABLE(numAllNodes)}:`;
  if (preFilterMsg !== '') msg += ` ${preFilterMsg}.`;
  else {
    const reasons = new Map<string, number>();
    for (const e of m.explicit) for (const r of e.status.reasons) reasons.set(r, (reasons.get(r) ?? 0) + 1);
    if (m.explicit.length < numAllNodes && m.absent) {
      for (const r of m.absent.reasons) reasons.set(r, (reasons.get(r) ?? 0) + numAllNodes - m.explicit.length);
    }
    // sort.Strings over "%v %v" (count, reason): byte order, so "10 …" sorts before "2 …".
    const sorted = [...reasons].map(([r, n]) => `${n} ${r}`).sort(compareCodeUnits);
    if (sorted.length > 0) msg += ` ${sorted.join(', ')}.`;
  }
  if (postFilterMsg !== '') msg += ` ${postFilterMsg}`;
  return msg;
}

function priorityOf(pod: ApiObject): number {
  const p = specOf(pod).priority;
  return typeof p === 'number' ? p : 0;
}

/**
 * DefaultPreemption's PostFilter message when no Pod can be preempted. Preemption itself (choosing
 * and evicting victims) is phase 20b: while no PriorityClass exists every Pod has priority 0, so
 * there are never victims; if a lower-priority Pod does exist, `victimsExist` is reported to the
 * caller, which records a gap.
 */
export function postFilterMessage(pod: ApiObject, nodes: NodeInfo[], m: NodeToStatus): { message: string; victimsExist: boolean } {
  if (str(specOf(pod).preemptionPolicy) === 'Never') return { message: `preemption: ${NOT_ELIGIBLE_NEVER}`, victimsExist: false };
  const potential = nodes.filter((n) => {
    const e = m.explicit.find((x) => x.node === n.name);
    const s = e ? e.status : m.absent;
    return s?.code === 'Unschedulable';
  });
  const explicit: { node: string; status: Status }[] = [];
  let victimsExist = false;
  const prio = priorityOf(pod);
  for (const n of potential) {
    if (n.pods.some((p) => priorityOf(p) < prio)) victimsExist = true;
    explicit.push({ node: n.name, status: { code: 'UnschedulableAndUnresolvable', reasons: [NO_VICTIMS] } });
  }
  const inner = fitErrorMessage(nodes.length, { explicit, absent: { code: 'UnschedulableAndUnresolvable', reasons: [NOT_HELPFUL] } }, '', '');
  return { message: `preemption: ${inner}`, victimsExist };
}

/** Runs one scheduling cycle of `pod` against `nodes` (the snapshot, in cache order). */
export interface CycleOptions {
  /**
   * The order feasible nodes are appended in. Upstream filters nodes in parallel goroutines (chunk
   * size 1 for small clusters, schedule_one.go findNodesThatPassFilters) and appends each feasible
   * node when its goroutine finishes, so the order, and with it the winner among equal scores, varies
   * between runs (D-037). The simulator draws it from a named PRNG stream.
   */
  order(feasible: NodeInfo[]): NodeInfo[];
}

export function schedulePod(pod: ApiObject, nodes: NodeInfo[], opts: CycleOptions): CycleResult & { victimsExist?: boolean } {
  const state: CycleState = { allNodes: nodes };
  const skip = new Set<string>();
  let result: PreFilterResult | undefined;
  const narrowing: string[] = [];
  const rejected = new Set<string>();
  let preFilterStatus: Status | undefined;
  for (const pl of FILTERS) {
    if (!pl.preFilter) continue;
    const r = pl.preFilter(state, pod, nodes);
    if (r.status.code === 'Skip') {
      skip.add(pl.name);
      continue;
    }
    if (r.status.code !== 'Success') {
      preFilterStatus = { ...r.status, plugin: pl.name };
      rejected.add(pl.name);
      break;
    }
    if (r.result?.nodeNames) {
      narrowing.push(pl.name);
      const names = r.result.nodeNames;
      result = { nodeNames: result?.nodeNames ? result.nodeNames.filter((x) => names.includes(x)) : [...names] };
      if (result.nodeNames?.length === 0) {
        const list = [...narrowing].sort(compareCodeUnits);
        const msg = list.length === 1 ? `node(s) didn't satisfy plugin ${list[0]}` : `node(s) didn't satisfy plugin(s) [${list.join(' ')}] simultaneously`;
        preFilterStatus = { code: 'UnschedulableAndUnresolvable', reasons: [msg] };
        for (const n of list) rejected.add(n);
        break;
      }
    }
  }

  if (preFilterStatus) {
    const m: NodeToStatus = { explicit: [], absent: preFilterStatus };
    const post = postFilterMessage(pod, nodes, m);
    const verdicts = nodes.map((n) => ({ node: n.name, ...(preFilterStatus.plugin ? { plugin: preFilterStatus.plugin } : {}), status: preFilterStatus }));
    return { kind: 'unschedulable', message: fitErrorMessage(nodes.length, m, preFilterStatus.reasons.join(', '), post.message), verdicts, plugins: [...rejected].sort(compareCodeUnits), victimsExist: post.victimsExist };
  }

  let candidates = nodes;
  let absent: Status | undefined;
  if (result?.nodeNames) {
    const names = result.nodeNames;
    candidates = nodes.filter((n) => names.includes(n.name));
    const list = [...narrowing].sort(compareCodeUnits);
    absent = { code: 'UnschedulableAndUnresolvable', reasons: [`node(s) didn't satisfy plugin(s) [${list.join(' ')}]`] };
    for (const n of list) rejected.add(n);
  }

  const verdicts: NodeVerdict[] = [];
  const explicit: { node: string; status: Status }[] = [];
  const feasible: NodeInfo[] = [];
  for (const n of candidates) {
    let failed: Status | undefined;
    for (const pl of FILTERS) {
      if (skip.has(pl.name)) continue;
      const s = pl.filter(state, pod, n);
      if (s.code !== 'Success') {
        failed = { ...s, plugin: pl.name };
        break;
      }
    }
    if (failed) {
      verdicts.push({ node: n.name, plugin: failed.plugin as string, status: failed });
      explicit.push({ node: n.name, status: failed });
      rejected.add(failed.plugin as string);
    } else {
      verdicts.push({ node: n.name, status: { code: 'Success', reasons: [] } });
      feasible.push(n);
    }
  }
  if (absent) for (const n of nodes) if (!candidates.includes(n)) verdicts.push({ node: n.name, status: absent });

  if (feasible.length === 0) {
    const m: NodeToStatus = { explicit, ...(absent ? { absent } : {}) };
    const post = postFilterMessage(pod, nodes, m);
    return { kind: 'unschedulable', message: fitErrorMessage(nodes.length, m, '', post.message), verdicts, plugins: [...rejected].sort(compareCodeUnits), victimsExist: post.victimsExist };
  }

  const scores = prioritize(state, pod, opts.order(feasible));
  return { kind: 'scheduled', node: selectHost(scores), verdicts, scores, feasible: feasible.length };
}

/** upstream: prioritizeNodes with RunPreScorePlugins and RunScorePlugins. A single feasible node is not scored. */
export function prioritize(state: CycleState, pod: ApiObject, feasible: NodeInfo[]): NodeScore[] {
  const out: NodeScore[] = feasible.map((n) => ({ node: n.name, total: 0, plugins: {} }));
  if (feasible.length === 1) return out;
  for (const pl of SCORES) {
    if (pl.preScore && pl.preScore(state, pod, feasible).code === 'Skip') continue;
    const scores = feasible.map((n) => ({ name: n.name, score: pl.score(state, pod, n) }));
    pl.normalize?.(state, pod, scores);
    scores.forEach((s, i) => {
      const o = out[i] as NodeScore;
      const v = s.score * pl.weight;
      o.plugins[pl.name] = v;
      o.total += v;
    });
  }
  return out;
}

/**
 * The node with the highest total score; among equals, the first in the order the nodes passed
 * Filter. upstream: schedule_one.go schedulePod (NewSortedScoredNodes(...).Pop()),
 * framework/sorted_nodes.go: a container/heap max-heap ordered by TotalScore, then Randomizer,
 * which only extenders set; without extenders it is 0 for every node, so heap.Init and Pop decide.
 */
export function selectHost(scores: NodeScore[]): string {
  // Go's container/heap: Init sifts down from n/2-1 to 0, Pop swaps the root with the last
  // element, sifts the new root down over n-1 elements and returns the old root.
  const h = [...scores];
  const less = (i: number, j: number): boolean => (h[i] as NodeScore).total > (h[j] as NodeScore).total;
  const swap = (i: number, j: number): void => {
    const t = h[i] as NodeScore;
    h[i] = h[j] as NodeScore;
    h[j] = t;
  };
  const down = (i0: number, n: number): void => {
    let i = i0;
    for (;;) {
      const j1 = 2 * i + 1;
      if (j1 >= n || j1 < 0) break;
      let j = j1;
      const j2 = j1 + 1;
      if (j2 < n && less(j2, j1)) j = j2;
      if (!less(j, i)) break;
      swap(i, j);
      i = j;
    }
  };
  const n = h.length;
  for (let i = Math.floor(n / 2) - 1; i >= 0; i--) down(i, n);
  swap(0, n - 1);
  down(0, n - 1);
  return (h[n - 1] as NodeScore).node;
}
