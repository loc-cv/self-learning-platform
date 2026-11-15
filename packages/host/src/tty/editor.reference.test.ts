// Differential test of the terminal: the same keys typed into real bash 5.2.21 (captured in
// fixtures/reference/bash/readline.json by readline.py) and into the simulator must leave the
// same screen, with the cursor in the same place, after every key. Screens, not bytes: readline's
// choice of cursor sequences is not reproduced, what the learner sees is.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKernel, type Kernel } from '@simlab/kernel';
import { describe, expect, test } from 'vitest';
import { asUser, bootHost } from '../testing.ts';
import { openTerminal } from '../proc/terminal.ts';
import { hostSlice } from '../machine.ts';
import { createScreen } from './screen.ts';

interface Case {
  name: string;
  cols: number;
  rows: number;
  setup: string;
  setupOutput: string;
  keys: string[];
  outputs: string[];
  exited?: boolean;
}

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../fixtures/reference/bash/readline.json'), 'utf8')) as { cases: Case[] };

/** Virtual time that passes after a key, where the capture waited longer than its usual 200 ms. */
const WAITS: Record<string, Record<number, number>> = {
  'ctrl-c-blocking': { 1: 500 },
  'ctrl-c-pending-input-blocking': { 4: 2500 },
};

/**
 * Keys after which the simulator knowingly differs, by case: the comparison stops there.
 * `\e[2~` (Insert) is overwrite-mode, which prints a notice instead of toggling silently.
 */
const STOP: Record<string, number> = {
  'unbound-and-unsupported-keys': 8,
};

function simulate(c: Case): { setup: string; outputs: string[]; kernel: Kernel } {
  let out = '';
  const k0 = bootHost();
  const kernel = createKernel(k0.world, k0.registry, { ports: { output: (r) => (out += r.kind === 'tty' ? r.data : '') } });
  // The capture ran in an empty temporary home directory.
  asUser(kernel, 'root', (fs) => {
    for (const f of ['.bashrc', '.profile', '.bash_logout']) fs.unlink(`/home/student/${f}`);
  });
  kernel.act('open', (ctx) => openTerminal(ctx, { id: 't1', machine: 'node01', user: 'student', cols: c.cols, rows: c.rows }));
  kernel.advance(200);
  kernel.input({ kind: 'tty.bytes', tty: 't1', data: `${c.setup}\r` });
  kernel.advance(200);
  const setup = out;
  out = '';
  const outputs: string[] = [];
  c.keys.forEach((key, i) => {
    if (key !== '') kernel.input({ kind: 'tty.bytes', tty: 't1', data: key });
    kernel.advance(WAITS[c.name]?.[i] ?? 200);
    outputs.push(out);
    out = '';
  });
  return { setup, outputs, kernel };
}

describe('the terminal matches real bash 5.2.21, screen by screen', () => {
  for (const c of fixture.cases) {
    test(c.name, () => {
      const sim = simulate(c);
      const real = createScreen(c.cols, c.rows);
      const ours = createScreen(c.cols, c.rows);
      real.write(c.setupOutput);
      ours.write(sim.setup);
      expect(ours.lines(), 'after the setup line').toEqual(real.lines());
      const stop = STOP[c.name] ?? c.keys.length;
      for (let i = 0; i < stop; i++) {
        real.write(c.outputs[i] as string);
        ours.write(sim.outputs[i] as string);
        const where = `after key ${i} ${JSON.stringify(c.keys[i])}`;
        expect(ours.lines(), where).toEqual(real.lines());
        expect(ours.cursor, `${where}: cursor`).toEqual(real.cursor);
      }
      if (c.exited) {
        const shell = hostSlice({ slice: (n: string) => sim.kernel.world.slices[n] } as never).machines['node01']?.procs['1000'];
        expect(shell?.state ?? 'gone', 'the shell exited').not.toBe('running');
      }
    });
  }
});
