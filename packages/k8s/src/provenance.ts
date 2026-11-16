// Every output unit of the Kubernetes plugin with its provenance (docs/FIDELITY.md §3), gathered
// from the lists next to the code that renders each unit. Contributed as `provenance`.

import type { ProvenanceSpec } from '@simlab/kernel';
import { KUBECTL_PROVENANCE } from './kubectl/provenance.ts';
import { HELP_PROVENANCE } from './kubectl/help/provenance.ts';
import { TABLE_PROVENANCE } from './printers/provenance.ts';
import { YAML_JSON_PROVENANCE } from './apimachinery/yaml/provenance.ts';
import { APISERVER_PROVENANCE } from './apiserver/provenance.ts';
import { STRATEGIC_PATCH_PROVENANCE } from './apimachinery/strategicpatch/provenance.ts';
import { DESCRIBE_PROVENANCE } from './kubectl/describe/provenance.ts';
import { APPLY_PROVENANCE } from './kubectl/cmd/apply.provenance.ts';
import { DELETE_PROVENANCE } from './kubectl/cmd/delete.provenance.ts';
import { GENERATE_PROVENANCE } from './kubectl/cmd/generate/index.ts';
import { CHANGE_PROVENANCE } from './kubectl/cmd/change/index.ts';
import { ROLLOUT_PROVENANCE } from './kubectl/cmd/rollout/index.ts';
import { LOGS_PROVENANCE } from './kubectl/cmd/logs/index.ts';
import { EXPLAIN_PROVENANCE } from './kubectl/cmd/explain/index.ts';
import { INFO_PROVENANCE } from './kubectl/cmd/info/index.ts';
import { CONFIG_PROVENANCE } from './kubectl/cmd/config/index.ts';
import { COMPLETION_PROVENANCE } from './kubectl/completion/index.ts';
import { VIEW_PROVENANCE } from './view/provider.ts';

export const K8S_PROVENANCE: readonly ProvenanceSpec[] = [...KUBECTL_PROVENANCE, ...HELP_PROVENANCE, ...TABLE_PROVENANCE, ...YAML_JSON_PROVENANCE, ...APISERVER_PROVENANCE, ...STRATEGIC_PATCH_PROVENANCE,
  ...DESCRIBE_PROVENANCE,
  ...APPLY_PROVENANCE,
  ...DELETE_PROVENANCE,
  ...GENERATE_PROVENANCE,
  ...CHANGE_PROVENANCE,
  ...ROLLOUT_PROVENANCE,
  ...LOGS_PROVENANCE,
  ...EXPLAIN_PROVENANCE,
  ...INFO_PROVENANCE,
  ...CONFIG_PROVENANCE,
  ...COMPLETION_PROVENANCE,
  ...VIEW_PROVENANCE,
];
