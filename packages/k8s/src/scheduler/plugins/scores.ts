// The score plugins of the default profile that the simulator models, with integer arithmetic as
// upstream does it. PodTopologySpread and InterPodAffinity are not modeled yet (phase 20b; see
// docs/decisions.md D-056); every other default score plugin scores 0 or is skipped for the
// simulated clusters (no volumes, no DRA).
//
// upstream (pkg/scheduler/framework/plugins/):
//   tainttoleration/taint_toleration.go PreScore, Score, countIntolerableTaintsPreferNoSchedule,
//     NormalizeScore (reversed)
//   nodeaffinity/node_affinity.go PreScore (Skip without preferred terms), Score, NormalizeScore
//   noderesources/fit.go PreScore/Score with least_allocated.go (default strategy LeastAllocated,
//     cpu and memory weight 1: apis/config/v1/defaults.go defaultResourceSpec; requests with the
//     non-zero defaults)
//   noderesources/balanced_allocation.go PreScore (Skip for a best-effort Pod), balancedResourceScorer
//   noderesources/resource_allocation.go calculateNodeAllocatableRequest
//   imagelocality/image_locality.go Score, calculatePriority, sumImageScores, scaledImageScore,
//     normalizedImageName
//   helper/normalize_score.go DefaultNormalizeScore

import type { ApiObject } from '../../apiserver/store.ts';
import { hasPreferredNodeAffinity, preferredAffinityScore, taintsOf, tolerationsOf, toleratesTaint } from '../helpers.ts';
import { arr, podNonZeroRequests, podRequests } from '../resources.ts';
import { MAX_NODE_SCORE, status, SUCCESS, type NodeInfo, type ScorePlugin } from '../types.ts';
import { specOf, str } from '../util.ts';

/** upstream: helper.DefaultNormalizeScore. */
export function defaultNormalizeScore(maxPriority: number, reverse: boolean, scores: { score: number }[]): void {
  let max = 0;
  for (const s of scores) if (s.score > max) max = s.score;
  if (max === 0) {
    if (reverse) for (const s of scores) s.score = maxPriority;
    return;
  }
  for (const s of scores) {
    let v = Math.trunc((maxPriority * s.score) / max);
    if (reverse) v = maxPriority - v;
    s.score = v;
  }
}

export const taintTolerationScore: ScorePlugin = {
  name: 'TaintToleration',
  weight: 3,
  score(_state, pod, node) {
    const tolerations = tolerationsOf(pod).filter((t) => str(t.effect) === '' || str(t.effect) === 'PreferNoSchedule');
    return taintsOf(node.node).filter((t) => t.effect === 'PreferNoSchedule' && !tolerations.some((x) => toleratesTaint(x, t))).length;
  },
  normalize(_state, _pod, scores) {
    defaultNormalizeScore(MAX_NODE_SCORE, true, scores);
  },
};

export const nodeAffinityScore: ScorePlugin = {
  name: 'NodeAffinity',
  weight: 2,
  preScore(_state, pod) {
    return hasPreferredNodeAffinity(pod) ? SUCCESS : status('Skip');
  },
  score(_state, pod, node) {
    return preferredAffinityScore(pod, node.node);
  },
  normalize(_state, _pod, scores) {
    defaultNormalizeScore(MAX_NODE_SCORE, false, scores);
  },
};

const RESOURCES = ['cpu', 'memory'] as const;

/** upstream: resourceAllocationScorer.calculateNodeAllocatableRequest for cpu and memory. */
function allocation(node: NodeInfo, podReq: Record<string, number>, useRequested: boolean): { requested: number[]; allocated: number[]; allocatable: number[] } {
  const used = useRequested ? node.requested : node.nonZeroRequested;
  const requested: number[] = [];
  const allocated: number[] = [];
  const allocatable: number[] = [];
  for (const r of RESOURCES) {
    const a = node.allocatable[r] ?? 0;
    if (a === 0) {
      requested.push(0);
      allocated.push(0);
      allocatable.push(0);
      continue;
    }
    const u = used[r] ?? 0;
    allocatable.push(a);
    allocated.push(u);
    requested.push(u + (podReq[r] ?? 0));
  }
  return { requested, allocated, allocatable };
}

/** upstream: leastRequestedScore. */
function leastRequestedScore(requested: number, capacity: number): number {
  if (capacity === 0 || requested > capacity) return 0;
  return Math.trunc(((capacity - requested) * MAX_NODE_SCORE) / capacity);
}

export const nodeResourcesFitScore: ScorePlugin = {
  name: 'NodeResourcesFit',
  weight: 1,
  score(_state, pod, node) {
    const { requested, allocatable } = allocation(node, podNonZeroRequests(pod), false);
    let score = 0;
    let weights = 0;
    requested.forEach((r, i) => {
      const a = allocatable[i] as number;
      if (a === 0) return;
      score += leastRequestedScore(r, a);
      weights += 1;
    });
    return weights === 0 ? 0 : Math.trunc(score / weights);
  },
};

/** upstream: balancedResourceScore (float64 arithmetic, truncated). */
function balancedResourceScore(requested: number[], allocatable: number[]): number {
  const fractions: number[] = [];
  requested.forEach((r, i) => {
    const a = allocatable[i] as number;
    if (a === 0) return;
    fractions.push(Math.min(r / a, 1));
  });
  let std = 0;
  if (fractions.length === 2) std = Math.abs(((fractions[0] as number) - (fractions[1] as number)) / 2);
  else if (fractions.length > 2) {
    const mean = fractions.reduce((x, y) => x + y, 0) / fractions.length;
    std = Math.sqrt(fractions.reduce((s, f) => s + (f - mean) * (f - mean), 0) / fractions.length);
  }
  return Math.trunc((1 - std) * MAX_NODE_SCORE);
}

export const balancedAllocationScore: ScorePlugin = {
  name: 'NodeResourcesBalancedAllocation',
  weight: 1,
  preScore(_state, pod) {
    const r = podRequests(pod);
    return RESOURCES.every((k) => (r[k] ?? 0) === 0) ? status('Skip') : SUCCESS;
  },
  score(_state, pod, node) {
    const { requested, allocated, allocatable } = allocation(node, podRequests(pod), true);
    const withPod = balancedResourceScore(requested, allocatable);
    const without = balancedResourceScore(allocated, allocatable);
    return MAX_NODE_SCORE / 2 + Math.trunc((MAX_NODE_SCORE / 2 + withPod - without) / 2);
  },
};

const MB = 1024 * 1024;
const MIN_THRESHOLD = 23 * MB;
const MAX_CONTAINER_THRESHOLD = 1000 * MB;

/** upstream: normalizedImageName. */
export function normalizedImageName(name: string): string {
  return name.lastIndexOf(':') <= name.lastIndexOf('/') ? `${name}:latest` : name;
}

const IMAGES_KEY = 'ImageLocalityNodes';

export const imageLocalityScore: ScorePlugin = {
  name: 'ImageLocality',
  weight: 1,
  preScore(state, _pod, nodes) {
    // The plugin reads every node of the snapshot, not only the feasible ones; the framework hands
    // PreScore the feasible nodes, so the scheduler stores the full list here first.
    state[IMAGES_KEY] ??= nodes;
    return SUCCESS;
  },
  score(state, pod, node) {
    const all = (state.allNodes ?? state[IMAGES_KEY] ?? [node]) as NodeInfo[];
    const spec = specOf(pod);
    const images = [...arr(spec.initContainers), ...arr(spec.containers)].map((c) => normalizedImageName(str(c.image)));
    let count = images.length;
    let sum = 0;
    const scaled = (name: string): number => {
      const size = node.images[name];
      if (size === undefined) return 0;
      const numNodes = all.filter((n) => n.images[name] !== undefined).length;
      return Math.trunc(size * (numNodes / all.length));
    };
    for (const i of images) sum += scaled(i);
    for (const v of arr(spec.volumes)) {
      const img = v.image;
      if (img === undefined || img === null || typeof img !== 'object' || Array.isArray(img)) continue;
      sum += scaled(normalizedImageName(str(img.reference)));
      count++;
    }
    const maxThreshold = MAX_CONTAINER_THRESHOLD * count;
    if (sum < MIN_THRESHOLD) sum = MIN_THRESHOLD;
    else if (sum > maxThreshold) sum = maxThreshold;
    return Math.trunc((MAX_NODE_SCORE * (sum - MIN_THRESHOLD)) / (maxThreshold - MIN_THRESHOLD));
  },
};

/** The score plugins in the default profile's order, with their default weights. */
export const SCORES: readonly ScorePlugin[] = [taintTolerationScore, nodeAffinityScore, nodeResourcesFitScore, balancedAllocationScore, imageLocalityScore];

export type { ApiObject };
