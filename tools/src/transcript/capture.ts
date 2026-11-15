// Captures the real output of transcripts tagged `golden-verified` (docs/TRANSCRIPTS.md): runs each
// transcript's commands in a real interactive bash on a pseudo-terminal (pty_capture.py) and
// writes what the terminal showed into the transcript, or with --check reports any difference.
//
//   npm run transcript:capture -- [--check] [file or directory ...]
//
// Rank 3 ground truth (docs/FIDELITY.md §2.1): the workstation's bash, coreutils and grep.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { formatOutput, parseTranscript, replaceOutputs } from '@simlab/host';

const repo = resolve(import.meta.dirname, '..', '..', '..');
const helper = join(import.meta.dirname, 'pty_capture.py');

function files(p: string): string[] {
  if (!statSync(p).isDirectory()) return [p];
  return readdirSync(p)
    .sort()
    .flatMap((n) => {
      const q = join(p, n);
      return statSync(q).isDirectory() ? files(q) : n.endsWith('.t') ? [q] : [];
    });
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const targets = args.filter((a) => a !== '--check');
const paths = (targets.length > 0 ? targets : [join(repo, 'packages/host/transcripts')]).flatMap((t) => files(resolve(t)));

let failed = false;
for (const file of paths) {
  const text = readFileSync(file, 'utf8');
  const t = parseTranscript(text);
  if (!t.tags.includes('golden-verified')) continue;
  const name = relative(repo, file);
  const r = spawnSync('python3', [helper], {
    input: JSON.stringify({ commands: t.steps.map((s) => s.command), cols: t.cols, rows: 24 }),
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(`${name}: capture failed\n${r.stderr}`);
    failed = true;
    continue;
  }
  const results = (JSON.parse(r.stdout) as { results: { output: string; status: number }[] }).results.map((x) => ({
    output: x.output.replace(/\r\n/g, '\n'),
    status: x.status,
  }));
  const commands: { output: string; status: number }[] = [];
  t.steps.forEach((s, k) => {
    const res = results[k] as { output: string; status: number };
    if (s.kind === 'setup') {
      if (res.status !== 0) {
        console.error(`${name}:${s.line}: setup step failed on the real system (status ${res.status}): ${res.output}`);
        failed = true;
      }
    } else commands.push(res);
  });
  if (check) {
    t.steps
      .filter((s) => s.kind === 'command')
      .forEach((s, k) => {
        const want = formatOutput(s.output, s.status).join('\n');
        const got = formatOutput((commands[k] as { output: string }).output, (commands[k] as { status: number }).status).join('\n');
        if (want !== got) {
          console.error(`${name}:${s.line}: $ ${s.command}\n--- transcript\n${want}\n--- real\n${got}\n`);
          failed = true;
        }
      });
  } else {
    const next = replaceOutputs(text, commands);
    if (next !== text) {
      writeFileSync(file, next);
      console.log(`updated ${name}`);
    }
  }
}
process.exit(failed ? 1 : 0);
