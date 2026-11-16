// Tab completion of kubectl in a terminal, key by key, against the real bash running kubectl's
// completion script with the real kubectl (fixtures/reference/bash/kubectl-completion.json, from
// kubectl-completion.py): after each key the screen must be the same (as the host's
// editor.reference.test.ts compares them; the order of a bell and the redraw bytes are not seen).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, TOPOLOGY, type TopologyInfo, type TopologySpec } from '@simlab/kernel';
import { captureOutput, createScreen, hostPlugin, openSession } from '@simlab/host';
import { DEFAULT_APISERVER } from '../../apiserver/config.ts';
import { handle } from '../../apiserver/pipeline.ts';
import { k8sPlugin } from '../../plugin.ts';

interface Case {
  name: string;
  cols: number;
  rows: number;
  keys: string[];
  outputs: string[];
}

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../fixtures/reference/bash/kubectl-completion.json'), 'utf8')) as { cases: Case[] };

const registry = createRegistry([hostPlugin, k8sPlugin]);

const PROMPT = 'student@node01:~$ ';
// The capture's setup without what the simulator does by itself (bash-completion, the script).
const SETUP = `PS1='${PROMPT}'; alias k=kubectl; mkdir work && cd work && touch a.yaml b.yml c.json notes.txt Upper.YAML mixed.Yaml dot. && mkdir dir; clear\r`;

const pod = (name: string, namespace: string) => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace }, spec: { containers: [{ name: 'nginx', image: 'nginx:1.27' }] } });

function terminal(cols: number, rows: number) {
  const capture = captureOutput();
  const kernel = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME, ports: capture.ports });
  const spec = registry.get<TopologySpec>(TOPOLOGY, 'kubeadm-1cp-2w') as TopologySpec;
  const info = kernel.act('topology', (ctx) => spec.build(ctx, {})) as TopologyInfo;
  kernel.advance(10_000);
  kernel.act('objects', (ctx) => {
    const create = (group: string, version: string, resource: string, namespace: string | undefined, body: object) =>
      handle(ctx, DEFAULT_APISERVER, { verb: 'create', group, version, resource, ...(namespace ? { namespace } : {}), body: body as never });
    create('', 'v1', 'namespaces', undefined, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'team-a' } });
    for (const n of ['web-1', 'web-2', 'api']) create('', 'v1', 'pods', 'default', pod(n, 'default'));
    for (const n of ['db', 'cache']) create('', 'v1', 'pods', 'team-a', pod(n, 'team-a'));
    create('apps', 'v1', 'deployments', 'default', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'frontend', namespace: 'default' },
      spec: { replicas: 0, selector: { matchLabels: { app: 'frontend' } }, template: { metadata: { labels: { app: 'frontend' } }, spec: { containers: [{ name: 'nginx', image: 'nginx:1.27' }] } } },
    });
  });
  const s = openSession(kernel, capture, { machine: info.entry.machine, user: info.entry.user, terminal: true, cols, rows });
  s.takeRaw();
  s.type(SETUP);
  kernel.advance(2_000);
  const out = s.takeRaw();
  if (!out.endsWith(PROMPT)) throw new Error(`setup did not end at the prompt: ${JSON.stringify(out.slice(-200))}`);
  const key = (k: string): string => {
    s.type(k);
    kernel.advance(10);
    return s.takeRaw();
  };
  return { key };
}

describe('kubectl completion in bash, key by key (reference capture)', () => {
  for (const c of fixture.cases) {
    test(c.name, () => {
      const t = terminal(c.cols, c.rows);
      // Both start right after `clear`: the prompt alone at the top.
      const real = createScreen(c.cols, c.rows);
      const ours = createScreen(c.cols, c.rows);
      real.write(PROMPT);
      ours.write(PROMPT);
      c.keys.forEach((k, i) => {
        real.write(c.outputs[i] as string);
        ours.write(t.key(k));
        const where = `after key ${i} ${JSON.stringify(k)}`;
        expect(ours.lines(), where).toEqual(real.lines());
        expect(ours.cursor, where).toEqual(real.cursor);
      });
    });
  }
});
