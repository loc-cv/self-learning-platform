// Runs every transcript under packages/k8s/transcripts/ (docs/TRANSCRIPTS.md) in the kubeadm-1cp-2w
// topology: a login shell of root on the control plane, in /root, after the cluster has settled.
//
// Header lines this package reads besides tags and cols:
//   # objects: <file>     manifests (relative to the transcript) created through the API server
//                         before the session, as `kubectl create -f` would send them; repeatable.
//                         A stand-in until phase 07b's `kubectl create` and `apply` can be setup steps.
//   # machine: <name>     where the session opens (default: the topology's entry)
//   # user: <name>        who logs in (default: the topology's entry)
//   # settle: <seconds>   virtual time to run after the build and the objects (default 10)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { formatOutput, hasTokens, matchTokens, parseTranscript, runTranscript } from '@simlab/host';
import { transcriptWorld } from './testing/transcripts.ts';

const root = join(import.meta.dirname, '..', 'transcripts');

function files(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : n.endsWith('.t') ? [p] : [];
    });
}

describe('transcripts', () => {
  for (const file of files(root)) {
    test(relative(root, file), () => {
      const t = parseTranscript(readFileSync(file, 'utf8'));
      const run = runTranscript(t, transcriptWorld(t.header, (name) => readFileSync(join(dirname(file), name), 'utf8')));
      for (const r of run.results) {
        const where = `${relative(root, file)}:${r.step.line}: ${r.step.command}`;
        expect(r.finished, `${where}: did not return to the prompt`).toBe(true);
        if (r.step.kind === 'setup') {
          expect(r.status, `${where}: setup failed: ${r.output}`).toBe(0);
          continue;
        }
        const got = formatOutput(r.output, r.status).join('\n');
        const want = formatOutput(r.step.output, r.step.status).join('\n');
        if (hasTokens(want) && matchTokens(want, got)) continue;
        expect(got, where).toBe(want);
      }
      expect(run.results.length, 'every step ran').toBe(t.steps.length);
      const internal = run.gaps.filter((g) => g.kind === 'internal');
      expect(internal.map((g) => g.error?.stack ?? g.what)).toEqual([]);
    });
  }
});
