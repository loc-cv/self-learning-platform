// The Kubernetes view provider on real worlds: kubeadm-1cp-2w booted, Deployments created through
// the API server and the controllers, scheduler and kubelets left to work in virtual time.

import { describe, expect, test } from 'vitest';
import { buildView, validateView, type Kernel, type ViewEntity, type ViewModel } from '@simlab/kernel';
import { captureOutput, openSession } from '@simlab/host';
import { api, cluster, deployment, registry } from '../checks/testenv.ts';
import { KINDS, namespaceId, nodeId } from './provider.ts';

const view = (k: Kernel): ViewModel => buildView(registry, k.world);
const fact = (e: ViewEntity | undefined, label: string): string | undefined => e?.facts.find((f) => f.label === label)?.value;
const ofKind = (m: ViewModel, kind: string): ViewEntity[] => m.entities.filter((e) => e.kind === kind);
const byId = (m: ViewModel, id: string): ViewEntity | undefined => m.entities.find((e) => e.id === id);

function create(k: Kernel, body: ReturnType<typeof deployment>, ns = 'default'): void {
  api(k, (c) => c.resource('apps/v1/deployments').create(ns, body));
}

describe('the cluster as the topology leaves it', () => {
  const k = cluster();
  const m = view(k);

  test('is a valid view model in a defined order', () => {
    expect(validateView(m)).toEqual([]);
    expect(m.entities.map((e) => e.id)).toEqual([...m.entities.map((e) => e.id)].sort());
    expect(view(k)).toEqual(m);
  });

  test('each Node sits on its machine; kube-system is the platform’s', () => {
    expect(ofKind(m, KINDS.node).map((n) => [n.label, n.container, n.state, n.status])).toEqual([
      ['controlplane', 'host/machine/controlplane', 'healthy', 'Ready'],
      ['node01', 'host/machine/node01', 'healthy', 'Ready'],
      ['node02', 'host/machine/node02', 'healthy', 'Ready'],
    ]);
    expect(fact(byId(m, nodeId('controlplane')), 'Taints')).toBe('node-role.kubernetes.io/control-plane:NoSchedule');
    expect(byId(m, namespaceId('kube-system'))?.system).toBe(true);
    expect(byId(m, namespaceId('default'))?.system).toBeUndefined();
    const sys = ofKind(m, KINDS.pod);
    expect(sys.length).toBeGreaterThan(0);
    expect(sys.every((p) => p.system === true && p.scope === namespaceId('kube-system') && p.container !== undefined)).toBe(true);
  });
});

describe('scheduling', () => {
  test('Pods no node can take have no container; after the fix they sit on the labelled node', () => {
    const k = cluster();
    api(k, (c) => c.resource('v1/nodes').patch(undefined, 'node02', { metadata: { labels: { disktype: 'ssd' } } }));
    create(k, deployment('web', 'nginx:1.31.8', 3, {}), 'default');
    api(k, (c) => c.resource('apps/v1/deployments').patch('default', 'web', { spec: { template: { spec: { nodeSelector: { disktype: 'SSD' } } } } }));
    k.advance(30_000);
    let m = view(k);
    const pending = ofKind(m, KINDS.pod).filter((p) => p.scope === namespaceId('default') && p.status === 'Pending');
    expect(pending).toHaveLength(3);
    expect(pending.every((p) => p.container === undefined && p.state === 'degraded')).toBe(true);
    expect(fact(pending[0], 'Node-Selectors')).toBe('disktype=SSD');
    const dep = byId(m, 'k8s/Deployment/default/web');
    expect(dep?.container).toBe(namespaceId('default'));
    expect(dep?.status).toBe('0/3');

    api(k, (c) => c.resource('apps/v1/deployments').patch('default', 'web', { spec: { template: { spec: { nodeSelector: { disktype: 'ssd' } } } } }));
    k.advance(60_000);
    m = view(k);
    const pods = ofKind(m, KINDS.pod).filter((p) => p.scope === namespaceId('default'));
    expect(pods.map((p) => [p.container, p.status, p.state])).toEqual(Array(3).fill([nodeId('node02'), 'Running', 'healthy']));
    expect(byId(m, 'k8s/Deployment/default/web')?.state).toBe('healthy');
    // Deployment → ReplicaSet → Pod.
    const rs = m.relations.filter((r) => r.type === 'owns' && r.from === 'k8s/Deployment/default/web').map((r) => r.to);
    expect(rs).toHaveLength(2);
    const current = rs.find((id) => byId(m, id)?.muted !== true) as string;
    expect(m.relations.filter((r) => r.type === 'owns' && r.from === current).map((r) => r.to).sort()).toEqual(pods.map((p) => p.id).sort());
  });
});

describe('Services', () => {
  test('a Service selects its Pods and routes to the ready ones', () => {
    const k = cluster();
    create(k, deployment('web', 'nginx:1.31.8', 2));
    api(k, (c) => c.resource('v1/services').create('default', { apiVersion: 'v1', kind: 'Service', metadata: { name: 'web' }, spec: { selector: { app: 'web' }, ports: [{ port: 80, targetPort: 80 }] } }));
    api(k, (c) => c.resource('v1/services').create('default', { apiVersion: 'v1', kind: 'Service', metadata: { name: 'typo' }, spec: { selector: { app: 'wbe' }, ports: [{ port: 80 }] } }));
    k.advance(30_000);
    const m = view(k);
    const pods = ofKind(m, KINDS.pod).filter((p) => p.scope === namespaceId('default')).map((p) => p.id);
    const rel = (type: string, from: string): string[] => m.relations.filter((r) => r.type === type && r.from === from).map((r) => r.to);
    expect(rel('selects', 'k8s/Service/default/web')).toEqual(pods);
    expect(rel('routesTo', 'k8s/Service/default/web')).toEqual(pods);
    expect(byId(m, 'k8s/Service/default/web')?.state).toBe('healthy');
    expect(rel('selects', 'k8s/Service/default/typo')).toEqual([]);
    expect(byId(m, 'k8s/Service/default/typo')?.state).toBe('failed');
    expect(fact(byId(m, 'k8s/Service/default/web'), 'Selector')).toBe('app=web');
  });
});

describe('a rollout, followed as a sequence of views', () => {
  test('the new ReplicaSet takes over Pod by Pod and every Pod keeps its id while it lives', () => {
    const k = cluster();
    create(k, deployment('web', 'nginx:1.31.8', 6));
    k.advance(40_000);
    const views: ViewModel[] = [view(k)];
    api(k, (c) => c.resource('apps/v1/deployments').patch('default', 'web', { spec: { template: { spec: { containers: [{ name: 'nginx', image: 'nginx:1.14.2' }] } } } }));
    for (let i = 0; i < 120; i++) {
      k.advance(1_000);
      views.push(view(k));
    }
    const web = (m: ViewModel): ViewEntity[] => ofKind(m, KINDS.pod).filter((p) => p.scope === namespaceId('default'));
    const states = views.map((m) => byId(m, 'k8s/Deployment/default/web')?.state);
    expect(states[0]).toBe('healthy');
    expect(states[1]).toBe('progressing');
    expect(states[states.length - 1]).toBe('healthy');
    // Never more than replicas + maxSurge (25 % of 6, rounded up: 2) Pods that are not terminating.
    for (const m of views) expect(web(m).filter((p) => p.status !== 'Terminating').length).toBeLessThanOrEqual(8);
    // A Pod appears once and leaves once: its id is never reused for another Pod.
    const seen = new Map<string, [number, number]>();
    views.forEach((m, i) => {
      for (const p of web(m)) seen.set(p.id, [seen.get(p.id)?.[0] ?? i, i]);
    });
    for (const [id, [first, last]] of seen) for (let i = first; i <= last; i++) expect(web(views[i] as ViewModel).some((p) => p.id === id), id).toBe(true);
    const last = views[views.length - 1] as ViewModel;
    expect(web(last).map((p) => [p.status, p.state])).toEqual(Array(6).fill(['Running', 'healthy']));
    const rs = ofKind(last, KINDS.replicaSet).filter((r) => r.container === namespaceId('default'));
    expect(rs.map((r) => r.muted ?? false).sort()).toEqual([false, true]);
    expect(seen.size).toBe(12);
  });
});

/** Rows of a kubectl table, split on runs of two or more spaces. */
function rows(out: string): string[][] {
  const lines = out.trimEnd().split('\n');
  return lines.slice(1).map((l) => l.trim().split(/\s{2,}/));
}

describe('the view agrees with kubectl', () => {
  test('same Pods, nodes and statuses as `kubectl get pods -A -o wide` and `kubectl get nodes`', () => {
    const capture = captureOutput();
    const k = cluster();
    api(k, (c) => c.resource('v1/nodes').patch(undefined, 'node01', { spec: { unschedulable: true } }));
    create(k, deployment('web', 'nginx:1.31.8', 4));
    create(k, deployment('bad', 'nginx:no-such-tag', 2));
    k.advance(45_000);
    const m = view(k);
    const s = k.fork({ ports: capture.ports });
    const session = openSession(s, capture, { machine: 'controlplane', user: 'root' });
    // Reading through kubectl moves the fork's clock a little; nothing changes state meanwhile.
    const pods = rows(session.run('kubectl get pods -A -o wide').output).map(([ns, name, , status, , , , node]) => ({ id: `k8s/Pod/${ns}/${name}`, status, node: node === '<none>' ? undefined : nodeId(node as string) }));
    const fromView = ofKind(m, KINDS.pod).map((p) => ({ id: p.id, status: p.status, node: p.container }));
    expect(fromView).toEqual(pods);
    // The bad image's Pods are in the comparison too.
    expect(pods.filter((p) => p.id.startsWith('k8s/Pod/default/bad-')).map((p) => p.status)).toEqual([expect.stringMatching(/^(ErrImagePull|ImagePullBackOff)$/), expect.stringMatching(/^(ErrImagePull|ImagePullBackOff)$/)]);
    const nodes = rows(session.run('kubectl get nodes').output).map(([name, status]) => ({ id: nodeId(name as string), status }));
    expect(ofKind(m, KINDS.node).map((n) => ({ id: n.id, status: n.status }))).toEqual(nodes);
    expect(nodes.find((n) => n.id === nodeId('node01'))?.status).toBe('Ready,SchedulingDisabled');
  });
});
