import { expect, test } from 'vitest';
import { UPSTREAM_SPARSE_PATHS } from './paths.ts';

// Cone-mode sparse-checkout takes directories, not patterns. A stray glob or a trailing
// slash would silently check out nothing for that entry.
test('sparse paths are plain, unique, relative directories', () => {
  for (const p of UPSTREAM_SPARSE_PATHS) {
    expect(p, p).toMatch(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/);
  }
  expect(new Set(UPSTREAM_SPARSE_PATHS).size).toBe(UPSTREAM_SPARSE_PATHS.length);
});

test('no path is nested inside another listed path', () => {
  for (const a of UPSTREAM_SPARSE_PATHS) {
    for (const b of UPSTREAM_SPARSE_PATHS) {
      expect(a !== b && a.startsWith(`${b}/`), `${a} is inside ${b}`).toBe(false);
    }
  }
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
  ]) {
    expect(UPSTREAM_SPARSE_PATHS).toContain(needed);
  }
});
