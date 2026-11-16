// Differential tests of the API server: every `request` step of the raw API fixtures
// (fixtures/golden/v1.37.2/api/) replayed through the simulator's request pipeline, the
// normalized response compared with what the real kube-apiserver v1.37.2 answered.
// Known differences are listed below with their reason; a listed step that starts matching
// fails too, so the list stays true.

import { describe, expect, test } from 'vitest';
import { loadFixture, runRequests, type StepResult } from './api.differential.ts';

/** `<case>#<step index>` → why the simulator answers differently. */
const KNOWN: Record<string, string> = {
  'api/defaults#19': 'admission plugins (phase 20b): TaintNodesByCondition adds the node.kubernetes.io/not-ready:NoSchedule taint to a new Node',
  'api/validation#52':
    'admission plugins (phase 20b): the old Pod has the ServiceAccount volume mount the patch drops, so the diff differs; and the unified diff of the internal PodSpec after the first line of the Forbidden message is not simulated (apis/core/validation/podspecdiff.ts)',
  'api/lifecycle#6':
    'timing: the real deployment controller wrote the revision annotation and the Progressing condition between two raw requests, at a wall-clock moment the fixture does not record; this differential replays requests without controllers (the controller behavior itself is compared in packages/k8s/src/controllers/deployment/golden.test.ts)',
};

/**
 * Steps whose Pods the real server's default admission plugins (phase 20b) mutated: ServiceAccount
 * (serviceAccountName, the kube-api-access-* volume and mount), DefaultTolerationSeconds (the
 * not-ready/unreachable tolerations) and Priority (priority, preemptionPolicy). These fields are
 * removed from both sides; everything else must match.
 */
const POD_ADMISSION = new Set([
  'api/defaults#20', 'api/defaults#21',
  'api/validation#1', 'api/validation#2', 'api/validation#3', 'api/validation#51', 'api/validation#55',
  'api/lifecycle#10', 'api/lifecycle#11', 'api/lifecycle#12', 'api/lifecycle#13', 'api/lifecycle#14', 'api/lifecycle#16', 'api/lifecycle#17',
]);

function withoutPodAdmission(v: unknown): unknown {
  const o = structuredClone(v) as { kind?: string; spec?: Record<string, unknown> };
  if (o?.kind !== 'Pod' || !o.spec) return v;
  for (const k of ['volumes', 'serviceAccount', 'serviceAccountName', 'tolerations', 'priority', 'preemptionPolicy']) delete o.spec[k];
  for (const c of (o.spec.containers ?? []) as Record<string, unknown>[]) delete c.volumeMounts;
  return o;
}

function check(results: StepResult[], name: string): void {
  for (const r of results) {
    const id = `${name}#${r.index}`;
    const known = KNOWN[id];
    let actual = 'code' in r.actual ? r.actual : undefined;
    if (POD_ADMISSION.has(id)) {
      r.expected.response = withoutPodAdmission(r.expected.response);
      if (actual) actual = { ...actual, response: withoutPodAdmission(actual.response) };
    }
    const matches =
      actual !== undefined &&
      actual.code === r.expected.code &&
      JSON.stringify(actual.warnings) === JSON.stringify(r.expected.warnings) &&
      JSON.stringify(actual.response) === JSON.stringify(r.expected.response);
    if ('skipped' in r.actual) continue;
    if (known !== undefined) {
      expect.soft(matches, `${id} (${r.request}) is listed as a known difference (${known}) but matches now`).toBe(false);
      continue;
    }
    expect.soft(actual ?? r.actual, `${id}: ${r.request}`).toEqual(r.expected);
  }
}

describe.each(['api/crud', 'api/lifecycle', 'api/validation', 'api/defaults', 'api/daemonset', 'api/warnings', 'api/strategic-patch'])('%s', (name) => {
  test('responses equal the real API server', () => {
    check(runRequests(loadFixture(name)), name);
  });
});
