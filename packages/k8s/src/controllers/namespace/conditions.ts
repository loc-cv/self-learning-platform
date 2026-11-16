// Namespace deletion conditions. upstream: pkg/controller/namespace/deletion/status_condition_utils.go
// (namespaceConditionUpdater, conditionTypes, okMessages, okReasons, updateConditions).

import { cloneJson, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { timeOf } from '../../apimachinery/time.ts';
import type { Millis } from '@simlab/kernel';

export interface NamespaceCondition {
  type: string;
  status: 'True' | 'False';
  lastTransitionTime: string;
  reason: string;
  message: string;
}

/** The condition types the deleter maintains, in order. */
export const CONDITION_TYPES = [
  'NamespaceDeletionDiscoveryFailure',
  'NamespaceDeletionGroupVersionParsingFailure',
  'NamespaceDeletionContentFailure',
  'NamespaceContentRemaining',
  'NamespaceFinalizersRemaining',
] as const;

const OK_MESSAGES: Record<string, string> = {
  NamespaceDeletionDiscoveryFailure: 'All resources successfully discovered',
  NamespaceDeletionGroupVersionParsingFailure: 'All legacy kube types successfully parsed',
  NamespaceDeletionContentFailure: 'All content successfully deleted, may be waiting on finalization',
  NamespaceContentRemaining: 'All content successfully removed',
  NamespaceFinalizersRemaining: 'All content-preserving finalizers finished',
};

const OK_REASONS: Record<string, string> = {
  NamespaceDeletionDiscoveryFailure: 'ResourcesDiscovered',
  NamespaceDeletionGroupVersionParsingFailure: 'ParsedGroupVersions',
  NamespaceDeletionContentFailure: 'ContentDeleted',
  NamespaceContentRemaining: 'ContentRemoved',
  NamespaceFinalizersRemaining: 'ContentHasNoFinalizers',
};

/** Totals of deleteAllContent: remaining instances per `resource.group`, and per finalizer. */
export interface ContentTotals {
  /** `configmaps.` (Resource.Group) → count. */
  gvrToNumRemaining: Map<string, number>;
  finalizersToNumRemaining: Map<string, number>;
}

/**
 * namespaceConditionUpdater. Discovery and group version parsing cannot fail in the simulator (the
 * registry is static data), so ProcessDiscoverResourcesErr and ProcessGroupVersionErr are not
 * ported: those two conditions always take their ok variant.
 */
export interface ConditionUpdater {
  newConditions: NamespaceCondition[];
  deleteContentErrors: string[];
  now: Millis;
}

export function newConditionUpdater(now: Millis): ConditionUpdater {
  return { newConditions: [], deleteContentErrors: [], now };
}

export function processDeleteContentErr(u: ConditionUpdater, err: string): void {
  u.deleteContentErrors.push(err);
}

/** ProcessContentTotals. Each list is sorted for stable updates, as upstream does. */
export function processContentTotals(u: ConditionUpdater, totals: ContentTotals): void {
  const t = timeOf(u.now);
  if (totals.gvrToNumRemaining.size !== 0) {
    const remaining: string[] = [];
    for (const [gr, n] of totals.gvrToNumRemaining) if (n !== 0) remaining.push(`${gr} has ${n} resource instances`);
    remaining.sort(goLess);
    u.newConditions.push({ type: 'NamespaceContentRemaining', status: 'True', lastTransitionTime: t, reason: 'SomeResourcesRemain', message: `Some resources are remaining: ${remaining.join(', ')}` });
  }
  if (totals.finalizersToNumRemaining.size !== 0) {
    const byFinalizer: string[] = [];
    for (const [f, n] of totals.finalizersToNumRemaining) if (n !== 0) byFinalizer.push(`${f} in ${n} resource instances`);
    byFinalizer.sort(goLess);
    u.newConditions.push({
      type: 'NamespaceFinalizersRemaining',
      status: 'True',
      lastTransitionTime: t,
      reason: 'SomeFinalizersRemain',
      message: `Some content in the namespace has finalizers remaining: ${byFinalizer.join(', ')}`,
    });
  }
}

/** sort.Strings: byte-wise order. */
function goLess(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Update: adds the content failure condition from the collected errors, then updateConditions on
 * a copy of the namespace's status. Returns the new status when something changed.
 */
export function updateConditions(u: ConditionUpdater, status: JsonObject): JsonObject | undefined {
  const t = timeOf(u.now);
  const fresh = [...u.newConditions];
  if (!fresh.some((c) => c.type === 'NamespaceDeletionContentFailure') && u.deleteContentErrors.length > 0) {
    const msgs = [...u.deleteContentErrors].sort(goLess);
    fresh.push({
      type: 'NamespaceDeletionContentFailure',
      status: 'True',
      lastTransitionTime: t,
      reason: 'ContentDeletionFailed',
      message: `Failed to delete all resource types, ${msgs.length} remaining: ${msgs.join(', ')}`,
    });
  }
  const next = cloneJson(status);
  const conditions = (Array.isArray(next.conditions) ? next.conditions : []) as JsonObject[];
  let changed = false;
  for (const type of CONDITION_TYPES) {
    const want = fresh.find((c) => c.type === type) ?? { type, status: 'False', lastTransitionTime: t, reason: OK_REASONS[type] as string, message: OK_MESSAGES[type] as string };
    const old = conditions.find((c) => c.type === type);
    if (!old) {
      conditions.push({ ...want } as unknown as JsonObject);
      changed = true;
    } else if (old.status !== want.status || old.message !== want.message || old.reason !== want.reason) {
      if (old.status !== want.status) old.lastTransitionTime = t;
      old.type = want.type;
      old.status = want.status;
      old.reason = want.reason;
      old.message = want.message;
      changed = true;
    }
  }
  if (!changed) return undefined;
  next.conditions = conditions as unknown as Json;
  return next;
}
