// `kubectl get` tables against the real v1.37.2 output: each case's setup replayed on the
// simulated kubeadm-1cp-2w topology in virtual time, the Table requested from the simulated API
// server as kubectl requests it (as=Table, includeObject unset), printed with kubectl's table
// printer, normalized like the capture and compared with the fixture's stdout.
//
// What kubectl itself sends for the setup commands is written out here (fixtures/golden/v1.37.2/
// client/generators.yaml); the get command arrives in phase 07a alongside these printers, and the
// differential runner over whole cases replaces this file's focused comparisons.
//
// Oracle limits (docs/FIDELITY.md §6.5, §6.6): Pod and Node status of the captures is KWOK's, and
// kube-system had no workloads. The simulated cluster runs CoreDNS, kube-proxy and the control
// plane's mirror Pods, so `-A` is compared over the case's namespace, and the scheduling cases
// remove CoreDNS first as tools/src/golden/scheduling.test.ts does.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { bootKernel, createRegistry, DEFAULT_START_TIME, TOPOLOGY, type Kernel, type TopologySpec } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { createTablePrinter, DEFAULT_APISERVER, handle, k8sPlugin, type ApiRequest, type PrintOptions } from '@simlab/k8s';
import { repoRoot } from '../oracle/paths.ts';
import { newContext, normalizeText, type NormalizeContext } from './normalize.ts';

type Obj = Record<string, unknown>;
// The Json type of @simlab/kernel; request bodies are plain JSON literals.
type Body = NonNullable<ApiRequest['body']>;

const registry = createRegistry([hostPlugin, k8sPlugin]);
const FIXTURES = join(repoRoot, 'fixtures/golden/v1.37.2');

interface Step {
  run?: string;
  stdout?: string;
  anyWorker?: boolean;
}

function fixture(name: string): Step[] {
  return (parse(readFileSync(join(FIXTURES, `${name}.yaml`), 'utf8')) as { steps: Step[] }).steps;
}

function expected(steps: Step[], run: string): Step {
  const s = steps.find((x) => x.run === run);
  if (!s || s.stdout === undefined) throw new Error(`no step ${run}`);
  return s;
}

function boot(): Kernel {
  const k = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME });
  const spec = registry.get<TopologySpec>(TOPOLOGY, 'kubeadm-1cp-2w');
  if (!spec) throw new Error('no topology kubeadm-1cp-2w');
  k.act('topology', (ctx) => spec.build(ctx, {}));
  k.advance(5_000);
  return k;
}

function call(k: Kernel, req: ApiRequest): Obj {
  const r = k.act('kubectl', (ctx) => handle(ctx, DEFAULT_APISERVER, req));
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.object as Obj;
}

const create = (k: Kernel, gvr: string, namespace: string | undefined, body: Obj): Obj => {
  const [group, version, resource] = gvr.split('/').length === 2 ? ['', ...gvr.split('/')] : gvr.split('/');
  return call(k, { verb: 'create', group: group as string, version: version as string, resource: resource as string, ...(namespace ? { namespace } : {}), body: body as Body });
};

/** What `kubectl create deployment NAME --image=IMAGE --replicas=N [--port=P]` sends. */
function createDeployment(k: Kernel, name: string, image: string, replicas: number, port?: number): void {
  const container: Obj = { name: image.replace(/[:@].*$/, '').replace(/^.*\//, ''), image, ...(port ? { ports: [{ containerPort: port }] } : {}), resources: {} };
  create(k, 'apps/v1/deployments', 'default', {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, labels: { app: name } },
    spec: { replicas, selector: { matchLabels: { app: name } }, strategy: {}, template: { metadata: { labels: { app: name } }, spec: { containers: [container] } } },
  });
}

/** What `kubectl run NAME --image=IMAGE [--labels=…]` sends (run.go: the run label unless --labels). */
function runPod(k: Kernel, name: string, image: string, opts: { labels?: Obj; namespace?: string; overrides?: Obj; args?: string[] } = {}): void {
  const spec: Obj = { containers: [{ name, image, ...(opts.args ? { args: opts.args } : {}), resources: {} }], dnsPolicy: 'ClusterFirst', restartPolicy: 'Always', ...opts.overrides };
  create(k, 'v1/pods', opts.namespace ?? 'default', { apiVersion: 'v1', kind: 'Pod', metadata: { name, labels: opts.labels ?? { run: name } }, spec });
}

type Get = { gvr: string; namespace?: string; name?: string; fieldSelector?: string; labelSelector?: string };

/** The Table kubectl asks for (get.go transformRequests: as=Table, no includeObject). */
function getTable(k: Kernel, g: Get): Obj {
  const parts = g.gvr.split('/');
  const [group, version, resource] = parts.length === 2 ? ['', ...parts] : parts;
  const options = { as: 'Table' as const, ...(g.fieldSelector ? { fieldSelector: g.fieldSelector } : {}), ...(g.labelSelector ? { labelSelector: g.labelSelector } : {}) };
  return call(k, {
    verb: g.name ? 'get' : 'list',
    group: group as string,
    version: version as string,
    resource: resource as string,
    ...(g.namespace ? { namespace: g.namespace } : {}),
    ...(g.name ? { name: g.name } : {}),
    options,
  });
}

const OPTS: PrintOptions = { noHeaders: false, withNamespace: false, withKind: false, wide: false, showLabels: false, kind: { group: '', kind: '' }, columnLabels: [] };

/**
 * The get command's printing loop for several resources (get.go Run): one printer per resource,
 * flushed when the resource changes, a blank line before the next table once something was written.
 */
function print(parts: { table: Obj; opts: Partial<PrintOptions> }[]): string {
  let out = '';
  for (const p of parts) {
    const pr = createTablePrinter({ ...OPTS, ...p.opts });
    pr.add(p.table as never);
    const text = pr.flush();
    if (text !== '' && out !== '' && !p.opts.noHeaders) out += '\n';
    out += text;
  }
  return out;
}

/** `ageColumns` is the case's (fixtures/golden/cases/…): the captured step does not repeat it. */
function compare(steps: Step[], run: string, text: string, ctx: NormalizeContext = newContext(), ageColumns?: number[]): void {
  const s = expected(steps, run);
  if (s.anyWorker) ctx.anyWorker = true;
  ctx.ageColumns = ageColumns;
  expect(normalizeText(text, ctx, 'get'), run).toBe(s.stdout);
  ctx.anyWorker = false;
  ctx.ageColumns = undefined;
}

const POD = { group: '', kind: 'Pod' };

describe('kubectl get tables against the golden captures', () => {
  test('deployments/create-and-read: deployments, replica sets, pods, get all', () => {
    const steps = fixture('deployments/create-and-read');
    const k = boot();
    createDeployment(k, 'web', 'nginx:1.27', 3);
    k.advance(120_000);
    const ctx = newContext();
    const deploy = { gvr: 'apps/v1/deployments', namespace: 'default' };
    const rs = { gvr: 'apps/v1/replicasets', namespace: 'default' };
    const pods = { gvr: 'v1/pods', namespace: 'default' };
    const DEPLOY = { group: 'apps', kind: 'Deployment' };
    const RS = { group: 'apps', kind: 'ReplicaSet' };
    compare(steps, 'kubectl get deployments', print([{ table: getTable(k, deploy), opts: { kind: DEPLOY } }]), ctx);
    compare(steps, 'kubectl get deploy -o wide', print([{ table: getTable(k, deploy), opts: { kind: DEPLOY, wide: true } }]), ctx);
    compare(steps, 'kubectl get rs', print([{ table: getTable(k, rs), opts: { kind: RS } }]), ctx);
    compare(steps, 'kubectl get rs -o wide', print([{ table: getTable(k, rs), opts: { kind: RS, wide: true } }]), ctx);
    compare(steps, 'kubectl get pods -o wide', print([{ table: getTable(k, pods), opts: { kind: POD, wide: true } }]), ctx);
    compare(steps, 'kubectl get pods --show-labels', print([{ table: getTable(k, pods), opts: { kind: POD, showLabels: true } }]), ctx);
    // `all` in the default namespace: the served members of the category that have objects.
    const all = [
      { table: getTable(k, pods), opts: { kind: POD, withKind: true } },
      { table: getTable(k, { gvr: 'v1/services', namespace: 'default' }), opts: { kind: { group: '', kind: 'Service' }, withKind: true } },
      { table: getTable(k, { gvr: 'apps/v1/daemonsets', namespace: 'default' }), opts: { kind: { group: 'apps', kind: 'DaemonSet' }, withKind: true } },
      { table: getTable(k, deploy), opts: { kind: DEPLOY, withKind: true } },
      { table: getTable(k, rs), opts: { kind: RS, withKind: true } },
    ];
    compare(steps, 'kubectl get all', print(all), ctx);
  });

  test('pods/run: one Pod, wide, labels, selector, --no-headers', () => {
    const steps = fixture('pods/run');
    const k = boot();
    runPod(k, 'nginx', 'nginx:1.27', { labels: { app: 'web' } });
    k.advance(60_000);
    const pods = { gvr: 'v1/pods', namespace: 'default' };
    compare(steps, 'kubectl get pods', print([{ table: getTable(k, pods), opts: { kind: POD } }]));
    compare(steps, 'kubectl get pods -o wide', print([{ table: getTable(k, pods), opts: { kind: POD, wide: true } }]));
    compare(steps, 'kubectl get pods --show-labels', print([{ table: getTable(k, pods), opts: { kind: POD, showLabels: true } }]));
    compare(steps, 'kubectl get pods -l app=web', print([{ table: getTable(k, { ...pods, labelSelector: 'app=web' }), opts: { kind: POD } }]));
    compare(steps, 'kubectl get po nginx --no-headers', print([{ table: getTable(k, { ...pods, name: 'nginx' }), opts: { kind: POD, noHeaders: true } }]), newContext(), [4]);
    // An empty list prints nothing; the get command then writes "No resources found …" to stderr.
    expect(print([{ table: getTable(k, { ...pods, labelSelector: 'app=nothing' }), opts: { kind: POD } }])).toBe('');
  });

  test('services/clusterip-and-nodeport: services, endpoints, endpoint slices', () => {
    const steps = fixture('services/clusterip-and-nodeport');
    const k = boot();
    createDeployment(k, 'web', 'nginx:1.27', 2, 80);
    k.advance(120_000);
    // kubectl expose deployment web --port=80 --target-port=80
    create(k, 'v1/services', 'default', { apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', labels: { app: 'web' } }, spec: { ports: [{ port: 80, protocol: 'TCP', targetPort: 80 }], selector: { app: 'web' } } });
    create(k, 'v1/services', 'default', { apiVersion: 'v1', kind: 'Service', metadata: { name: 'web-np' }, spec: { type: 'NodePort', selector: { app: 'web' }, ports: [{ port: 80, targetPort: 80, nodePort: 30080 }] } });
    // kubectl create service nodeport auto --tcp=8080:80
    create(k, 'v1/services', 'default', { apiVersion: 'v1', kind: 'Service', metadata: { name: 'auto', labels: { app: 'auto' } }, spec: { ports: [{ name: '8080-80', port: 8080, protocol: 'TCP', targetPort: 80 }], selector: { app: 'auto' }, type: 'NodePort' } });
    k.advance(10_000);
    const ctx = newContext({ literals: new Set(['30080']) });
    const SVC = { group: '', kind: 'Service' };
    const svc = { gvr: 'v1/services', namespace: 'default' };
    compare(steps, 'kubectl get services', print([{ table: getTable(k, svc), opts: { kind: SVC } }]), ctx);
    compare(steps, 'kubectl get svc -o wide', print([{ table: getTable(k, svc), opts: { kind: SVC, wide: true } }]), ctx);
    compare(steps, 'kubectl get endpoints', print([{ table: getTable(k, { gvr: 'v1/endpoints', namespace: 'default' }), opts: { kind: { group: '', kind: 'Endpoints' } } }]), ctx);
    compare(steps, 'kubectl get endpointslices', print([{ table: getTable(k, { gvr: 'discovery.k8s.io/v1/endpointslices', namespace: 'default' }), opts: { kind: { group: 'discovery.k8s.io', kind: 'EndpointSlice' } } }]), ctx);
  });

  test('configmaps/create-and-read: data counts, -o wide adds nothing', () => {
    const steps = fixture('configmaps/create-and-read');
    const k = boot();
    // kubectl create configmap app-config --from-literal=LOG_LEVEL=debug --from-literal=PORT=8080; … files --from-file=app.properties
    create(k, 'v1/configmaps', 'default', { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'app-config' }, data: { LOG_LEVEL: 'debug', PORT: '8080' } });
    create(k, 'v1/configmaps', 'default', { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'files' }, data: { 'app.properties': 'color=blue\nsize=large\n' } });
    // The root-ca-certificate-publisher controller is not simulated yet; its ConfigMap stands in.
    create(k, 'v1/configmaps', 'default', { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'kube-root-ca.crt' }, data: { 'ca.crt': 'stand-in' } });
    k.advance(1_000);
    const CM = { group: '', kind: 'ConfigMap' };
    const cm = { gvr: 'v1/configmaps', namespace: 'default' };
    compare(steps, 'kubectl get configmaps', print([{ table: getTable(k, cm), opts: { kind: CM } }]));
    compare(steps, 'kubectl get cm -o wide', print([{ table: getTable(k, cm), opts: { kind: CM, wide: true } }]));
  });

  test('namespaces/create-and-read: namespaces, labels, a namespace column', () => {
    const steps = fixture('namespaces/create-and-read');
    const k = boot();
    create(k, 'v1/namespaces', undefined, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'dev' } });
    runPod(k, 'probe', 'busybox:1.37', { namespace: 'dev', overrides: { nodeSelector: { 'kubernetes.io/hostname': 'node02' } }, args: ['sleep', '3600'] });
    k.advance(60_000);
    const NS = { group: '', kind: 'Namespace' };
    compare(steps, 'kubectl get namespaces', print([{ table: getTable(k, { gvr: 'v1/namespaces' }), opts: { kind: NS } }]));
    compare(steps, 'kubectl get ns --show-labels', print([{ table: getTable(k, { gvr: 'v1/namespaces' }), opts: { kind: NS, showLabels: true } }]));
    const dev = { gvr: 'v1/pods', namespace: 'dev' };
    compare(steps, 'kubectl get pods -n dev', print([{ table: getTable(k, dev), opts: { kind: POD } }]));
    // -A lists every namespace; the oracle had Pods only in dev (kube-system held no workloads).
    compare(steps, 'kubectl get pods -A', print([{ table: getTable(k, dev), opts: { kind: POD, withNamespace: true } }]));
    compare(steps, 'kubectl get pods --all-namespaces -o wide', print([{ table: getTable(k, dev), opts: { kind: POD, withNamespace: true, wide: true } }]));
  });

  test('nodes/read: nodes, wide, labels', () => {
    const steps = fixture('nodes/read');
    const k = boot();
    const NODE = { group: '', kind: 'Node' };
    const nodes = { gvr: 'v1/nodes' };
    compare(steps, 'kubectl get nodes', print([{ table: getTable(k, nodes), opts: { kind: NODE } }]));
    compare(steps, 'kubectl get nodes -o wide', print([{ table: getTable(k, nodes), opts: { kind: NODE, wide: true } }]));
    compare(steps, 'kubectl get nodes --show-labels', print([{ table: getTable(k, nodes), opts: { kind: NODE, showLabels: true } }]));
  });

  test('scheduling/cordoned: FailedScheduling and Scheduled events, -o wide', () => {
    const steps = fixture('scheduling/cordoned');
    const k = boot();
    // Without CoreDNS, as the oracle's cluster (see scheduling.test.ts).
    call(k, { verb: 'delete', group: 'apps', version: 'v1', resource: 'deployments', namespace: 'kube-system', name: 'coredns' });
    k.advance(5_000);
    const patchNode = (name: string, unschedulable: boolean | null) => call(k, { verb: 'patch', group: '', version: 'v1', resource: 'nodes', name, body: { spec: { unschedulable } }, options: { patchType: 'merge' } });
    patchNode('node01', true);
    patchNode('node02', true);
    k.advance(2_000);
    runPod(k, 'waits', 'nginx:1.27');
    k.advance(2_000);
    const EV = { group: '', kind: 'Event' };
    const failed = { gvr: 'v1/events', namespace: 'default', fieldSelector: 'reason=FailedScheduling' };
    compare(steps, 'kubectl get events --field-selector reason=FailedScheduling', print([{ table: getTable(k, failed), opts: { kind: EV } }]));
    compare(steps, 'kubectl get events --field-selector reason=FailedScheduling -o wide', print([{ table: getTable(k, failed), opts: { kind: EV, wide: true } }]));
    compare(steps, 'kubectl get pod waits', print([{ table: getTable(k, { gvr: 'v1/pods', namespace: 'default', name: 'waits' }), opts: { kind: POD } }]));
    patchNode('node01', null);
    k.advance(2_000);
    // KWOK writes no kubelet events (FIDELITY §6.5): the simulated kubelet's are selected out.
    const kubelet = ['Pulling', 'Pulled', 'Created', 'Started'].map((r) => `reason!=${r}`).join(',');
    const waits = { gvr: 'v1/events', namespace: 'default', fieldSelector: `involvedObject.name=waits,${kubelet}` };
    compare(steps, 'kubectl get events --field-selector involvedObject.name=waits', print([{ table: getTable(k, waits), opts: { kind: EV } }]));
    compare(steps, 'kubectl get events --field-selector involvedObject.name=waits -o wide', print([{ table: getTable(k, waits), opts: { kind: EV, wide: true } }]));
  });
});
