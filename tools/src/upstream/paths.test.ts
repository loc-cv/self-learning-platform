import { expect, test } from 'vitest';
import { KUBERNETES_TAG } from '@simlab/k8s';
import { CONTAINERD_TAG, KUBERNETES_CHECKOUT, UPSTREAM_CHECKOUTS } from './paths.ts';

test('checkouts have unique names that are plain directory names', () => {
  const names = UPSTREAM_CHECKOUTS.map((c) => c.name);
  for (const name of names) expect(name).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
  expect(new Set(names).size).toBe(names.length);
});

test('each checkout is an https repository at a tag', () => {
  for (const { name, repo, tag } of UPSTREAM_CHECKOUTS) {
    expect(repo, name).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
    expect(tag, name).toMatch(/^[\w.-]+$/);
  }
});

// Cone-mode sparse-checkout takes directories, not patterns. A stray glob or a trailing
// slash would silently check out nothing for that entry.
test.each(UPSTREAM_CHECKOUTS.map((c) => [c.name, c.paths] as const))(
  '%s: sparse paths are plain, unique, relative directories',
  (_name, paths) => {
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p, p).toMatch(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/);
    expect(new Set(paths).size).toBe(paths.length);
  },
);

test.each(UPSTREAM_CHECKOUTS.map((c) => [c.name, c.paths] as const))(
  '%s: no path is nested inside another listed path',
  (_name, paths) => {
    for (const a of paths) {
      for (const b of paths) {
        expect(a !== b && a.startsWith(`${b}/`), `${a} is inside ${b}`).toBe(false);
      }
    }
  },
);

test('a checkout named by pinnedBy exists and is fetched before the one it pins', () => {
  UPSTREAM_CHECKOUTS.forEach(({ name, pinnedBy }, i) => {
    if (pinnedBy === undefined) return;
    const j = UPSTREAM_CHECKOUTS.findIndex((c) => c.name === pinnedBy.checkout);
    expect(j, `${name} is pinned by ${pinnedBy.checkout}`).toBeGreaterThanOrEqual(0);
    expect(j, `${pinnedBy.checkout} comes before ${name}`).toBeLessThan(i);
  });
});

test('kubernetes is checked out at the pin, containerd at the nodes’ runtime version', () => {
  expect(KUBERNETES_CHECKOUT.tag).toBe(KUBERNETES_TAG);
  expect(CONTAINERD_TAG).toMatch(/^v\d+\.\d+\.\d+$/);
  expect(UPSTREAM_CHECKOUTS.find((c) => c.name === 'containerd')?.tag).toBe(CONTAINERD_TAG);
});

test('covers what the phase prompts say later phases read', () => {
  for (const needed of [
    'staging/src/k8s.io/kubectl',
    'pkg/printers',
    'staging/src/k8s.io/api',
    'pkg/apis',
    'api/openapi-spec',
    'pkg/scheduler',
    'pkg/kubelet',
    'pkg/controller',
    'staging/src/k8s.io/cri-api',
  ]) {
    expect(KUBERNETES_CHECKOUT.paths).toContain(needed);
  }
});
