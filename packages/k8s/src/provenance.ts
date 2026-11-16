// Every output unit of the Kubernetes plugin with its provenance (docs/FIDELITY.md §3), gathered
// from the lists next to the code that renders each unit. Contributed as `provenance`.

import type { ProvenanceSpec } from '@simlab/kernel';
import { KUBECTL_PROVENANCE } from './kubectl/provenance.ts';
import { HELP_PROVENANCE } from './kubectl/help/provenance.ts';
import { TABLE_PROVENANCE } from './printers/provenance.ts';
import { YAML_JSON_PROVENANCE } from './apimachinery/yaml/provenance.ts';

export const K8S_PROVENANCE: readonly ProvenanceSpec[] = [...KUBECTL_PROVENANCE, ...HELP_PROVENANCE, ...TABLE_PROVENANCE, ...YAML_JSON_PROVENANCE];
