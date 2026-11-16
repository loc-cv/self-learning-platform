// Rollback through the `deprecated.deployment.rollback.to` annotation, which apps/v1 still honors:
// the Deployment takes the template of the ReplicaSet with that revision (0: the previous one).
// kubectl rollout undo no longer uses it; it copies the template itself.
//
// upstream: pkg/controller/deployment/rollback.go

import { isObject, type JsonObject } from '../../apimachinery/json.ts';
import type { ApiObject } from '../../apiserver/store.ts';
import { annotationsOf, apiError, nameOf, namespaceOf, specOf, type ApiError } from '../objects.ts';
import type { SyncCtx } from '../types.ts';
import { getAllReplicaSetsAndSyncRevision } from './sync.ts';
import {
  DEPRECATED_ROLLBACK_TO,
  ROLLBACK_DONE,
  ROLLBACK_REVISION_NOT_FOUND,
  ROLLBACK_TEMPLATE_UNCHANGED,
  deploymentBody,
  equalIgnoreHash,
  lastRevision,
  revisionOf,
  setDeploymentAnnotationsTo,
  setFromReplicaSetTemplate,
  type Deployment,
} from './util.ts';

/** rollback: rolls the Deployment back to the revision the annotation names. */
export function rollback(c: SyncCtx, d: Deployment, rsList: ApiObject[]): ApiError | undefined {
  const r = getAllReplicaSetsAndSyncRevision(c, d, rsList, true);
  if ('error' in r) return r.error;
  const allRSs = [...r.oldRSs, r.newRS];
  let rollbackRevision = getRollbackTo(d) as number;
  // If rollback revision is 0, rollback to the last revision
  if (rollbackRevision === 0) {
    rollbackRevision = lastRevision(allRSs);
    if (rollbackRevision === 0) {
      // If we still can't find the last revision, gives up rollback
      emitRollbackWarningEvent(c, d, ROLLBACK_REVISION_NOT_FOUND, 'Unable to find last revision.');
      // Gives up rollback
      return updateDeploymentAndClearRollbackTo(c, d);
    }
  }
  for (const rs of allRSs) {
    if (!rs) continue;
    const v = revisionOf(rs);
    if (v === undefined) continue;
    if (v === rollbackRevision) {
      // rollback by copying podTemplate.Spec from the replica set
      // revision number will be incremented during the next getAllReplicaSetsAndSyncRevision call
      // no-op if the spec matches current deployment's podTemplate.Spec
      const done = rollbackToTemplate(c, d, rs);
      if (done.performed && !done.error) {
        c.event(d.obj, 'Normal', ROLLBACK_DONE, `Rolled back deployment "${nameOf(d.obj)}" to revision ${rollbackRevision}`);
      }
      return done.error;
    }
  }
  emitRollbackWarningEvent(c, d, ROLLBACK_REVISION_NOT_FOUND, 'Unable to find the revision to rollback to.');
  // Gives up rollback
  return updateDeploymentAndClearRollbackTo(c, d);
}

/** rollbackToTemplate: takes the ReplicaSet's template and annotations unless the template is already the same. */
function rollbackToTemplate(c: SyncCtx, d: Deployment, rs: ApiObject): { performed: boolean; error?: ApiError } {
  let performed = false;
  if (!equalIgnoreHash(specOf(d.obj).template, specOf(rs).template)) {
    setFromReplicaSetTemplate(d, specOf(rs).template);
    // set RS (the old RS we'll rolling back to) annotations back to the deployment; otherwise, the
    // deployment's current annotations (should be the same as current new RS) will be copied to
    // the RS after the rollback.
    setDeploymentAnnotationsTo(d, rs);
    performed = true;
  } else {
    emitRollbackWarningEvent(c, d, ROLLBACK_TEMPLATE_UNCHANGED, `The rollback revision contains the same template as current deployment "${nameOf(d.obj)}"`);
  }
  const error = updateDeploymentAndClearRollbackTo(c, d);
  return error ? { performed, error } : { performed };
}

function emitRollbackWarningEvent(c: SyncCtx, d: Deployment, reason: string, message: string): void {
  c.event(d.obj, 'Warning', reason, message);
}

/**
 * updateDeploymentAndClearRollbackTo: removes the annotation and updates the Deployment (spec and
 * metadata; the status goes along and is ignored by the update).
 */
function updateDeploymentAndClearRollbackTo(c: SyncCtx, d: Deployment): ApiError | undefined {
  const m = d.obj.metadata as JsonObject;
  if (isObject(m.annotations)) delete m.annotations[DEPRECATED_ROLLBACK_TO];
  return apiError(c.client.resource('apps/v1/deployments').update(namespaceOf(d.obj), deploymentBody(d)));
}

/** getRollbackTo: the revision in the annotation; undefined when absent or not a number. */
export function getRollbackTo(d: Deployment): number | undefined {
  const revision = annotationsOf(d.obj)[DEPRECATED_ROLLBACK_TO] ?? '';
  if (revision === '' || !/^[+-]?[0-9]+$/.test(revision)) return undefined;
  const n = BigInt(revision);
  if (n > (1n << 63n) - 1n || n < -(1n << 63n)) return undefined;
  return Number(n);
}
