// The verbs of this group (phase 08: version, api-resources, api-versions, cluster-info) and the provenance of their output units
// (docs/FIDELITY.md §3). kubectl.ts registers the verbs; packages/k8s/src/provenance.ts gathers
// the provenance.

import type { ProvenanceSpec } from '@simlab/kernel';
import type { Verb } from '../../cli/command.ts';
import { apiResourcesVerb, apiVersionsVerb } from './apiresources.ts';
import { clusterInfoVerb } from './clusterinfo.ts';
import { INFO_UNITS } from './provenance.ts';
import { versionVerb } from './version.ts';

export const INFO_VERBS: Verb[] = [versionVerb, apiResourcesVerb, apiVersionsVerb, clusterInfoVerb];

export const INFO_PROVENANCE: ProvenanceSpec[] = INFO_UNITS;
