// The verbs of this group (phase 08: rollout status|history|undo|restart|pause|resume) and the provenance of their output units
// (docs/FIDELITY.md §3). kubectl.ts registers the verbs; packages/k8s/src/provenance.ts gathers
// the provenance.

import type { ProvenanceSpec } from '@simlab/kernel';
import type { Verb } from '../../cli/command.ts';
import { historyVerb } from './history.ts';
import { pauseVerb, restartVerb, resumeVerb } from './mutate.ts';
import { ROLLOUT_UNITS } from './provenance.ts';
import { statusVerb } from './status.ts';
import { undoVerb } from './undo.ts';

export const ROLLOUT_VERBS: Verb[] = [statusVerb, historyVerb, undoVerb, pauseVerb, resumeVerb, restartVerb];

export const ROLLOUT_PROVENANCE: ProvenanceSpec[] = ROLLOUT_UNITS;
