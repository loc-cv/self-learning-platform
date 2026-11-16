// The verbs of this group (phase 08: explain) and the provenance of their output units
// (docs/FIDELITY.md §3). kubectl.ts registers the verbs; packages/k8s/src/provenance.ts gathers
// the provenance.

import type { ProvenanceSpec } from '@simlab/kernel';
import type { Verb } from '../../cli/command.ts';
import { explainVerb } from './explain.ts';
import { EXPLAIN_OUTPUT_PROVENANCE } from './explain.provenance.ts';

export const EXPLAIN_VERBS: Verb[] = [explainVerb];

export const EXPLAIN_PROVENANCE: ProvenanceSpec[] = EXPLAIN_OUTPUT_PROVENANCE;
