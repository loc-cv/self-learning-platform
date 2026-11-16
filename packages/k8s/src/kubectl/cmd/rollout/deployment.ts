// kubectl's deployment helpers: a Deployment's ReplicaSets and revisions, and the pod template as
// `rollout history --revision` and `rollout undo --dry-run=client` print it.
//   upstream: staging/src/k8s.io/kubectl/pkg/util/deployment/deployment.go Revision,
//             GetAllReplicaSets, listReplicaSets (the Deployment's selector, controlled by it),
//             findNewReplicaSet, findOldReplicaSets, equalIgnoreHash, GetDeploymentCondition
//             (the same algorithms as the controller's copy, packages/k8s/src/controllers/deployment)
//   upstream: staging/src/k8s.io/kubectl/pkg/polymorphichelpers/history.go
//             getDeploymentReplicaSets, printTemplate (describe.NewPrefixWriter, no tab writer)
//   upstream: .upstream/go src/strconv/atoi.go ParseInt (base 10, bitSize 64), NumError.Error

import type { Op } from '@simlab/host';
import { isObject, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import { isSelectorError, labelSelectorAsSelector, selectorString } from '../../../apimachinery/labels.ts';
import { equalIgnoreHash, findNewReplicaSet } from '../../../controllers/deployment/util.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import { request, type Session } from '../../client/session.ts';
import { describePodTemplate } from '../../describe/pod.ts';
import { prefixString } from '../../describe/writer.ts';
import { errorMessage } from '../../cli/errors.ts';

export { equalIgnoreHash };

export const REVISION_ANNOTATION = 'deployment.kubernetes.io/revision';
export const CHANGE_CAUSE_ANNOTATION = 'kubernetes.io/change-cause';
export const TIMED_OUT_REASON = 'ProgressDeadlineExceeded';

const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;

export const meta = (o: JsonObject): JsonObject => (isObject(o.metadata) ? o.metadata : {});
export const spec = (o: JsonObject): JsonObject => (isObject(o.spec) ? o.spec : {});
export const status = (o: JsonObject): JsonObject => (isObject(o.status) ? o.status : {});
export const annotations = (o: JsonObject): Record<string, string> => {
  const a = meta(o).annotations;
  const out: Record<string, string> = {};
  if (isObject(a)) for (const [k, v] of Object.entries(a)) if (typeof v === 'string') out[k] = v;
  return out;
};
const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');

/** strconv.ParseInt(s, 10, 64) as a bigint, or the NumError text. */
export function parseInt64(s: string): { value: bigint } | { error: string } {
  const quoted = JSON.stringify(s);
  if (!/^[+-]?[0-9]+$/.test(s)) return { error: `strconv.ParseInt: parsing ${quoted}: invalid syntax` };
  const v = BigInt(s);
  if (v > INT64_MAX || v < INT64_MIN) return { error: `strconv.ParseInt: parsing ${quoted}: value out of range` };
  return { value: v };
}

/** deploymentutil.Revision: the revision annotation (0 when absent), or the parse error. */
export function revisionOf(o: JsonObject): { value: bigint } | { error: string } {
  const a = annotations(o);
  if (!(REVISION_ANNOTATION in a)) return { value: 0n };
  return parseInt64(a[REVISION_ANNOTATION] as string);
}

/** GetDeploymentCondition */
export function conditionOf(d: JsonObject, type: string): JsonObject | undefined {
  const conds = status(d).conditions;
  if (!Array.isArray(conds)) return undefined;
  return conds.find((c): c is JsonObject => isObject(c) && c.type === type);
}

/** The error of a request kubectl's typed client sent: what %v prints of it. */
function requestError(e: KubectlError): string {
  return e.type === 'status' ? (e.status.message ?? '') : errorMessage(e).text.replace(/^error: /, '').replace(/\n$/, '');
}

export interface ReplicaSets {
  /** allOldRSs: every old ReplicaSet, oldest first. */
  allOld: JsonObject[];
  newRS: JsonObject | undefined;
}

/** GetAllReplicaSets: the Deployment's ReplicaSets, or the error text of the list. */
export function* allReplicaSets(s: Session, d: JsonObject): Op<ReplicaSets | { error: string }> {
  const md = meta(d);
  const sel = labelSelectorAsSelector(spec(d).selector);
  if (isSelectorError(sel)) return { error: sel.error };
  const r = yield* request(s, { verb: 'list', group: 'apps', version: 'v1', resource: 'replicasets', namespace: str(md.namespace), options: { labelSelector: selectorString(sel) } });
  if (!r.ok) {
    if ('notSimulated' in r) throw new Error(`replicasets are stored: ${r.notSimulated}`);
    // rsListFromClient: EnhanceListError(err, opts, "replicasets") names a BadRequest or NotFound.
    const reason = r.status.reason;
    if (reason !== 'BadRequest' && reason !== 'NotFound') return { error: r.status.message ?? '' };
    return { error: `Unable to find "replicasets" that match label selector "${selectorString(sel)}", field selector "": ${r.status.message ?? ''}` };
  }
  const items = ((r.object as JsonObject).items as JsonObject[] | undefined) ?? [];
  const uid = md.uid;
  const owned = items
    .filter((rs) => {
      const refs = meta(rs).ownerReferences;
      return Array.isArray(refs) && refs.some((ref) => isObject(ref) && ref.controller === true && ref.uid === uid);
    })
    .map((rs) => ({ apiVersion: 'apps/v1', kind: 'ReplicaSet', ...rs }));
  // findNewReplicaSet sorts the list in place by creation time, then name.
  const newRS = findNewReplicaSet(d, owned);
  const allOld = owned.filter((rs) => !newRS || meta(rs).uid !== meta(newRS).uid);
  return { allOld, newRS };
}

/** getDeploymentReplicaSets: the Deployment, then its ReplicaSets (old ones first). */
export function* deploymentReplicaSets(s: Session, namespace: string, name: string): Op<{ deployment: JsonObject; replicaSets: JsonObject[] } | { error: KubectlError }> {
  const got = yield* request(s, { verb: 'get', group: 'apps', version: 'v1', resource: 'deployments', namespace, name });
  if (!got.ok) {
    if ('notSimulated' in got) throw new Error(`deployments are stored: ${got.notSimulated}`);
    return { error: messageError(`failed to retrieve deployment ${name}: ${requestError({ type: 'status', status: got.status })}`) };
  }
  const d = got.object as JsonObject;
  const all = yield* allReplicaSets(s, d);
  if ('error' in all) return { error: messageError(`failed to retrieve replica sets from deployment ${name}: ${all.error}`) };
  return { deployment: d, replicaSets: all.newRS ? [...all.allOld, all.newRS] : all.allOld };
}

/** printTemplate: DescribePodTemplate through a prefix writer without a tab writer. */
export function printTemplate(template: Json | undefined): string {
  return prefixString((w) => describePodTemplate(template, w));
}
