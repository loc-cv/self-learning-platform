// The view contract, the renderer, the X-ray pane, its timeline, the trace in words, the replay and figures know no domain (hard rule 8, PLAN.md §6.5):
// no word of a Kubernetes concept appears in their code or comments. Kind names, scope names and
// the words of states reach them only through the view model.

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);
const FILES = [
  'packages/kernel/src/view.ts',
  'apps/web/src/view/layout.ts',
  'apps/web/src/view/filter.ts',
  'apps/web/src/view/ViewCanvas.tsx',
  'apps/web/src/app/XRay.tsx',
  'apps/web/src/app/Figure.tsx',
  'apps/web/src/app/Timeline.tsx',
  'apps/web/src/app/timeline.ts',
  'apps/web/src/app/Trace.tsx',
  'apps/web/src/app/Replay.tsx',
  'packages/learn/src/figure/types.ts',
  'packages/learn/src/figure/focus.ts',
  'packages/learn/src/figure/render.ts',
  'packages/learn/src/figure/blocks.ts',
];

/** Kubernetes words; `container` is left out: in the contract it means "what contains an entity". */
const WORDS = /\b(pods?|nodes?|deployments?|replica ?sets?|stateful ?sets?|daemon ?sets?|namespaces?|services?|endpoint ?slices?|kubelet|kubectl|kubeadm|kubernetes|k8s|taints?|tolerations?|ingress(es)?|config ?maps?|secrets?|cronjobs?|etcd|scheduler)\b/gi;

test.each(FILES)('%s names no Kubernetes concept', (file) => {
  const text = readFileSync(new URL(file, ROOT), 'utf8');
  const hits = text.split('\n').flatMap((line, i) => [...line.matchAll(WORDS)].map((m) => `${i + 1}: ${m[0]}`));
  expect(hits).toEqual([]);
});

test('the check finds a Kubernetes word', () => {
  expect('a Pod on its Node'.match(WORDS)).toEqual(['Pod', 'Node']);
});
