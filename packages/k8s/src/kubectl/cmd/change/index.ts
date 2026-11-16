// The verbs of this group (phase 08: scale, set image, label, annotate, edit) and the provenance of their output units
// (docs/FIDELITY.md §3). kubectl.ts registers the verbs; packages/k8s/src/provenance.ts gathers
// the provenance.

import type { ProvenanceSpec } from '@simlab/kernel';
import type { Verb } from '../../cli/command.ts';
import { scaleVerb } from './scale.ts';
import { setImageVerb } from './setimage.ts';
import { annotateVerb, labelVerb } from './labels.ts';
import { editVerb } from './edit.ts';
import { PROVENANCE } from './provenance.ts';

export const CHANGE_VERBS: Verb[] = [scaleVerb, setImageVerb, labelVerb, annotateVerb, editVerb];

export const CHANGE_PROVENANCE: ProvenanceSpec[] = PROVENANCE;
