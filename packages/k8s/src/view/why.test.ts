// "Why?" on the k8s entities (phase 13): a Pending Pod names each node and its reason, a Pod in
// back-off shows the exit and the timer, a Service shows which Pods matched and which were not
// ready; and skipping to the next event during a back-off lands exactly on the restart.

import { describe, expect, test } from 'vitest';
import { buildEvents, buildWhy, createInteractiveDriver, createRecorder, DEFAULT_START_TIME, type TraceRecord, type Why } from '@simlab/kernel';
import { stopKubelet } from '../kubelet/kubelet.ts';
import { namespaceId, nodeId, objectId } from './ids.ts';
import { clock } from './trace.ts';
import { k8sWhy } from './why.ts';
import { dataOf, events, ofKind, records, registry, run, runUntil, scene, sh, type Scene } from './tracetest.ts';

const whyOf = (sc: Scene, id: string): Why => {
  const w = buildWhy(registry, sc.k.world, events(sc), id);
  if (!w) throw new Error(`no why for ${id}`);
  return w;
};
const pod = (name: string, ns = 'default'): string => objectId('Pod', ns, name);
const texts = (w: Why): string[] => w.steps.map((s) => s.text);

describe('a Pending Pod', () => {
  test('names each node and the reason it was rejected, after who created it', () => {
    const sc = scene();
    sh(sc, `kubectl run picky --image=nginx:1.31.8 --overrides='{"spec":{"nodeSelector":{"disktype":"ssd"}}}'`);
    run(sc, 3000);
    const w = whyOf(sc, pod('picky'));
    expect(w.summary).toBe('Pending: kube-scheduler found no node for it; each of the 3 nodes rejected it for the reason listed.');
    expect(texts(w)).toEqual(['created Pod default/picky', 'no node can take Pod default/picky: all 3 nodes rejected it']);
    expect(w.steps[1]?.items?.map((i) => [i.entity, i.value])).toEqual([
      [nodeId('controlplane'), 'node(s) had untolerated taint(s)'],
      [nodeId('node01'), "node(s) didn't match Pod's node affinity/selector"],
      [nodeId('node02'), "node(s) didn't match Pod's node affinity/selector"],
    ]);
  });
});

describe('a Pod in back-off', () => {
  /** A crash-looping Pod, run until its second back-off has begun. */
  function crashing(): { sc: Scene; backoff: TraceRecord } {
    const sc = scene();
    sh(sc, `kubectl run crash --image=busybox:1.36 -- sh -c 'exit 3'`);
    runUntil(sc, 120_000, () => ofKind(sc, 'kubelet.backoff').filter((r) => dataOf(r).backoffMs === 20_000).length > 0);
    return { sc, backoff: ofKind(sc, 'kubelet.backoff').at(-1) as TraceRecord };
  }

  test('shows the exit, then the back-off and when the restart is due', () => {
    const { sc, backoff } = crashing();
    const d = dataOf(backoff) as { endsAt: number; retryAt: number; exitCode: number };
    const w = whyOf(sc, pod('crash'));
    const exit = w.steps.find((s) => s.text.startsWith('container crash of Pod default/crash exited'));
    const back = w.steps.find((s) => s.id === backoff.id);
    expect(exit?.items).toEqual([
      { label: 'Exit code', value: '3', tone: 'bad' },
      { label: 'Reason', value: 'Error', tone: 'bad' },
    ]);
    expect(back?.items?.map((i) => [i.label, i.value])).toEqual([
      ['Exit code', '3'],
      ['Back-off', '20s'],
      ['Back-off ends', clock(d.endsAt)],
      ['Next sync', clock(d.retryAt)],
    ]);
    expect(back?.causes).toContain(exit?.id);
    expect((exit?.id ?? 0) < (back?.id ?? 0)).toBe(true);
    expect(w.summary).toBe(`Running on ${String(dataOf(backoff).node)}. Container crash exited with code 3 (Error) and is in back-off for 20s, until ${clock(d.endsAt)}; the kubelet restarts it at its next sync, ${clock(d.retryAt)}.`);
  });

  test('skip to next event lands exactly on the restart the back-off announced', () => {
    const { sc, backoff } = crashing();
    const d = dataOf(backoff) as { endsAt: number; retryAt: number; containerId: string; restartCount: number };
    expect(d.retryAt).toBeGreaterThanOrEqual(d.endsAt);
    // A moment into the back-off, before anything else is due.
    run(sc, 1000);
    expect(sc.k.now).toBeLessThan(d.retryAt);
    const recorder = createRecorder(sc.k, { topology: 'kubeadm-1cp-2w', seed: 1, startTime: DEFAULT_START_TIME, engine: 'test' });
    const driver = createInteractiveDriver(recorder);
    const keys = (): number => buildEvents(registry, records(sc)).filter((e) => e.level === 'key').length;
    const before = keys();
    const lastId = records(sc).at(-1)?.id ?? 0;
    expect(driver.skipToNextEvent(() => keys() > before)).toBe(true);
    // It stops at the kubelet's restart, the next sync it announced: nothing key-level in between.
    expect(sc.k.now).toBe(d.retryAt);
    const fresh = buildEvents(registry, records(sc)).filter((e) => e.id > lastId && e.level === 'key');
    expect(fresh.map((e) => [e.t, e.text])).toEqual([[d.retryAt, `restarts container crash of Pod default/crash (restart ${d.restartCount + 1}), which exited with 3`]]);
    expect(dataOf(ofKind(sc, 'kubelet.container.restart').at(-1))).toMatchObject({ containerId: d.containerId });
    // The container runs again once the runtime has created and started it.
    expect(ofKind(sc, 'runtime.container.started').filter((r) => r.t >= d.retryAt)).toEqual([]);
    expect(driver.skipToNextEvent(() => ofKind(sc, 'runtime.container.started').some((r) => r.t >= d.retryAt))).toBe(true);
    const started = ofKind(sc, 'runtime.container.started').at(-1) as TraceRecord;
    expect(sc.k.now).toBe(started.t);
    expect(dataOf(started)).toMatchObject({ name: 'crash', attempt: d.restartCount + 1 });
    expect(started.t - d.retryAt).toBeLessThan(2000);
  });
});

describe('a Service', () => {
  test('lists the Pods it matched, ready and not ready with why; one matching nothing says so; one without a selector too', () => {
    const sc = scene();
    sh(sc, 'kubectl create deployment web --image=nginx:1.31.8 --replicas=2');
    sh(sc, 'kubectl expose deployment web --port 80');
    sh(sc, `kubectl run broken --image=busybox:1.36 --labels=app=web -- sh -c 'exit 1'`);
    sh(sc, `kubectl run waiting --image=nginx:1.31.8 --labels=app=web --overrides='{"spec":{"nodeSelector":{"disktype":"ssd"}}}'`);
    sh(sc, 'kubectl create service clusterip lonely --tcp=80:80');
    sh(sc, `kubectl create -f - <<'EOF'\napiVersion: v1\nkind: Service\nmetadata:\n  name: manual\nspec:\n  ports:\n  - port: 80\nEOF`);
    run(sc, 15_000);

    const w = whyOf(sc, objectId('Service', 'default', 'web'));
    const items = w.steps.at(-1)?.items ?? [];
    const by = Object.fromEntries(items.map((i) => [i.label, [i.value, i.tone]]));
    expect(by['broken']).toEqual(['not ready: Ready is not True (ContainersNotReady)', 'bad']);
    expect(by['waiting']).toEqual(['no endpoint: no Pod IP yet (phase Pending)', 'bad']);
    expect(Object.values(by).filter(([v]) => v === 'ready')).toHaveLength(2);
    expect(w.summary).toBe('It selects 4 Pod(s), 2 ready. Not ready: broken (not ready: Ready is not True (ContainersNotReady)); waiting (no endpoint: no Pod IP yet (phase Pending)).');
    expect(texts(w)[0]).toBe('created Service default/web');

    const lonely = whyOf(sc, objectId('Service', 'default', 'lonely'));
    expect(lonely.summary).toBe('Its selector app=lonely matches no Pod in default: no Pod carries those labels, so it has no endpoints.');
    expect(lonely.steps.at(-1)?.text).toBe('Service default/lonely selects no Pod: none in default carries app=lonely');
    const manual = whyOf(sc, objectId('Service', 'default', 'manual'));
    expect(manual.summary).toBe('It has no selector: no controller manages its endpoints; whoever made them keeps them.');
  });
});

describe('other entities', () => {
  test('a running Pod, its ReplicaSet and Deployment, a Node down, a Namespace going, a deleted Pod, ids not k8s’s', () => {
    const sc = scene();
    sh(sc, 'kubectl create deployment web --image=nginx:1.31.8 --replicas=2');
    sh(sc, 'kubectl create namespace tmp');
    sh(sc, 'kubectl -n tmp run p --image=nginx:1.31.8');
    sh(sc, 'kubectl run gone --image=nginx:1.31.8');
    run(sc, 15_000);
    const name = String(dataOf(ofKind(sc, 'scheduler.bound').find((r) => String(dataOf(r).name).startsWith('web-'))).name);
    const running = whyOf(sc, pod(name));
    expect(running.summary).toMatch(/^Running on node0[12]\. Container nginx is running\.$/);
    expect(texts(running).slice(0, 2)).toEqual([`created Pod default/${name}`, expect.stringMatching(new RegExp(`^bound Pod default/${name} to node0[12]`))]);
    expect(running.steps[0]?.actor).toBe('replicaset-controller');

    const rsName = name.replace(/-[^-]+$/, '');
    const rs = whyOf(sc, objectId('ReplicaSet', 'default', rsName));
    expect(rs.summary).toBe(`2 desired, 2 current, 2 ready. Deployment default/web: new ReplicaSet ${rsName} with 2 replica(s).`);
    const dep = whyOf(sc, objectId('Deployment', 'default', 'web'));
    expect(dep.summary).toBe('All 2 replica(s) are up to date and available.');
    expect(texts(dep)[0]).toBe('created Deployment default/web');

    sh(sc, 'kubectl delete pod gone');
    expect(whyOf(sc, pod('gone')).summary).toBe('Pod default/gone no longer exists.');

    sh(sc, 'kubectl delete namespace tmp --wait=false');
    run(sc, 200);
    const ns = whyOf(sc, namespaceId('tmp'));
    expect(ns.summary).toMatch(/^Terminating: the namespace controller deletes its content first/);
    expect(ns.steps[0]?.text).toBe('marked Namespace tmp for deletion');

    expect(whyOf(sc, nodeId('node01')).summary).toBe('Ready: its kubelet posts status and renews its Lease.');
    sc.k.act('stop', (ctx) => stopKubelet(ctx, 'node01'));
    runUntil(sc, 120_000, () => ofKind(sc, 'nodelifecycle.unknown').length > 0);
    const down = whyOf(sc, nodeId('node01'));
    expect(down.summary).toBe('NotReady: Kubelet stopped posting node status.');
    expect(down.steps.map((s) => [s.actor, s.tone])).toEqual([
      ['kubelet on node01', 'bad'],
      ['node-controller', 'bad'],
    ]);
    expect(k8sWhy(sc.k.world, events(sc), 'host/machine/node01')).toBeUndefined();
    expect(k8sWhy(sc.k.world, events(sc), 'k8s/Secret/default/x')).toBeUndefined();
  });
});
