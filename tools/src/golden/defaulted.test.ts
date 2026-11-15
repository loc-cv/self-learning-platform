// Defaulted objects: the manifests of fixtures/golden/cases/objects/defaulted.yaml created through
// the simulator's request pipeline must read back as the real cluster stored them
// (fixtures/golden/v1.37.2/objects/defaulted.yaml), after normalization. Fields written by
// components that are not part of the API server, or by admission plugins of phase 20b, are
// removed from both sides, each with its reason.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, parseAllDocuments } from 'yaml';
import { expect, test } from 'vitest';
import { DEFAULT_APISERVER, handle, registry, type ApiRequest } from '@simlab/k8s';
import { casesDir, fixturesDir } from '../oracle/paths.ts';
import { bootCluster, strip } from './api.differential.ts';
import { newContext, normalizeJson } from './normalize.ts';

type Obj = Record<string, unknown>;

/** Paths removed before comparing, per kind, with why. */
const NOT_THE_API_SERVERS: Record<string, { path: string[]; why: string }[]> = {
  Deployment: [
    { path: ['status'], why: 'written by the deployment controller (phase 05b)' },
    { path: ['metadata', 'annotations'], why: 'deployment.kubernetes.io/revision is the deployment controller\'s' },
  ],
  Pod: [
    { path: ['status'], why: 'written by KWOK in place of a kubelet, and the scheduler' },
    { path: ['spec', 'volumes'], why: 'the kube-api-access volume comes from ServiceAccount admission (phase 20b)' },
    { path: ['spec', 'containers', '*', 'volumeMounts'], why: 'ServiceAccount admission (phase 20b)' },
    { path: ['spec', 'serviceAccount'], why: 'ServiceAccount admission (phase 20b)' },
    { path: ['spec', 'serviceAccountName'], why: 'ServiceAccount admission (phase 20b)' },
    { path: ['spec', 'tolerations'], why: 'DefaultTolerationSeconds admission (phase 20b)' },
    { path: ['spec', 'priority'], why: 'Priority admission (phase 20b)' },
    { path: ['spec', 'preemptionPolicy'], why: 'Priority admission (phase 20b)' },
  ],
};

function drop(o: unknown, p: string[]): void {
  if (o === null || typeof o !== 'object') return;
  const [head, ...rest] = p as [string, ...string[]];
  if (head === '*') {
    if (Array.isArray(o)) for (const x of o) drop(x, rest);
    return;
  }
  const rec = o as Obj;
  if (rest.length === 0) delete rec[head];
  else drop(rec[head], rest);
}

const fixture = parseYaml(readFileSync(path.join(fixturesDir, 'objects', 'defaulted.yaml'), 'utf8')) as { steps: { objects?: { ref: string; object: Obj }[] }[] };
const caseFile = parseYaml(readFileSync(path.join(casesDir, 'objects', 'defaulted.yaml'), 'utf8')) as { files: Record<string, string> };

test('objects created through the pipeline equal what the real API server stored', () => {
  const k = bootCluster();
  const ctx = newContext();
  const manifests = parseAllDocuments(caseFile.files['minimal.yaml'] as string).map((d) => d.toJSON() as Obj);
  const expected = (fixture.steps.find((s) => s.objects && s.objects.length > 1)?.objects ?? []).map((o) => o.object);
  expect(manifests.length).toBe(expected.length);
  manifests.forEach((m, i) => {
    const [group, version] = String(m.apiVersion).includes('/') ? String(m.apiVersion).split('/') : ['', String(m.apiVersion)];
    const res = registry().forKind(group as string, version as string, String(m.kind));
    if (!res) throw new Error(`no resource for ${String(m.kind)}`);
    const req: ApiRequest = { verb: 'create', group: group as string, version: version as string, resource: res.resource, ...(res.namespaced ? { namespace: 'default' } : {}), body: m as ApiRequest['body'] & object };
    const r = k.act('create', (c) => handle(c, DEFAULT_APISERVER, req));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const got = strip(normalizeJson(r.object, ctx)) as Obj;
    const want = structuredClone(expected[i]) as Obj;
    for (const { path: p } of NOT_THE_API_SERVERS[String(m.kind)] ?? []) {
      drop(got, p);
      drop(want, p);
    }
    expect(got, String(m.kind)).toEqual(want);
  });
});
