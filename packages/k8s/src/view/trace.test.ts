// Trace coverage (phase 13 "Trace audit"): each component, driven through the decisions it makes
// today in virtual time on kubeadm-1cp-2w, leaves records with structured data and a cause, and
// the provider maps them to events about entities the view showed. The last test fails when a
// trace kind appears that the mappers neither map nor list as not shown.

import { describe, expect, test } from 'vitest';
import { HOST_TRACE_KINDS } from '@simlab/host';
import type { TraceRecord, ViewEvent } from '@simlab/kernel';
import { DEFAULT_APISERVER } from '../apiserver/config.ts';
import { startKubelet, stopKubelet } from '../kubelet/kubelet.ts';
import { namespaceId, nodeId, objectId } from './ids.ts';
import { NOT_SHOWN, SHOWN_KINDS } from './trace.ts';
import { dataOf, events, expectCoherent, ofKind, records, run, runUntil, scene, sh, type Scene } from './tracetest.ts';

const pod = (ns: string, name: string): string => objectId('Pod', ns, name);
const keyEvents = (evs: ViewEvent[], pred: (e: ViewEvent) => boolean): ViewEvent[] => evs.filter((e) => e.level === 'key' && pred(e));
const podsOf = (sc: Scene, prefix: string): string[] => [...new Set(ofKind(sc, 'scheduler.bound').map((r) => String(dataOf(r).name)).filter((n) => n.startsWith(prefix)))];

describe('scheduler', () => {
  test('a rejection names every node with its reasons; the binding names the verdicts and moves the Pod to its node', () => {
    const sc = scene();
    sh(sc, `kubectl run picky --image=nginx:1.31.8 --overrides='{"spec":{"nodeSelector":{"disktype":"ssd"}}}'`);
    run(sc, 2000);
    const rejected = ofKind(sc, 'scheduler.unschedulable')[0] as TraceRecord;
    expect(dataOf(rejected)).toMatchObject({ pod: 'default/picky', namespace: 'default', name: 'picky', nodes: 3, plugins: ['NodeAffinity', 'TaintToleration'] });
    const verdicts = (rejected.causes ?? []).map((id) => records(sc).find((r) => r.id === id) as TraceRecord).filter((r) => r.kind === 'scheduler.filter');
    expect(verdicts.map((v) => [dataOf(v).node, dataOf(v).plugin, dataOf(v).reasons])).toEqual([
      ['controlplane', 'TaintToleration', ['node(s) had untolerated taint(s)']],
      ['node01', 'NodeAffinity', ["node(s) didn't match Pod's node affinity/selector"]],
      ['node02', 'NodeAffinity', ["node(s) didn't match Pod's node affinity/selector"]],
    ]);

    sh(sc, 'kubectl label node node01 disktype=ssd');
    run(sc, 5000);
    const bound = ofKind(sc, 'scheduler.bound')[0] as TraceRecord;
    expect(dataOf(bound)).toMatchObject({ name: 'picky', node: 'node01', feasible: 1, nodes: 3 });
    const evs = expectCoherent(sc);
    const decision = evs.find((e) => e.id === rejected.id) as ViewEvent;
    expect(decision).toMatchObject({ actor: 'kube-scheduler', level: 'key', tone: 'bad', about: [pod('default', 'picky')] });
    expect(decision.items?.map((i) => [i.entity, i.value, i.tone])).toEqual([
      [nodeId('controlplane'), 'node(s) had untolerated taint(s)', 'bad'],
      [nodeId('node01'), "node(s) didn't match Pod's node affinity/selector", 'bad'],
      [nodeId('node02'), "node(s) didn't match Pod's node affinity/selector", 'bad'],
    ]);
    const binding = evs.find((e) => e.id === bound.id) as ViewEvent;
    expect(binding.link).toEqual({ from: pod('default', 'picky'), to: nodeId('node01') });
    expect(binding.items?.find((i) => i.label === 'node01')?.tone).toBe('good');
    // The verdict records are items, not events of their own.
    expect(evs.some((e) => verdicts.some((v) => v.id === e.id))).toBe(false);
  });
});

describe('deployment and replicaset controllers', () => {
  test('creation, scaling and a rolling update: the scale decisions with their numbers, each Pod linked to its ReplicaSet', () => {
    const sc = scene();
    sh(sc, 'kubectl create deployment web --image=nginx:1.31.8 --replicas=2');
    run(sc, 8000);
    sh(sc, 'kubectl scale deployment web --replicas=4');
    run(sc, 8000);
    sh(sc, 'kubectl set image deployment/web nginx=nginx:1.30.6');
    run(sc, 40_000);
    sh(sc, 'kubectl scale deployment web --replicas=3');
    run(sc, 8000);

    const scales = ofKind(sc, 'deployment.scale').map(dataOf);
    expect(scales[0]).toMatchObject({ namespace: 'default', name: 'web', step: 'new ReplicaSet', from: 0, to: 2, replicas: 2, maxSurge: 1, maxUnavailable: 0 });
    const up = scales.find((d) => d.step === 'rolling update: scale up the new ReplicaSet');
    expect(up).toMatchObject({ maxTotalPods: 5, replicas: 4 });
    expect(typeof up?.currentPodCount).toBe('number');
    const down = scales.find((d) => d.step === 'rolling update: scale down an old ReplicaSet');
    expect(down).toMatchObject({ minAvailable: 3, replicas: 4, maxUnavailable: 1 });
    expect(ofKind(sc, 'deployment.rollout.waiting').length).toBeGreaterThan(0);
    const rsScale = ofKind(sc, 'replicaset.scale').map(dataOf);
    expect(rsScale.some((d) => d.action === 'create' && d.count === 2 && d.replicas === 2 && d.active === 0)).toBe(true);
    expect(rsScale.some((d) => d.action === 'delete' && (d.pods as string[]).length === d.count)).toBe(true);

    const creates = ofKind(sc, 'controller.write').filter((r) => dataOf(r).controller === 'replicaset' && dataOf(r).verb === 'create' && dataOf(r).resource === 'pods');
    expect(dataOf(creates[0])).toMatchObject({ controller: 'replicaset', instance: 'kube-controller-manager', verb: 'create', group: '', resource: 'pods', namespace: 'default', ok: true, code: 201, kind: 'Pod' });
    expect(String(dataOf(creates[0]).key)).toMatch(/^default\/web-/);

    const evs = expectCoherent(sc);
    const created = keyEvents(evs, (e) => e.actor === 'replicaset-controller' && e.text.startsWith('created Pod'));
    expect(created.length).toBeGreaterThanOrEqual(7);
    for (const e of created) expect(e.link?.from).toMatch(/^k8s\/ReplicaSet\/default\/web-/);
    const rsCreated = keyEvents(evs, (e) => e.actor === 'deployment-controller' && e.text.startsWith('created ReplicaSet'));
    expect(rsCreated).toHaveLength(2);
    expect(rsCreated.every((e) => e.link?.from === objectId('Deployment', 'default', 'web'))).toBe(true);
    const deleted = keyEvents(evs, (e) => e.actor === 'replicaset-controller' && /^marked Pod default\/web-.* for deletion$/.test(e.text));
    expect(deleted.length).toBeGreaterThan(0);
  });
});

describe('endpoints', () => {
  test('a Service’s membership: ready, not ready and why; one Pod changing links the Service to it; no match; no selector', () => {
    const sc = scene();
    sh(sc, 'kubectl create service clusterip lonely --tcp=80:80');
    sh(sc, 'kubectl create deployment web --image=nginx:1.31.8 --replicas=2');
    sh(sc, 'kubectl expose deployment web --port 80');
    run(sc, 10_000);
    sh(sc, `kubectl run broken --image=busybox:1.36 --labels=app=web -- sh -c 'exit 1'`);
    run(sc, 10_000);
    sh(sc, `kubectl create -f - <<'EOF'\napiVersion: v1\nkind: Service\nmetadata:\n  name: manual\nspec:\n  ports:\n  - port: 80\nEOF`);
    run(sc, 1000);

    const syncs = ofKind(sc, 'endpoints.sync').map(dataOf);
    const lonely = syncs.filter((d) => d.name === 'lonely').at(-1);
    expect(lonely).toMatchObject({ namespace: 'default', selector: { app: 'lonely' }, pods: [] });
    const web = syncs.filter((d) => d.name === 'web').at(-1) as { pods: { name: string; ready: boolean; why?: string; readyReason?: string; endpoint: boolean }[] };
    const broken = web.pods.find((p) => p.name === 'broken');
    expect(broken).toMatchObject({ ready: false, endpoint: true, why: 'notReady', readyReason: 'ContainersNotReady' });
    expect(web.pods.filter((p) => p.ready)).toHaveLength(2);
    expect(syncs.filter((d) => d.name === 'manual').at(-1)).toMatchObject({ selector: null, pods: [] });

    const evs = expectCoherent(sc);
    const ofSvc = (name: string): ViewEvent[] => evs.filter((e) => e.about[0] === objectId('Service', 'default', name) && e.actor === 'endpointslice-controller');
    expect(ofSvc('lonely')[0]?.text).toBe('Service default/lonely selects no Pod: none in default carries app=lonely');
    expect(ofSvc('manual')[0]?.text).toBe('Service default/manual has no selector: no controller manages its endpoints');
    const last = ofSvc('web').at(-1) as ViewEvent;
    expect(last.items?.find((i) => i.label === 'broken')).toEqual({ entity: pod('default', 'broken'), label: 'broken', value: 'not ready: Ready is not True (ContainersNotReady)', tone: 'bad' });
    // The event where only the broken Pod joined (not ready) links the Service to it.
    expect(ofSvc('web').some((e) => e.link?.to === pod('default', 'broken'))).toBe(true);
    // A sync that changed neither the slices nor what each Pod is is no event: consecutive events differ.
    const lines = ofSvc('web').map((e) => JSON.stringify(e.items));
    expect(lines.every((l, i) => i === 0 || l !== lines[i - 1] || ofSvc('web')[i]?.level === 'key')).toBe(true);
  });
});

describe('kubelet and runtime', () => {
  test('container exits, back-off, restart, a failed pull, a failed start, a deletion: each with its data', () => {
    const sc = scene();
    sh(sc, `kubectl run crash --image=busybox:1.36 -- sh -c 'exit 3'`);
    sh(sc, 'kubectl run nopull --image=registry.example/app:1');
    sh(sc, 'kubectl run nocmd --image=busybox:1.36 --command -- nosuch');
    sh(sc, 'kubectl run calm --image=nginx:1.31.8');
    run(sc, 30_000);
    sh(sc, 'kubectl delete pod calm --wait=false');
    run(sc, 70_000);

    const exited = ofKind(sc, 'runtime.container.exited').map(dataOf).filter((d) => d.name === 'crash');
    expect(exited[0]).toMatchObject({ namespace: 'default', name: 'crash', container: 'crash', exitCode: 3, reason: 'Error', attempt: 0 });
    const backoff = ofKind(sc, 'kubelet.backoff').filter((r) => dataOf(r).name === 'crash');
    const b = dataOf(backoff[0]);
    expect(b).toMatchObject({ container: 'crash', exitCode: 3, backoffMs: 10_000 });
    expect(b.endsAt).toBe((b.since as number) + 10_000);
    expect(b.retryAt as number).toBeGreaterThanOrEqual(b.endsAt as number);
    expect(ofKind(sc, 'runtime.container.exited').some((r) => dataOf(r).containerId === b.containerId)).toBe(true);
    expect(ofKind(sc, 'kubelet.container.restart').map(dataOf).some((d) => d.name === 'crash' && d.exitCode === 3)).toBe(true);

    const pull = ofKind(sc, 'kubelet.pull.done').map(dataOf).find((d) => d.name === 'nopull');
    expect(pull).toMatchObject({ ok: false, image: 'registry.example/app:1' });
    expect(String(pull?.error)).toMatch(/no such host/);
    expect(ofKind(sc, 'runtime.container.start-failed').map(dataOf).find((d) => d.name === 'nocmd')).toMatchObject({ exitCode: 128, reason: 'StartError' });
    const status = ofKind(sc, 'kubelet.status').map(dataOf).filter((d) => d.name === 'calm');
    expect(status.some((d) => (d.phase as { to?: string } | undefined)?.to === 'Running' && (d.ready as { to?: string } | undefined)?.to === 'True')).toBe(true);
    expect(ofKind(sc, 'kubelet.kill').map(dataOf).find((d) => d.name === 'calm')).toMatchObject({ containers: ['calm'], why: 'deleted', then: 'terminate' });
    expect(ofKind(sc, 'kubelet.pod.delete').map(dataOf).some((d) => d.name === 'calm')).toBe(true);
    expect(ofKind(sc, 'kubelet.gc').map(dataOf).some((d) => d.name === 'calm')).toBe(true);

    const evs = expectCoherent(sc);
    const crash = pod('default', 'crash');
    const firstBackoff = evs.find((e) => e.id === backoff[0]?.id) as ViewEvent;
    expect(firstBackoff).toMatchObject({ level: 'key', tone: 'bad', about: [crash, expect.stringMatching(/^k8s\/Node\//)] });
    // The back-off follows from the exit that caused it.
    const exitEvent = evs.filter((e) => e.about[0] === crash && e.text.startsWith('container crash of Pod default/crash exited') && e.id < firstBackoff.id).at(-1) as ViewEvent;
    expect(firstBackoff.causes).toContain(exitEvent.id);
    // A later sync in the same back-off is bookkeeping.
    const repeats = backoff.filter((r) => dataOf(r).containerId === b.containerId).slice(1);
    for (const r of repeats) expect(evs.find((e) => e.id === r.id)?.level).toBe('detail');
    expect(keyEvents(evs, (e) => e.about[0] === pod('default', 'nopull') && e.text.startsWith('could not pull')).length).toBeGreaterThan(0);
    expect(keyEvents(evs, (e) => e.about[0] === pod('default', 'nocmd') && e.text.includes('could not start')).length).toBeGreaterThan(0);
  });
});

describe('node lifecycle', () => {
  test('a kubelet that stops: the node goes Unknown, its Pods not ready; back again, Ready', () => {
    const sc = scene();
    sc.k.act('stop', (ctx) => stopKubelet(ctx, 'node02'));
    runUntil(sc, 120_000, () => ofKind(sc, 'nodelifecycle.unknown').length > 0);
    const unknown = ofKind(sc, 'nodelifecycle.unknown')[0] as TraceRecord;
    expect(dataOf(unknown)).toMatchObject({ node: 'node02', wasReady: true, grace: 50_000 });
    const notReady = ofKind(sc, 'nodelifecycle.pod-not-ready');
    expect(notReady.length).toBeGreaterThan(0);
    expect(notReady.every((r) => r.causes?.includes(unknown.id))).toBe(true);
    sc.k.act('start', (ctx) => startKubelet(ctx, DEFAULT_APISERVER, { name: 'node02', ip: '172.16.0.12', podCIDR: '10.244.2.0/24' }));
    run(sc, 15_000);
    expect(ofKind(sc, 'kubelet.node.ready').map(dataOf)).toContainEqual({ node: 'node02', from: 'Unknown', to: 'True' });
    const evs = expectCoherent(sc);
    expect(keyEvents(evs, (e) => e.about[0] === nodeId('node02')).map((e) => e.tone)).toEqual(['bad', 'bad', 'good']);
  });
});

describe('garbage collector and namespace controller', () => {
  test('deleting a Deployment and a namespace: what the collector and the controller delete, linked from the owner', () => {
    const sc = scene();
    sh(sc, 'kubectl create deployment web --image=nginx:1.31.8 --replicas=2');
    sh(sc, 'kubectl create namespace tmp');
    sh(sc, 'kubectl -n tmp create deployment job --image=nginx:1.31.8');
    run(sc, 10_000);
    sh(sc, 'kubectl delete deployment web');
    sh(sc, 'kubectl delete namespace tmp --wait=false');
    run(sc, 60_000);

    const gc = ofKind(sc, 'gc.delete').map(dataOf);
    expect(gc.find((d) => d.kind === 'ReplicaSet')).toMatchObject({ namespace: 'default', owners: [{ kind: 'Deployment', name: 'web', gone: true }], policy: 'Background' });
    expect(gc.filter((d) => d.kind === 'Pod' && d.namespace === 'default')).toHaveLength(2);
    expect(ofKind(sc, 'namespace.finalized').map(dataOf)).toEqual([{ namespace: 'tmp' }]);
    const nsDeletes = ofKind(sc, 'controller.write').filter((r) => dataOf(r).controller === 'namespace' && dataOf(r).verb === 'delete');
    const drawn = nsDeletes.filter((r) => ['pods', 'deployments', 'replicasets', 'services'].includes(String(dataOf(r).resource)));
    expect(nsDeletes.length).toBeGreaterThan(0);

    const evs = expectCoherent(sc);
    const rsGone = keyEvents(evs, (e) => e.actor === 'generic-garbage-collector' && e.text.startsWith('deletes ReplicaSet'));
    expect(rsGone[0]?.link?.from).toBe(objectId('Deployment', 'default', 'web'));
    const fromNs = keyEvents(evs, (e) => e.actor === 'namespace-controller' && e.link?.from === namespaceId('tmp'));
    expect(fromNs.length).toBe(drawn.length);
    expect(drawn.length).toBeGreaterThan(0);
    expect(keyEvents(evs, (e) => e.text === 'namespace tmp is empty: its finalizer is removed and it goes')).toHaveLength(1);
  });
});

describe('kubectl writes', () => {
  test('every mutating request leaves a record with the user, the coordinates and the answer; reads leave none', () => {
    const sc = scene();
    sh(sc, 'kubectl create configmap conf --from-literal=a=b');
    sh(sc, 'kubectl create configmap conf --from-literal=a=b', 1);
    sh(sc, 'kubectl get configmaps');
    sh(sc, 'kubectl label configmap conf tier=x');
    sh(sc, 'kubectl delete configmap conf');
    const writes = ofKind(sc, 'apiserver.write').map(dataOf);
    expect(writes.map((d) => [d.verb, d.resource, d.name, d.ok, d.code])).toEqual([
      ['create', 'configmaps', 'conf', true, 201],
      ['create', 'configmaps', 'conf', false, 409],
      ['patch', 'configmaps', 'conf', true, 200],
      ['delete', 'configmaps', 'conf', true, 200],
    ]);
    expect(writes[1]).toMatchObject({ user: 'kubernetes-admin', namespace: 'default', reason: 'AlreadyExists', message: 'configmaps "conf" already exists', machine: 'controlplane' });
    const evs = expectCoherent(sc);
    const shown = evs.filter((e) => e.actor === 'kubectl (kubernetes-admin)');
    expect(shown.map((e) => [e.text, e.tone, e.about])).toEqual([
      ['created ConfigMap default/conf', 'neutral', [namespaceId('default')]],
      ['could not create ConfigMap default/conf: configmaps "conf" already exists', 'bad', [namespaceId('default')]],
      ['patched ConfigMap default/conf', 'neutral', [namespaceId('default')]],
      ['deleted ConfigMap default/conf', 'neutral', [namespaceId('default')]],
    ]);
    // The command lines are the host's input events, each before the write it caused.
    const inputs = evs.filter((e) => e.input === true && e.text.startsWith('kubectl'));
    expect(inputs).toHaveLength(5);
    expect(shown.every((w) => inputs.some((i) => i.t <= w.t && i.id < w.id))).toBe(true);
  });
});

describe('every trace kind is mapped or listed', () => {
  test('a rich scenario: rollout, crash loop, unschedulable Pod, Services, deletions, a node down', () => {
    const sc = scene();
    sh(sc, 'kubectl create deployment web --image=nginx:1.31.8 --replicas=3');
    sh(sc, 'kubectl expose deployment web --port 80');
    sh(sc, `kubectl run crash --image=busybox:1.36 -- sh -c 'echo hi; exit 1'`);
    sh(sc, `kubectl run picky --image=nginx:1.31.8 --overrides='{"spec":{"nodeSelector":{"disktype":"ssd"}}}'`);
    sh(sc, 'kubectl run nopull --image=registry.example/app:1');
    run(sc, 20_000);
    sh(sc, 'kubectl set image deployment/web nginx=nginx:1.30.6');
    run(sc, 30_000);
    sh(sc, 'kubectl create namespace tmp');
    sh(sc, 'kubectl -n tmp run p --image=nginx:1.31.8');
    run(sc, 10_000);
    sh(sc, 'kubectl delete namespace tmp --wait=false');
    sh(sc, 'kubectl delete deployment web');
    sh(sc, 'kubectl delete pod crash --wait=false');
    sc.k.act('stop', (ctx) => stopKubelet(ctx, 'node01'));
    run(sc, 90_000);

    const known = new Set([...SHOWN_KINDS, ...Object.keys(NOT_SHOWN), ...Object.keys(HOST_TRACE_KINDS)]);
    const kinds = [...new Set(records(sc).map((r) => r.kind))].sort();
    expect(kinds.filter((k) => !known.has(k))).toEqual([]);
    for (const k of Object.keys(NOT_SHOWN)) expect(SHOWN_KINDS).not.toContain(k);
    expect(kinds.length).toBeGreaterThan(35);
    expectCoherent(sc);
    expect(podsOf(sc, 'web-').length).toBeGreaterThanOrEqual(6);
    expect(events(sc).filter((e) => e.level === 'key').length).toBeGreaterThan(50);
  });
});
