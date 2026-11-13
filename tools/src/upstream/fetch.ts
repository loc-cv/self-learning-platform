// npm run upstream:fetch
//
// Sparse, blob-less, depth-1 clone of kubernetes/kubernetes at the pinned tag into
// .upstream/kubernetes (git-ignored). Blobs are downloaded only for the directories in
// paths.ts. Rerunning is cheap: an existing checkout at the right tag only has its sparse set
// refreshed; a checkout at another tag is refetched in place.
//
// This is a development tool. Nothing at runtime and nothing in `npm run check` needs it.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KUBERNETES_TAG } from '@simlab/k8s';
import { UPSTREAM_REPO, UPSTREAM_SPARSE_PATHS } from './paths.ts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const upstreamDir = path.join(repoRoot, '.upstream');
const checkout = path.join(upstreamDir, 'kubernetes');

function git(args: string[], cwd: string, capture = false): string {
  const out = execFileSync('git', args, {
    cwd,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  return typeof out === 'string' ? out.trim() : '';
}

function currentTag(): string | undefined {
  try {
    return git(['describe', '--tags', '--exact-match', 'HEAD'], checkout, true);
  } catch {
    return undefined;
  }
}

mkdirSync(upstreamDir, { recursive: true });

if (!existsSync(path.join(checkout, '.git'))) {
  console.log(`Cloning ${UPSTREAM_REPO} at ${KUBERNETES_TAG} (sparse, blob-less) …`);
  git(
    ['clone', '--filter=blob:none', '--no-checkout', '--depth', '1', '--branch', KUBERNETES_TAG, UPSTREAM_REPO, checkout],
    upstreamDir,
  );
  git(['sparse-checkout', 'init', '--cone'], checkout);
} else if (currentTag() !== KUBERNETES_TAG) {
  console.log(`Checkout is at ${currentTag() ?? 'an unknown commit'}; fetching ${KUBERNETES_TAG} …`);
  git(['fetch', '--filter=blob:none', '--depth', '1', 'origin', `refs/tags/${KUBERNETES_TAG}:refs/tags/${KUBERNETES_TAG}`], checkout);
} else {
  console.log(`Checkout is already at ${KUBERNETES_TAG}; refreshing the sparse set.`);
}

git(['sparse-checkout', 'set', '--cone', ...UPSTREAM_SPARSE_PATHS], checkout);
git(['-c', 'advice.detachedHead=false', 'checkout', '--force', KUBERNETES_TAG], checkout);

const tag = currentTag();
if (tag !== KUBERNETES_TAG) {
  console.error(`Expected ${KUBERNETES_TAG} but the checkout is at ${tag ?? 'an unknown commit'}.`);
  process.exit(1);
}
const missing = UPSTREAM_SPARSE_PATHS.filter((p) => !existsSync(path.join(checkout, p)));
if (missing.length > 0) {
  console.error(`These paths do not exist at ${KUBERNETES_TAG}:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const commit = git(['rev-parse', 'HEAD'], checkout, true);
writeFileSync(
  path.join(upstreamDir, 'kubernetes.json'),
  JSON.stringify({ repo: UPSTREAM_REPO, tag, commit, paths: UPSTREAM_SPARSE_PATHS }, null, 2) + '\n',
);
console.log(`.upstream/kubernetes is at ${tag} (${commit}), ${UPSTREAM_SPARSE_PATHS.length} directories.`);
