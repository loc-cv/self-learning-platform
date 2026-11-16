// Taint, toleration and node affinity matching as the scheduler uses it.
//
// upstream: staging/src/k8s.io/api/core/v1/toleration.go ToleratesTaint (the Lt/Gt operators of
// the alpha gate TaintTolerationComparisonOperators, off by default, never match);
// staging/src/k8s.io/component-helpers/scheduling/corev1/helpers.go TolerationsTolerateTaint,
// FindMatchingUntoleratedTaint; pkg/scheduler/framework/plugins/helper/taint.go
// DoNotScheduleTaintsFilterFunc; component-helpers/scheduling/corev1/nodeaffinity/nodeaffinity.go
// (RequiredNodeAffinity, LazyErrorNodeSelector, PreferredSchedulingTerms, nodeSelectorTerm.match).

import type { Json, JsonObject } from '../apimachinery/json.ts';
import { isObject } from '../apimachinery/json.ts';
import { isSelectorError, newRequirement, nothing, selectorAdd, selectorFromSet, selectorMatches, everything, type Selector } from '../apimachinery/labels.ts';
import type { ApiObject } from '../apiserver/store.ts';
import { arr } from './resources.ts';
import { labelsOf, nameOf, specOf, str } from './util.ts';

export interface Taint {
  key: string;
  value: string;
  effect: string;
}

export function taintsOf(node: ApiObject): Taint[] {
  return arr(specOf(node).taints).map((t) => ({ key: str(t.key), value: str(t.value), effect: str(t.effect) }));
}

export function tolerationsOf(pod: ApiObject): JsonObject[] {
  return arr(specOf(pod).tolerations);
}

export function toleratesTaint(t: JsonObject, taint: Taint): boolean {
  const effect = str(t.effect);
  if (effect !== '' && effect !== taint.effect) return false;
  const key = str(t.key);
  if (key !== '' && key !== taint.key) return false;
  switch (str(t.operator)) {
    case '':
    case 'Equal':
      return str(t.value) === taint.value;
    case 'Exists':
      return true;
    default:
      return false;
  }
}

export function tolerationsTolerateTaint(tolerations: JsonObject[], taint: Taint): boolean {
  return tolerations.some((t) => toleratesTaint(t, taint));
}

/** The first NoSchedule or NoExecute taint no toleration tolerates. */
export function findUntoleratedTaint(taints: Taint[], tolerations: JsonObject[]): Taint | undefined {
  return taints.find((t) => (t.effect === 'NoSchedule' || t.effect === 'NoExecute') && !tolerationsTolerateTaint(tolerations, t));
}

// ---- node affinity ----

const OPS: Record<string, string> = { In: 'in', NotIn: 'notin', Exists: 'exists', DoesNotExist: '!', Gt: 'gt', Lt: 'lt' };

interface Term {
  labels?: Selector;
  /** metadata.name requirements: [In|NotIn, value]. */
  fields?: { op: 'In' | 'NotIn'; value: string }[];
  /** Nothing (an empty requirement list). */
  fieldsNothing?: true;
  error?: true;
}

function parseTerm(term: JsonObject): Term {
  const out: Term = {};
  const exprs = arr(term.matchExpressions);
  if (exprs.length > 0) {
    let sel = everything();
    for (const e of exprs) {
      const op = OPS[str(e.operator)];
      if (!op) return { error: true };
      const values = Array.isArray(e.values) ? e.values.filter((v): v is string => typeof v === 'string') : [];
      const r = newRequirement(str(e.key), op, values);
      if ('error' in r) return { error: true };
      sel = selectorAdd(sel, r);
    }
    out.labels = sel;
  }
  const fields = arr(term.matchFields);
  if (fields.length > 0) {
    const fs: { op: 'In' | 'NotIn'; value: string }[] = [];
    for (const f of fields) {
      const op = str(f.operator);
      const values = Array.isArray(f.values) ? f.values : [];
      if ((op !== 'In' && op !== 'NotIn') || values.length !== 1 || str(f.key) !== 'metadata.name') {
        // A key other than metadata.name parses but can never match a node's fields.
        if ((op === 'In' || op === 'NotIn') && values.length === 1) {
          fs.push({ op, value: `\u0000${str(f.key)}=${str(values[0] as Json)}` });
          continue;
        }
        return { error: true };
      }
      fs.push({ op, value: str(values[0] as Json) });
    }
    out.fields = fs;
  }
  return out;
}

function termMatches(t: Term, node: ApiObject): boolean {
  if (t.error) return false;
  // An empty term (neither list) matches nothing: nodeSelectorRequirementsAsSelector(nil) is
  // labels.Nothing().
  if (!t.labels && !t.fields) return selectorMatches(nothing(), labelsOf(node));
  if (t.labels && !selectorMatches(t.labels, labelsOf(node))) return false;
  if (t.fields) {
    const name = nameOf(node);
    for (const f of t.fields) {
      const eq = f.value === name;
      if (f.op === 'In' ? !eq : eq) return false;
    }
  }
  return true;
}

function requiredTerms(pod: ApiObject): JsonObject[] | undefined {
  const aff = specOf(pod).affinity;
  const na = isObject(aff) && isObject(aff.nodeAffinity) ? aff.nodeAffinity : undefined;
  const req = na && isObject(na.requiredDuringSchedulingIgnoredDuringExecution) ? na.requiredDuringSchedulingIgnoredDuringExecution : undefined;
  return req ? arr(req.nodeSelectorTerms) : undefined;
}

export function hasRequiredNodeAffinity(pod: ApiObject): boolean {
  return requiredTerms(pod) !== undefined;
}

export function requiredNodeAffinityTerms(pod: ApiObject): JsonObject[] | undefined {
  return requiredTerms(pod);
}

/** upstream: RequiredNodeAffinity.Match (nodeSelector, then the required terms ORed). */
export function matchesRequiredNodeAffinity(pod: ApiObject, node: ApiObject): boolean {
  const ns = specOf(pod).nodeSelector;
  if (isObject(ns) && Object.keys(ns).length > 0) {
    const set: Record<string, string> = {};
    for (const k of Object.keys(ns)) set[k] = str(ns[k]);
    const sel = selectorFromSet(set);
    if (isSelectorError(sel) || !selectorMatches(sel, labelsOf(node))) return false;
  }
  const terms = requiredTerms(pod);
  if (terms === undefined) return true;
  return terms.some((t) => termMatches(parseTerm(t), node));
}

/** upstream: PreferredSchedulingTerms.Score: the sum of the weights of matching terms. */
export function preferredAffinityScore(pod: ApiObject, node: ApiObject): number {
  const aff = specOf(pod).affinity;
  const na = isObject(aff) && isObject(aff.nodeAffinity) ? aff.nodeAffinity : undefined;
  let score = 0;
  for (const p of arr(na?.preferredDuringSchedulingIgnoredDuringExecution)) {
    const weight = typeof p.weight === 'number' ? p.weight : 0;
    const pref = isObject(p.preference) ? p.preference : {};
    if (weight === 0 || (arr(pref.matchExpressions).length === 0 && arr(pref.matchFields).length === 0)) continue;
    if (termMatches(parseTerm(pref), node)) score += weight;
  }
  return score;
}

export function hasPreferredNodeAffinity(pod: ApiObject): boolean {
  const aff = specOf(pod).affinity;
  const na = isObject(aff) && isObject(aff.nodeAffinity) ? aff.nodeAffinity : undefined;
  return na !== undefined && Array.isArray(na.preferredDuringSchedulingIgnoredDuringExecution);
}
