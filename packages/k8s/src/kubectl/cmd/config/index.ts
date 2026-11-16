// The verbs of this group (phase 08: config view|get-contexts|use-context|set-context|current-context, and the
// get-clusters, get-users and delete-context that come with them) and the provenance of their
// output units (docs/FIDELITY.md §3). kubectl.ts registers the verbs; packages/k8s/src/provenance.ts
// gathers the provenance.

import type { ProvenanceSpec } from '@simlab/kernel';
import type { Verb } from '../../cli/command.ts';
import {
  configCurrentContextVerb,
  configDeleteContextVerb,
  configGetClustersVerb,
  configGetContextsVerb,
  configGetUsersVerb,
  configSetContextVerb,
  configUseContextVerb,
} from './contexts.ts';
import { CONFIG_UNITS } from './provenance.ts';
import { configViewVerb } from './view.ts';

export const CONFIG_VERBS: Verb[] = [
  configViewVerb,
  configGetContextsVerb,
  configCurrentContextVerb,
  configUseContextVerb,
  configSetContextVerb,
  configDeleteContextVerb,
  configGetClustersVerb,
  configGetUsersVerb,
];

export const CONFIG_PROVENANCE: ProvenanceSpec[] = CONFIG_UNITS;
