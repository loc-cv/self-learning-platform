// The verbs of this group (phase 08: run, create deployment|namespace|serviceaccount|configmap|secret generic|service, expose) and the provenance of their output units
// (docs/FIDELITY.md §3). kubectl.ts registers the verbs; packages/k8s/src/provenance.ts gathers
// the provenance.

import type { ProvenanceSpec } from '@simlab/kernel';
import type { Verb } from '../../cli/command.ts';
import { exposeVerb } from './expose.ts';
import { GENERATE_UNITS } from './provenance.ts';
import { runVerb } from './run.ts';
import { createConfigMapVerb, createDeploymentVerb, createNamespaceVerb, createSecretGenericVerb, createServiceAccountVerb, createServiceVerbs } from './create.ts';

export const GENERATE_VERBS: Verb[] = [runVerb, exposeVerb, createDeploymentVerb, createNamespaceVerb, createServiceAccountVerb, createConfigMapVerb, createSecretGenericVerb, ...createServiceVerbs];

export const GENERATE_PROVENANCE: ProvenanceSpec[] = GENERATE_UNITS;
