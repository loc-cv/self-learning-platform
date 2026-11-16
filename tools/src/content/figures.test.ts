// Figures on the real engine (phase 10c exit criteria): a figure of the learner's world agrees with
// what kubectl prints for that world, and content validation refuses a lab whose figure selects
// nothing or whose scene reaches something the simulator does not support.

import { describe, expect, test } from 'vitest';
import { captureOutput, openSession } from '@simlab/host';
import { competencyIds, findItem, skillIds, loadPacks, type ItemFile } from '@simlab/content';
import { createLab, resolveParams, type Figure, type Item, type Panel } from '@simlab/learn';
import type { Json } from '@simlab/kernel';
import { checkItem } from './check.ts';
import { contentRegistry } from './registry.ts';

const file = (id: string): ItemFile => {
  const f = findItem(id);
  if (!f) throw new Error(`no item ${id}`);
  return f;
};
const copy = (id: string): ItemFile => ({ ...file(id), raw: JSON.parse(JSON.stringify(file(id).raw)) as Json });

function seedWhere(it: Item, want: Record<string, unknown>): number {
  for (let s = 1; s < 200; s++) {
    const p = resolveParams(it, s);
    if (Object.entries(want).every(([k, v]) => p[k] === v)) return s;
  }
  throw new Error(`no seed with ${JSON.stringify(want)}`);
}

/** Rows of a kubectl table, split on runs of two or more spaces. */
const rows = (out: string): string[][] =>
  out
    .trimEnd()
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s{2,}/));

describe('a figure of `now`', () => {
  test('shows the learner’s world as kubectl prints it, halfway through the fix', () => {
    const id = 'k8s.troubleshooting.broken-rollout-01';
    const it = file(id).raw as unknown as Item;
    const lab = createLab(it, contentRegistry, { seed: seedWhere(it, { badImage: 'tag' }) });
    const ns = String(lab.variant.params['ns']);
    const app = String(lab.variant.params['app']);
    // The image fixed, the Service not yet: the rollout finishes and the Service still selects nothing.
    lab.run([{ run: `kubectl -n ${ns} set image deployment/${app} ${app}=nginx:1.31.8` }, { advance: '2m' }]);
    const figure: Figure = { kind: 'view', of: 'now', focus: { scope: ns, kinds: ['Deployment', 'ReplicaSet', 'Pod', 'Service'] }, show: ['Images', 'Selector'], caption: 'c', alt: 'a' };
    const [b] = lab.render([{ figure }]);
    if (!b || !('figure' in b) || b.figure.kind !== 'view') throw new Error(`not rendered: ${JSON.stringify(b)}`);
    const p: Panel = b.figure.panel;
    const kind = new Map(p.model.kinds.map((k) => [k.kind, k.label]));
    const of = (label: string) => p.model.entities.filter((e) => kind.get(e.kind) === label);
    const fact = (e: { facts: { label: string; value: string }[] }, label: string) => e.facts.find((f) => f.label === label)?.value;

    const capture = captureOutput();
    const session = openSession(lab.kernel.fork({ ports: capture.ports }), capture, { machine: 'controlplane', user: 'root' });
    const kubectl = (args: string): string[][] => rows(session.run(`kubectl -n ${ns} ${args}`).output);

    const pods = kubectl('get pods -o wide').map(([name, , status, , , , node]) => ({ name, status, node }));
    expect(pods.length).toBe(Number(lab.variant.params['replicas']));
    expect(of('Pod').map((e) => ({ name: e.label, status: e.status, node: p.model.entities.find((x) => x.id === e.container)?.label }))).toEqual(pods);

    const rs = kubectl('get rs -o wide').map(([name, , , , , , image]) => ({ name, image }));
    expect(of('ReplicaSet').map((e) => ({ name: e.label, image: fact(e, 'Images') }))).toEqual(rs);
    expect(rs.length).toBe(3);

    const deploy = kubectl('get deploy -o wide').map(([name, ready, , , , , image, selector]) => ({ name, ready, image, selector }));
    expect(of('Deployment').map((e) => ({ name: e.label, ready: e.status, image: fact(e, 'Images'), selector: fact(e, 'Selector') }))).toEqual(deploy);

    const svc = kubectl('get svc -o wide').map(([name, type, , , , , selector]) => ({ name, type, selector }));
    expect(of('Service').map((e) => ({ name: e.label, type: e.status, selector: fact(e, 'Selector') }))).toEqual(svc);
    // The Service still selects nothing, so it routes nowhere: no relation leaves it.
    expect(p.model.relations.filter((r) => r.from === of('Service')[0]?.id)).toEqual([]);
    expect(svc[0]?.selector).toBe(`app.kubernetes.io/name=${app}`);
  });
});

describe('content validation refuses broken figures', () => {
  const opts = { seeds: 1, skills: skillIds(loadPacks()), competencies: competencyIds() };
  const problems = (f: ItemFile): string[] => {
    const r = checkItem(f, opts);
    return [...r.problems, ...r.seeds.flatMap((s) => s.problems)];
  };
  const debrief = (f: ItemFile): { figure?: Record<string, Json> }[] => (f.raw as { debrief: { figure?: Record<string, Json> }[] }).debrief;

  test('a figure whose focus selects nothing', () => {
    const f = copy('k8s.workloads.deployment-service-01');
    const fig = debrief(f)[0]?.figure as Record<string, Json>;
    fig['focus'] = { scope: 'no-such-namespace', kinds: ['Deployment'] };
    expect(problems(f)).toEqual(['debrief figure 1 (view): the focus selects nothing in the solved world']);
  });

  test('a scene with a gap', () => {
    const f = copy('k8s.troubleshooting.broken-rollout-01');
    const scene = debrief(f).find((b) => b.figure?.['kind'] === 'scene')?.figure as { frames: { steps?: Json[] }[] };
    (scene.frames[1] as { steps: Json[] }).steps.push({ run: 'less /etc/hostname' });
    // Once per seed: content validation covers every value of badImage, which the frame's steps depend on.
    const all = new Set(problems(f));
    expect([...all]).toEqual(['debrief figure 2 (scene): scene frame 2, step 3 (run): the simulator does not support this: less: this program (in `less /etc/hostname`)']);
  });

  test('a note that cites a divergence the register does not have', () => {
    const f = copy('k8s.workloads.deployment-service-01');
    const fig = debrief(f)[0]?.figure as { notes: Json[] };
    fig.notes.push({ text: 'simpler than reality', divergence: 'DIV-999' });
    expect(checkItem(f, opts).problems).toEqual(['debrief[0].figure: DIV-999 is not in the divergence register (docs/FIDELITY.md)']);
  });
});
