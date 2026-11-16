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

export const K8S_PROVENANCE: readonly ProvenanceSpec[] = [...KUBECTL_PROVENANCE, ...HELP_PROVENANCE, ...TABLE_PROVENANCE, ...YAML_JSON_PROVENANCE, ...APISERVER_PROVENANCE, ...STRATEGIC_PATCH_PROVENANCE,
  ...DESCRIBE_PROVENANCE,
  ...APPLY_PROVENANCE,
  ...DELETE_PROVENANCE,
];
