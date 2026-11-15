// Runs every transcript under packages/host/transcripts/ (docs/TRANSCRIPTS.md). A transcript tagged
// `golden-verified` holds output captured from the real tools with `npm run transcript:capture`.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { formatOutput, parseTranscript } from './transcript/format.ts';
import { runTranscript } from './transcript/runner.ts';

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
      const run = runTranscript(t);
      for (const r of run.results) {
        const where = `${relative(root, file)}:${r.step.line}: ${r.step.command}`;
        expect(r.finished, `${where}: did not return to the prompt`).toBe(true);
        if (r.step.kind === 'setup') {
          expect(r.status, `${where}: setup failed: ${r.output}`).toBe(0);
          continue;
        }
        expect(formatOutput(r.output, r.status).join('\n'), where).toBe(formatOutput(r.step.output, r.step.status).join('\n'));
      }
      expect(run.results.length, 'every step ran').toBe(t.steps.length);
      const internal = run.gaps.filter((g) => g.kind === 'internal');
      expect(internal.map((g) => g.error?.stack ?? g.what)).toEqual([]);
    });
  }
});
