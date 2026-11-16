// The Kubernetes plugin's checks (docs/SCENARIO_FORMAT.md §7.1), registered under kind `check`.

import type { CheckSpec } from '@simlab/kernel';
import { endpointsCheck } from './endpoints.ts';
import { nodeHasTaintCheck } from './nodetaint.ts';
import { notRecreatedCheck } from './notrecreated.ts';
import { objectCheck } from './object.ts';
import { podsReadyCheck } from './podsready.ts';
import { rolloutCheck } from './rollout.ts';
import { unchangedCheck } from './unchanged.ts';

export const K8S_CHECKS: readonly CheckSpec[] = [objectCheck, podsReadyCheck, rolloutCheck, endpointsCheck, nodeHasTaintCheck, unchangedCheck, notRecreatedCheck];
