import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { packageName } from './index.ts';

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as Manifest;

// PLAN.md §6 dependency rule. The lint rule simlab/package-boundaries guards imports;
// this guards the manifest, which is what npm actually links.
const allowed: string[] = ["@simlab/kernel","@simlab/host","@simlab/k8s","@simlab/learn","@simlab/content"];

test('entry point is published under the manifest name', () => {
  expect(packageName).toBe(manifest.name);
});

test('workspace dependencies stay inside the allowed set', () => {
  const workspaceDeps = Object.keys(manifest.dependencies ?? {}).filter((d) =>
    d.startsWith('@simlab/'),
  );
  expect(workspaceDeps.filter((d) => !allowed.includes(d))).toEqual([]);
});
