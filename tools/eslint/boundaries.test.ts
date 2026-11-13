import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ENGINE_PACKAGES, WORKSPACES, workspaceOf } from './boundaries.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

test('every workspace in the table exists and is named as the table says', () => {
  for (const [root, { name }] of Object.entries(WORKSPACES)) {
    const manifestPath = path.join(repoRoot, root, 'package.json');
    expect(existsSync(manifestPath), manifestPath).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string };
    expect(manifest.name).toBe(`@simlab/${name}`);
  }
});

test('the graph is the one PLAN.md §6 draws', () => {
  expect(WORKSPACES['packages/kernel']?.allowed).toEqual([]);
  expect(WORKSPACES['packages/host']?.allowed).toEqual(['kernel']);
  expect(WORKSPACES['packages/learn']?.allowed).toEqual(['kernel']);
  // No package may import an app or the tools.
  const appsAndTools = ['web', 'server', 'cli', 'tools'];
  for (const { allowed } of Object.values(WORKSPACES)) {
    expect(allowed.filter((a) => appsAndTools.includes(a))).toEqual([]);
  }
  // The core stays domain-agnostic (CLAUDE.md hard rule 8).
  for (const core of ['packages/kernel', 'packages/host', 'packages/learn']) {
    expect(WORKSPACES[core]?.allowed).not.toContain('k8s');
  }
});

test('engine packages are workspaces under packages/', () => {
  for (const name of ENGINE_PACKAGES) expect(WORKSPACES[`packages/${name}`]?.name).toBe(name);
});

test('workspaceOf maps files to their workspace', () => {
  expect(workspaceOf('packages/k8s/src/kubectl/get.ts')).toBe('packages/k8s');
  expect(workspaceOf('tools/src/upstream/fetch.ts')).toBe('tools');
  expect(workspaceOf('eslint.config.js')).toBeUndefined();
  expect(workspaceOf('packages/k8s-extra/src/x.ts')).toBeUndefined();
});
