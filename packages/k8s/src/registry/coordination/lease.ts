// Lease. upstream: pkg/registry/coordination/lease/strategy.go (namespaced, no status; create
// on update allowed, unconditional update NOT allowed: a PUT without resourceVersion is
// Invalid, which the pipeline does from allowUnconditionalUpdate; PrepareForCreate and
// PrepareForUpdate drop spec.strategy and spec.preferredHolder while the
// CoordinatedLeaderElection gate is off, as it is in v1.37.2),
// pkg/registry/coordination/lease/storage/storage.go (Status on delete). No field label
// conversion is registered for Lease: metadata.name and metadata.namespace only.

import { isObject, type JsonObject } from '../../apimachinery/json.ts';
import { validateLease, validateLeaseUpdate } from '../../apis/coordination/validation/lease.ts';
import type { Strategy } from '../../apiserver/types.ts';
import { defaultFieldLabel, objectMetaFields } from '../meta.ts';

/** pkg/features CoordinatedLeaderElection: beta, off by default. */
const COORDINATED_LEADER_ELECTION = false;

function dropDisabled(obj: JsonObject, old: JsonObject | undefined): void {
  if (COORDINATED_LEADER_ELECTION || !isObject(obj.spec)) return;
  const oldSpec = old && isObject(old.spec) ? old.spec : {};
  if (oldSpec.strategy === undefined) delete obj.spec.strategy;
  if (oldSpec.preferredHolder === undefined) delete obj.spec.preferredHolder;
}

export const leaseStrategy: Strategy = {
  group: 'coordination.k8s.io',
  resource: 'leases',
  kind: 'Lease',
  storage: 'leases.coordination.k8s.io',
  storageVersion: 'v1',
  prepareForCreate: (obj) => dropDisabled(obj, undefined),
  prepareForUpdate: (obj, old) => dropDisabled(obj, old),
  validate: (obj) => validateLease(obj),
  validateUpdate: (obj, old) => validateLeaseUpdate(obj, old),
  allowCreateOnUpdate: true,
  allowUnconditionalUpdate: false,
  fields: (o) => objectMetaFields(o, true),
  convertFieldLabel: defaultFieldLabel,
};
