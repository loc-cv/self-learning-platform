// Which kinds the rollout helpers know, and the notice for those whose controllers the simulator
// does not run yet.
//   upstream: staging/src/k8s.io/kubectl/pkg/apps/kind_visitor.go GroupKindElement.Accept,
//             GroupMatch (the kinds a history viewer or rollbacker is looked up for)

import type { Op, ProcApi } from '@simlab/host';
import type { Mapping } from '../../client/restmapper.ts';

const groupMatch = (m: Mapping, ...groups: string[]): boolean => groups.includes(m.group);

/** GroupKindElement.Accept: whether the kind has a visitor method. */
export function visitorAccepts(m: Mapping): boolean {
  switch (m.kind) {
    case 'DaemonSet':
    case 'Deployment':
    case 'ReplicaSet':
      return groupMatch(m, 'apps', 'extensions');
    case 'Job':
    case 'CronJob':
      return groupMatch(m, 'batch');
    case 'Pod':
    case 'ReplicationController':
      return groupMatch(m, '', 'core');
    case 'StatefulSet':
      return groupMatch(m, 'apps');
    default:
      return false;
  }
}

/**
 * DaemonSets and StatefulSets roll out through their controllers and ControllerRevisions, which
 * arrive in phase 18a: until then their rollouts print a notice instead of a status the
 * simulator could not keep true.
 */
export function* appsKindNotice(p: ProcApi, command: string, kind: string): Op<number> {
  return yield* p.unsupported({ kind: 'behavior', what: `${command} of a ${kind} (phase 18a)` });
}
