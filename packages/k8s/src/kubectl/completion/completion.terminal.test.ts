// Tab completion of kubectl typed into a terminal on the cluster (the reference capture covers
// the cases a real server shares with this one; these use what only the simulated cluster has:
// kube-system's Pods, root's kubeconfig, aliases with flags). A 120-column terminal: descriptions
// are cut at 120 - 29 - 4 columns.

import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, TOPOLOGY, type TopologyInfo, type TopologySpec } from '@simlab/kernel';
import { captureOutput, createScreen, hostPlugin, openSession } from '@simlab/host';
import { DEFAULT_APISERVER } from '../../apiserver/config.ts';
import { handle } from '../../apiserver/pipeline.ts';
import { k8sPlugin } from '../../plugin.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

function terminal() {
  const capture = captureOutput();
  const kernel = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME, ports: capture.ports });
  const spec = registry.get<TopologySpec>(TOPOLOGY, 'kubeadm-1cp-2w') as TopologySpec;
  const info = kernel.act('topology', (ctx) => spec.build(ctx, {})) as TopologyInfo;
  kernel.advance(10_000);
  kernel.act('pods', (ctx) => {
    for (const name of ['web-1', 'web-2']) {
      handle(ctx, DEFAULT_APISERVER, { verb: 'create', group: '', version: 'v1', resource: 'pods', namespace: 'default', body: { apiVersion: 'v1', kind: 'Pod', metadata: { name }, spec: { containers: [{ name: 'nginx', image: 'nginx:1.27' }] } } });
    }
  });
  const s = openSession(kernel, capture, { machine: info.entry.machine, user: info.entry.user, terminal: true, cols: 120, rows: 80 });
  const screen = createScreen(120, 80);
  screen.write(s.takeRaw());
  const keys = (data: string): void => {
    s.type(data);
    kernel.advance(10);
    screen.write(s.takeRaw());
  };
  const run = (line: string): void => {
    s.type(`${line}\r`);
    kernel.advance(1_000);
    screen.write(s.takeRaw());
  };
  const line = (): string => screen.lines()[screen.cursor.row] as string;
  return { keys, run, line, screen };
}

const PROMPT = 'root@controlplane:~# ';

describe('kubectl completion at the terminal', () => {
  test('kube-system Pods after -n, before and after the verb, and through alias k', () => {
    const t = terminal();
    t.keys('kubectl -n kube-system get pods kube-a');
    t.keys('\t');
    expect(t.line()).toBe(`${PROMPT}kubectl -n kube-system get pods kube-apiserver-controlplane`);
    t.keys('\x15kubectl get pods -n kube-system etc\t');
    expect(t.line()).toBe(`${PROMPT}kubectl get pods -n kube-system etcd-controlplane`);
    t.keys('\x15');
    t.run('alias k=kubectl');
    t.keys('k -n kube-system get pods kube-sc\t');
    expect(t.line()).toBe(`${PROMPT}k -n kube-system get pods kube-scheduler-controlplane`);
    t.keys('\x15k get po\t');
    expect(t.line()).toBe(`${PROMPT}k get pod`);
    t.keys('\x15k get pods \t');
    expect(t.line()).toBe(`${PROMPT}k get pods web-`);
    t.keys('\t\t');
    expect(t.screen.text()).toContain('\nweb-1  web-2\n');
  });

  test('an alias with flags completes as its expansion', () => {
    const t = terminal();
    t.run("alias ks='kubectl -n kube-system'");
    t.keys('ks get pods kube-c\t');
    expect(t.line()).toBe(`${PROMPT}ks get pods kube-controller-manager-controlplane`);
  });

  test('flags of get with descriptions, and -f filtered to manifests through the alias', () => {
    const t = terminal();
    t.run('alias k=kubectl; mkdir m && touch m/app.yaml m/notes.txt && cd m');
    t.keys('k get --\t\t');
    const text = t.screen.text();
    expect(text).toContain('\n--all-namespaces               (If present, list the requested object(s) across all namespaces. Namespace in current c…)\n');
    expect(text).toContain('\n--watch-only                   (Watch for changes to the requested object(s), without listing/getting first.)\n');
    t.keys('\x15k apply -f \t');
    expect(t.line()).toBe('root@controlplane:~/m# k apply -f app.yaml');
  });

  test('a word kubectl cannot complete falls back to file names (complete -o default)', () => {
    const t = terminal();
    t.run('touch notes.txt');
    t.keys('kubectl bogus not\t');
    expect(t.line()).toBe(`${PROMPT}kubectl bogus notes.txt`);
    // NoFileComp: no names, no files either.
    t.keys('\x15kubectl get pods not\t');
    expect(t.line()).toBe(`${PROMPT}kubectl get pods not`);
  });
});
