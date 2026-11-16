// The verbs of this group (phase 08: logs) and the provenance of their output units
// (docs/FIDELITY.md §3). kubectl.ts registers the verbs; packages/k8s/src/provenance.ts gathers
// the provenance.

import type { ProvenanceSpec } from '@simlab/kernel';
import type { Verb } from '../../cli/command.ts';
import { logsVerb } from './logs.ts';
import { LOGS_UNITS } from './provenance.ts';

export const LOGS_VERBS: Verb[] = [logsVerb];

export const LOGS_PROVENANCE: ProvenanceSpec[] = LOGS_UNITS;
