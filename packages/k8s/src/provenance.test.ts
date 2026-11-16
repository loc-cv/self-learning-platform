// The provenance registry (docs/FIDELITY.md §3): valid, contributed by the plugin, and covering
// every unit the code renders — each simulated kubectl verb, each served kind's table printer.

import { describe, expect, test } from 'vitest';
import { createRegistry, PROVENANCE, validateProvenance, type ProvenanceSpec } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from './plugin.ts';
import { K8S_PROVENANCE } from './provenance.ts';
import { VERBS } from './kubectl/kubectl.ts';
import { STRATEGIES } from './registry/index.ts';

describe('provenance', () => {
  test('is valid: no unit twice, every unit sourced, approximate ones linked to the register', () => {
    expect(validateProvenance(K8S_PROVENANCE)).toEqual([]);
  });
  test('is what the plugin contributes', () => {
    const units = createRegistry([hostPlugin, k8sPlugin]).list<ProvenanceSpec>(PROVENANCE).map((e) => e.name);
    expect(units).toEqual([...K8S_PROVENANCE].map((e) => e.name).sort());
  });
  test('every simulated kubectl verb has units', () => {
    const names = K8S_PROVENANCE.map((e) => e.name);
    for (const v of VERBS) expect(names.some((n) => n.startsWith(`kubectl.${v.path.replace(/ /g, '.')}.`)), v.path).toBe(true);
  });
  test('every served resource has a table printer unit', () => {
    const names = new Set(K8S_PROVENANCE.map((e) => e.name));
    const missing = STRATEGIES.filter((st) => !names.has(`kubectl.get.${st.resource}.table`)).map((st) => `${st.group}/${st.resource}`);
    // Resources printed by another kind's printer register under that kind (events.k8s.io Events print as core Events).
    expect(missing.filter((m) => m !== 'events.k8s.io/events')).toEqual([]);
  });
});
