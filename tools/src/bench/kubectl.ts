// Wall-clock latency of `kubectl get` from Enter to the prompt on the default topology
// (PLAN.md §2: p95 under 50 ms for read commands; phase 07a exit criterion, recorded in
// docs/ARCHITECTURE.md §4.9). A three-replica Deployment runs; each command is typed into a login
// shell of root on the control plane and timed until the shell is back at its prompt.
// Run: npm run bench:kubectl [-- --runs N]

import { performance } from 'node:perf_hooks';
import { bootKernel, createRegistry, DEFAULT_START_TIME, TOPOLOGY, type TopologyInfo, type TopologySpec } from '@simlab/kernel';
import { captureOutput, hostPlugin, openSession } from '@simlab/host';
import { createClient, DEFAULT_APISERVER, k8sPlugin } from '@simlab/k8s';

const arg = process.argv.indexOf('--runs');
const runs = arg > 0 ? Number(process.argv[arg + 1]) : 200;

const registry = createRegistry([hostPlugin, k8sPlugin]);
const capture = captureOutput();
const kernel = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME, ports: capture.ports });
const spec = registry.get<TopologySpec>(TOPOLOGY, 'kubeadm-1cp-2w') as TopologySpec;
const info = kernel.act('topology', (ctx) => spec.build(ctx, {})) as TopologyInfo;
kernel.advance(5_000);
kernel.act('deployment', (ctx) =>
  createClient(ctx, DEFAULT_APISERVER)
    .resource('apps/v1/deployments')
    .create('default', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'web', labels: { app: 'web' } },
      spec: { replicas: 3, selector: { matchLabels: { app: 'web' } }, template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'nginx', image: 'nginx:1.27' }] } } },
    }),
);
kernel.advance(30_000);
const session = openSession(kernel, capture, { machine: info.entry.machine, user: info.entry.user });

const COMMANDS = ['kubectl get pods', 'kubectl get pods -o wide', 'kubectl get pods -A', 'kubectl get all', 'kubectl get deployment web -o yaml', 'kubectl get nodes'];

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number;
};

const all: number[] = [];
console.log(`kubectl get latency, ${runs} runs each (ms)`);
console.log('command'.padEnd(36), 'p50'.padStart(7), 'p95'.padStart(7), 'max'.padStart(7));
for (const cmd of COMMANDS) {
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = session.run(cmd);
    t.push(performance.now() - t0);
    if (r.status !== 0) throw new Error(`${cmd}: exit ${r.status}: ${r.output}`);
  }
  all.push(...t);
  console.log(cmd.padEnd(36), pct(t, 50).toFixed(2).padStart(7), pct(t, 95).toFixed(2).padStart(7), Math.max(...t).toFixed(2).padStart(7));
}
console.log('all'.padEnd(36), pct(all, 50).toFixed(2).padStart(7), pct(all, 95).toFixed(2).padStart(7), Math.max(...all).toFixed(2).padStart(7));
