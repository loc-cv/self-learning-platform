// npm run upstream:fetch
//
// Sparse, blob-less, depth-1 clone of each upstream repository in paths.ts at its pinned tag
// into .upstream/<name> (git-ignored): kubernetes/kubernetes, containerd, runc, the Go standard
// library. Blobs are downloaded only for the listed directories (and the repository root).
// Rerunning is cheap: a checkout already at the right tag only has its sparse set refreshed; a
// checkout at another tag is refetched in place. Each checkout writes .upstream/<name>.json
// with its repository, tag, commit and directories.
//
// This is a development tool. Nothing at runtime and nothing in `npm run check` needs it.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPSTREAM_CHECKOUTS, type UpstreamCheckout } from './paths.ts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const upstreamDir = path.join(repoRoot, '.upstream');

function git(args: string[], cwd: string, capture = false): string {
  const out = execFileSync('git', args, {
    cwd,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  return typeof out === 'string' ? out.trim() : '';
}

function currentTag(checkout: string): string | undefined {
  try {
    return git(['describe', '--tags', '--exact-match', 'HEAD'], checkout, true);
  } catch {
    return undefined;
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function fetchCheckout({ name, repo, tag: want, paths, pinnedBy }: UpstreamCheckout): void {
  const checkout = path.join(upstreamDir, name);

  if (pinnedBy !== undefined) {
    // The pinning checkout is fetched earlier (UPSTREAM_CHECKOUTS order); `git show` reads the
    // file from its commit whether or not the file is in its sparse set.
    const stated = git(['show', `HEAD:${pinnedBy.file}`], path.join(upstreamDir, pinnedBy.checkout), true)
      .split('\n')[0]
      ?.trim();
    if (stated !== want) {
      fail(`${pinnedBy.checkout}'s ${pinnedBy.file} says ${stated ?? 'nothing'}, but paths.ts pins ${name} at ${want}.`);
    }
  }

  if (!existsSync(path.join(checkout, '.git'))) {
    console.log(`Cloning ${repo} at ${want} (sparse, blob-less) …`);
    git(['clone', '--filter=blob:none', '--no-checkout', '--depth', '1', '--branch', want, repo, checkout], upstreamDir);
    git(['sparse-checkout', 'init', '--cone'], checkout);
  } else if (currentTag(checkout) !== want) {
    console.log(`Checkout is at ${currentTag(checkout) ?? 'an unknown commit'}; fetching ${want} …`);
    git(['fetch', '--filter=blob:none', '--depth', '1', 'origin', `refs/tags/${want}:refs/tags/${want}`], checkout);
  } else {
    console.log(`Checkout is already at ${want}; refreshing the sparse set.`);
  }

  git(['sparse-checkout', 'set', '--cone', ...paths], checkout);
  git(['-c', 'advice.detachedHead=false', 'checkout', '--force', want], checkout);

  const tag = currentTag(checkout);
  if (tag !== want) fail(`Expected ${want} but .upstream/${name} is at ${tag ?? 'an unknown commit'}.`);
  const missing = paths.filter((p) => !existsSync(path.join(checkout, p)));
  if (missing.length > 0) fail(`These paths do not exist in ${name} at ${want}:\n  ${missing.join('\n  ')}`);

  const commit = git(['rev-parse', 'HEAD'], checkout, true);
  writeFileSync(path.join(upstreamDir, `${name}.json`), JSON.stringify({ repo, tag, commit, paths }, null, 2) + '\n');
  console.log(`.upstream/${name} is at ${tag} (${commit}), ${paths.length} ${paths.length === 1 ? 'directory' : 'directories'}.`);
}

mkdirSync(upstreamDir, { recursive: true });
for (const checkout of UPSTREAM_CHECKOUTS) fetchCheckout(checkout);
