// PLAN.md phase 11, exit criterion: killing the server mid-write never corrupts the log. A real
// process appends in a tight loop and is killed with SIGKILL at seeded moments; whatever it
// leaves, the log reads as whole, numbered lines, and nothing it acknowledged is lost.

import { spawn } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { appendLines, readLines } from './store.ts';

const CHILD = fileURLToPath(new URL('./store.kill-child.ts', import.meta.url));
const ROUNDS = 20;

/** A small seeded generator (mulberry32), so the kill moments are the same on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs the writer, kills it `delay` ms after its first acknowledgement, returns the last one seen. */
function runAndKill(file: string, delay: number): Promise<number> {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [CHILD, file], { stdio: ['ignore', 'pipe', 'inherit'] });
    let acked = -1;
    let rest = '';
    let timer: NodeJS.Timeout | undefined;
    child.stdout.on('data', (c: Buffer) => {
      const parts = (rest + c.toString('utf8')).split('\n');
      rest = parts.pop() ?? '';
      for (const p of parts) acked = Math.max(acked, Number(p));
      // The clock starts once the writer is writing, so no round is spent on process startup.
      timer ??= setTimeout(() => child.kill('SIGKILL'), delay);
    });
    child.on('error', fail);
    child.on('close', (_code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') ok(acked);
      else fail(new Error(`the writer ended by itself (${String(signal)})`));
    });
  });
}

function sequence(file: string): number[] {
  return readLines(file).map((l: string) => (JSON.parse(l) as { seq: number }).seq);
}

test('a writer killed mid-write leaves only whole lines and loses nothing it acknowledged', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'simlab-kill-')), 'progress.jsonl');
  const random = seeded(11);
  let last = -1;
  for (let round = 0; round < ROUNDS; round++) {
    const acked = await runAndKill(file, Math.floor(random() * 40));
    const seqs = sequence(file);
    // Whole lines only (each parsed above), numbered from 0 without a gap or a repeat: the next
    // writer continued exactly where the readable log ended, whatever the kill left behind.
    expect(seqs).toEqual(seqs.map((_, i) => i));
    // Acknowledged means on disk.
    expect(seqs.length - 1).toBeGreaterThanOrEqual(acked);
    expect(seqs.length - 1).toBeGreaterThanOrEqual(last);
    last = seqs.length - 1;
  }
  expect(last).toBeGreaterThan(ROUNDS);
  // Another process (this one) appends after the last kill: the file is whole lines to its end.
  appendLines(file, [JSON.stringify({ seq: last + 1 })]);
  const seqs = sequence(file);
  expect(seqs).toEqual(seqs.map((_, i) => i));
  const text = readLines(file).join('\n') + '\n';
  expect(Buffer.byteLength(text)).toBe(statSync(file).size);
}, 60_000);
