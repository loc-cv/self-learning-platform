// The three phase 09 labs against the real engine: solved by paths the reference solutions do
// not take, refused when solved the lazy way the ticket forbids, and graded without touching the
// session world (phase 09 exit criteria).

import { describe, expect, test } from 'vitest';
import { findItem } from '@simlab/content';
import { createLab, resolveParams, type Item, type Lab, type Step } from '@simlab/learn';
import { contentRegistry } from './registry.ts';

const item = (id: string): Item => {
  const f = findItem(id);
  if (!f) throw new Error(`no item ${id}`);
  return f.raw as unknown as Item;
};

/** The first seed whose parameters satisfy `want`. */
function seedWhere(it: Item, want: Record<string, unknown>): number {
  for (let s = 1; s < 200; s++) {
    const p = resolveParams(it, s);
    if (Object.entries(want).every(([k, v]) => p[k] === v)) return s;
  }
  throw new Error(`no seed with ${JSON.stringify(want)}`);
}

const statuses = (lab: Lab): Record<string, string> => Object.fromEntries(lab.check().checks.map((c) => [c.id, c.status]));
const p = (lab: Lab, k: string): string => String(lab.variant.params[k]);

describe('k8s.workloads.deployment-service-01', () => {
  const it = item('k8s.workloads.deployment-service-01');

  test('passes when solved by a path no reference solution takes', () => {
    const lab = createLab(it, contentRegistry, { seed: 3 });
    const [ns, app, replicas, port] = [p(lab, 'ns'), p(lab, 'app'), p(lab, 'replicas'), p(lab, 'port')];
    // Live objects first, one replica scaled up, the Service from expose, the file written in vim.
    const steps: Step[] = [
      { run: `kubectl -n ${ns} create deployment ${app} --image=docker.io/library/nginx:1.31.8 --port=80` },
      { run: `kubectl -n ${ns} scale deployment ${app} --replicas=${replicas}` },
      { run: `kubectl -n ${ns} expose deployment ${app} --port=${port} --target-port=80` },
      {
        run: `vim /root/${app}.yaml`,
        editor: [
          {
            write: [
              'apiVersion: v1',
              'kind: Service',
              'metadata:',
              `  name: ${app}`,
              `  namespace: ${ns}`,
              'spec:',
              '  selector:',
              `    app: ${app}`,
              '  ports:',
              `  - port: ${port}`,
              '    targetPort: http',
              '---',
              'apiVersion: apps/v1',
              'kind: Deployment',
              'metadata:',
              `  name: ${app}`,
              `  namespace: ${ns}`,
              'spec:',
              `  replicas: ${replicas}`,
              '  selector:',
              '    matchLabels:',
              `      app: ${app}`,
              '  template:',
              '    metadata:',
              '      labels:',
              `        app: ${app}`,
              '    spec:',
              '      containers:',
              '      - name: server',
              '        image: nginx:1.31.8',
              '        ports:',
              '        - name: http',
              '          containerPort: 80',
              '',
            ].join('\n'),
          },
        ],
      },
    ];
    lab.run(steps);
    const r = lab.check();
    expect(r.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(r.passed).toBe(true);
  });

  test('a file without namespaces does not rebuild the application where it belongs', () => {
    const lab = createLab(it, contentRegistry, { seed: 1 });
    const [ns, app, replicas, port] = [p(lab, 'ns'), p(lab, 'app'), p(lab, 'replicas'), p(lab, 'port')];
    lab.run([
      { run: `kubectl create deployment ${app} --image=nginx:1.31.8 --replicas=${replicas} --port=80 --dry-run=client -o yaml > /root/${app}.yaml` },
      { run: `echo --- >> /root/${app}.yaml` },
      { run: `kubectl create service clusterip ${app} --tcp=${port}:80 --dry-run=client -o yaml >> /root/${app}.yaml` },
      { run: `kubectl -n ${ns} apply -f /root/${app}.yaml` },
    ]);
    const s = statuses(lab);
    expect(s).toMatchObject({ 'deployment-spec': 'pass', 'pods-ready': 'pass', 'service-endpoints': 'pass', 'manifest-defines-both': 'pass', 'manifest-rebuilds': 'fail' });
  });

  test('a Service forwarding to the wrong port fails the traffic check', () => {
    const lab = createLab(it, contentRegistry, { seed: 2 });
    const [ns, app, replicas, port] = [p(lab, 'ns'), p(lab, 'app'), p(lab, 'replicas'), p(lab, 'port')];
    lab.run([
      { run: `kubectl -n ${ns} create deployment ${app} --image=nginx:1.31.8 --replicas=${replicas} --port=80` },
      { run: `kubectl -n ${ns} expose deployment ${app} --port=${port}` },
    ]);
    const r = lab.check();
    const traffic = r.checks.find((c) => c.id === 'service-reaches-pods');
    expect(traffic?.status).toBe('fail');
    expect(traffic?.observed).toContain(port);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });
});

describe('k8s.scheduling.pending-pods-01: the lazy fixes fail', () => {
  const it = item('k8s.scheduling.pending-pods-01');

  test('removing the taint from the node', () => {
    const lab = createLab(it, contentRegistry, { seed: seedWhere(it, { cause: 'taint' }) });
    lab.run([{ run: `kubectl edit node ${p(lab, 'ssdNode')}`, editor: [{ replace: { from: `  taints:\n  - effect: NoSchedule\n    key: dedicated\n    value: ${p(lab, 'ns')}\n`, to: '' } }] }]);
    expect(statuses(lab)).toMatchObject({ 'pods-ready': 'pass', 'ssd-only': 'pass', 'nodes-unchanged': 'fail' });
  });

  test('dropping the node selector, and tolerating everything', () => {
    const lab = createLab(it, contentRegistry, { seed: seedWhere(it, { cause: 'taint' }) });
    lab.run([{ run: `kubectl -n ${p(lab, 'ns')} edit deployment ${p(lab, 'app')}`, editor: [{ replace: { from: '      nodeSelector:\n        disktype: ssd\n', to: '      tolerations:\n      - operator: Exists\n' } }] }]);
    expect(statuses(lab)).toMatchObject({ 'pods-ready': 'pass', 'ssd-only': 'fail', 'nodes-unchanged': 'pass' });
  });

  test('relabelling the node to match the typo', () => {
    const lab = createLab(it, contentRegistry, { seed: seedWhere(it, { cause: 'selector' }) });
    lab.run([{ run: `kubectl label node ${p(lab, 'ssdNode')} disktype=SSD --overwrite` }]);
    expect(statuses(lab)).toMatchObject({ 'pods-ready': 'pass', 'nodes-unchanged': 'fail' });
  });

  test('removing the memory request', () => {
    const lab = createLab(it, contentRegistry, { seed: seedWhere(it, { cause: 'memory' }) });
    lab.run([{ run: `kubectl -n ${p(lab, 'ns')} edit deployment ${p(lab, 'app')}`, editor: [{ replace: { from: '        resources:\n          requests:\n            memory: 8Gi\n', to: '        resources: {}\n' } }] }]);
    expect(statuses(lab)).toMatchObject({ 'pods-ready': 'pass', 'ssd-only': 'pass', 'memory-request': 'fail' });
  });

  test('deleting the Deployment and creating it again', () => {
    const lab = createLab(it, contentRegistry, { seed: seedWhere(it, { cause: 'memory' }) });
    const [ns, app] = [p(lab, 'ns'), p(lab, 'app')];
    const manifest = [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      `  name: ${app}`,
      `  namespace: ${ns}`,
      'spec:',
      `  replicas: ${p(lab, 'replicas')}`,
      '  selector:',
      '    matchLabels:',
      `      app: ${app}`,
      '  template:',
      '    metadata:',
      '      labels:',
      `        app: ${app}`,
      '    spec:',
      '      nodeSelector:',
      '        disktype: ssd',
      '      containers:',
      `      - name: ${app}`,
      '        image: nginx:1.31.8',
      '        resources:',
      '          requests:',
      '            memory: 256Mi',
      '',
    ].join('\n');
    lab.run([{ run: `kubectl -n ${ns} delete deployment ${app}` }, { write: { path: '/root/d.yaml', content: manifest } }, { run: 'kubectl create -f /root/d.yaml' }]);
    expect(statuses(lab)).toMatchObject({ 'pods-ready': 'pass', 'deployment-kept': 'fail' });
  });
});

describe('k8s.troubleshooting.broken-rollout-01', () => {
  const it = item('k8s.troubleshooting.broken-rollout-01');

  test('passes when solved by a path no reference solution takes', () => {
    const lab = createLab(it, contentRegistry, { seed: seedWhere(it, { badImage: 'registry' }) });
    const [ns, app] = [p(lab, 'ns'), p(lab, 'app')];
    lab.run([
      { run: `kubectl -n ${ns} edit deployment ${app}`, editor: [{ replace: { from: 'image: mirror.corp.example/library/nginx:1.31.8', to: 'image: docker.io/library/nginx:1.31.8' } }] },
      { run: `kubectl -n ${ns} label service ${app} tier=web` },
      {
        write: {
          path: '/root/svc.yaml',
          content: `apiVersion: v1\nkind: Service\nmetadata:\n  name: ${app}\n  namespace: ${ns}\nspec:\n  selector:\n    app: ${app}\n  ports:\n  - port: 80\n    targetPort: 80\n`,
        },
      },
      { run: 'kubectl apply -f /root/svc.yaml' },
    ]);
    const r = lab.check();
    expect(r.checks.filter((c) => c.status !== 'pass')).toEqual([]);
  });

  test('rolling back restores traffic but not the release', () => {
    const lab = createLab(it, contentRegistry, { seed: seedWhere(it, { badImage: 'tag' }) });
    const [ns, app] = [p(lab, 'ns'), p(lab, 'app')];
    lab.run([
      { run: `kubectl -n ${ns} rollout undo deployment/${app}` },
      { run: `kubectl -n ${ns} edit service ${app}`, editor: [{ replace: { from: `app.kubernetes.io/name: ${app}`, to: `app: ${app}` } }] },
    ]);
    expect(statuses(lab)).toMatchObject({ 'rollout-complete': 'pass', 'service-endpoints': 'pass', 'runs-release': 'fail' });
  });

  test('recreating the Service is refused', () => {
    const lab = createLab(it, contentRegistry, { seed: seedWhere(it, { badImage: 'name' }) });
    const [ns, app] = [p(lab, 'ns'), p(lab, 'app')];
    lab.run([
      { run: `kubectl -n ${ns} set image deployment/${app} ${app}=nginx:1.31.8` },
      { run: `kubectl -n ${ns} delete service ${app}` },
      { run: `kubectl -n ${ns} expose deployment ${app} --port=80` },
    ]);
    expect(statuses(lab)).toMatchObject({ 'rollout-complete': 'pass', 'service-endpoints': 'pass', 'service-kept': 'fail', 'deployment-kept': 'pass' });
  });

  test('checks do not mutate the session world', () => {
    const lab = createLab(it, contentRegistry, { seed: 1 });
    // Half a fix, so some checks pass and some wait out their `within` on their forks.
    lab.run([{ run: `kubectl -n ${p(lab, 'ns')} set image deployment/${p(lab, 'app')} ${p(lab, 'app')}=nginx:1.31.8` }]);
    lab.kernel.advance(5000);
    const hash = lab.kernel.hash();
    const now = lab.kernel.now;
    const first = lab.check();
    expect(lab.kernel.hash()).toBe(hash);
    expect(lab.kernel.now).toBe(now);
    expect(lab.check()).toEqual(first);
  });
});
