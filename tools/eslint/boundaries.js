// The workspace dependency graph, as data. PLAN.md §6: `kernel` ← `host` ← domain plugins;
// `learn` depends on `kernel` and on no domain; apps wire everything together.
// The lint rule `simlab/package-boundaries` and the tests read this table. Adding a domain
// plugin means adding one row here (docs/decisions.md D-006).

/** Engine packages run in a Web Worker and in Node: no DOM, no Node APIs, deterministic. */
export const ENGINE_PACKAGES = ['kernel', 'host', 'k8s', 'learn'];

/**
 * Workspace root directory → the `@simlab/*` packages it may import.
 * @type {Record<string, { name: string, allowed: string[] }>}
 */
export const WORKSPACES = {
  'packages/kernel': { name: 'kernel', allowed: [] },
  'packages/host': { name: 'host', allowed: ['kernel'] },
  'packages/k8s': { name: 'k8s', allowed: ['kernel', 'host'] },
  'packages/learn': { name: 'learn', allowed: ['kernel'] },
  'packages/content': { name: 'content', allowed: ['kernel', 'learn'] },
  'apps/web': { name: 'web', allowed: ['kernel', 'host', 'k8s', 'learn', 'content'] },
  'apps/server': { name: 'server', allowed: ['kernel', 'host', 'k8s', 'learn', 'content'] },
  'apps/cli': { name: 'cli', allowed: ['kernel', 'host', 'k8s', 'learn', 'content'] },
  tools: { name: 'tools', allowed: ['kernel', 'host', 'k8s', 'learn', 'content'] },
};

/**
 * The workspace a repo-relative POSIX path belongs to, or undefined for root-level files.
 * @param {string} relPath
 * @returns {string | undefined}
 */
export function workspaceOf(relPath) {
  return Object.keys(WORKSPACES).find((root) => relPath === root || relPath.startsWith(`${root}/`));
}
