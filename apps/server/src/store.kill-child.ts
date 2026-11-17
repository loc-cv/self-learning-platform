// The writer the kill test (store.kill.test.ts) kills: appends numbered events to the file named
// on the command line, continuing after what is already there, and prints the last sequence
// number on disk after every append returns. Batches vary in size and some lines are tens of
// kilobytes, so a kill can land inside a write.

import { appendLines, readLines } from './store.ts';

const file = process.argv[2];
if (file === undefined) throw new Error('usage: node store.kill-child.ts FILE');

let seq = readLines(file).length;
for (let round = 0; ; round++) {
  const lines: string[] = [];
  const count = 1 + (round % 7);
  for (let i = 0; i < count; i++) {
    const pad = (seq + i) % 5 === 0 ? 'x'.repeat(20_000 + ((seq + i) % 13) * 5_000) : '';
    lines.push(JSON.stringify({ v: 1, type: 'test', at: seq + i, seq: seq + i, pad }));
  }
  appendLines(file, lines);
  seq += count;
  process.stdout.write(`${seq - 1}\n`);
}
