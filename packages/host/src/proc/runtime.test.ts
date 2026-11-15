// Process runtime in virtual time: streaming pipelines, interruption, SIGPIPE, preemption, fork
// and restore of programs, replay determinism, and unlinked files kept alive by descriptors.

import { createKernel, createRecorder, replay, restore, snapshot, type Plugin, type Ports } from '@simlab/kernel';
import { createFs } from '../vfs/fs.ts';
import { ROOT_CRED } from '../vfs/types.ts';
import { describe, expect, test } from 'vitest';
import type { ProcApi, ProgramSpec, Syscall } from './program.ts';
import { PROGRAM } from './program.ts';
import { captureOutput, openSession } from '../transcript/session.ts';
import { defaultTranscriptWorld } from '../transcript/runner.ts';
import { getMachine } from '../machine.ts';
import { SLICE_BUDGET } from './runtime.ts';

/** Test programs: `ticker N` prints `tick <i>` every second, N times (forever without N). */
const ticker: ProgramSpec = {
  name: 'ticker',
  *main(p: ProcApi): Generator<Syscall, number, unknown> {
    const n = p.argv[1] === undefined ? Infinity : Number(p.argv[1]);
    for (let i = 1; i <= n; i++) {
      yield* p.sleep(1000);
      yield* p.write(1, `tick ${i}${i % 2 === 0 ? ' even' : ''}\n`);
    }
    return 0;
  },
};
/** Writes lines as fast as it can, forever; counts them in its exit status if it ever exits. */
const spew: ProgramSpec = {
  name: 'spew',
  *main(p: ProcApi): Generator<Syscall, number, unknown> {
    for (;;) yield* p.write(1, 'y\n');
  },
};
/** Reads one line, prints it, exits. */
const takeone: ProgramSpec = {
  name: 'takeone',
  *main(p: ProcApi): Generator<Syscall, number, unknown> {
    const line = yield* p.read(0, { line: true });
    yield* p.write(1, line ?? '');
    return 0;
  },
};
/** Opens a file, unlinks it, sleeps, then reads it through the descriptor. */
const holder: ProgramSpec = {
  name: 'holder',
  *main(p: ProcApi): Generator<Syscall, number, unknown> {
    const fd = p.open(p.argv[1] as string, { read: true });
    p.fs().unlink(p.argv[1] as string);
    yield* p.sleep(1000);
    const data = yield* p.read(fd);
    yield* p.write(1, `read: ${data ?? ''}`);
    return 0;
  },
};

const testPlugin: Plugin = { name: 'test-programs', requires: ['host'], contributions: { [PROGRAM]: [ticker, spew, takeone, holder] } };

/** A world with the test programs installed in /usr/local/bin, as a package would install them. */
function world(ports: Ports) {
  const w = defaultTranscriptWorld(ports, [testPlugin]);
  w.kernel.act('install', (ctx) => {
    const fs = createFs(ctx, 'node01', { cred: ROOT_CRED, umask: 0o022 });
    for (const name of ['ticker', 'spew', 'takeone', 'holder']) fs.installProgram(`/usr/local/bin/${name}`, name, { size: 1000 });
  });
  return w;
}

function session() {
  const cap = captureOutput();
  const w = world(cap.ports);
  const s = openSession(w.kernel, cap, { machine: w.machine, user: w.user });
  return { s, k: w.kernel, cap };
}

describe('streaming pipelines in virtual time', () => {
  test('a producer feeds a consumer line by line as time advances, and Ctrl-C stops the pipeline', () => {
    const { s, k } = session();
    const start = k.now;
    s.type('ticker | cat -n\n');
    k.advance(500);
    expect(s.take()).toBe('');
    k.advance(1000);
    expect(s.take()).toBe('     1\ttick 1\n');
    k.advance(2000);
    expect(s.take()).toBe('     2\ttick 2 even\n     3\ttick 3\n');
    // Ctrl-C: SIGINT to the foreground process group ends both stages; the shell reports 130.
    s.type('\x03');
    k.advance(1);
    expect(s.take()).toBe('\n');
    const r = s.run('echo $?');
    expect(r.output).toBe('130\n');
    expect(k.now - start).toBe(3501);
  });

  test('a producer piped through grep delivers matching lines as time advances; Ctrl-C stops it', () => {
    const { s, k } = session();
    // grep on a terminal writes each line at once; through a pipe it would buffer like stdio.
    s.type('ticker | grep even\n');
    k.advance(1500);
    expect(s.take()).toBe('');
    k.advance(1000);
    expect(s.take()).toBe('tick 2 even\n');
    k.advance(2000);
    expect(s.take()).toBe('tick 4 even\n');
    s.type('\x03');
    k.advance(1);
    expect(s.take()).toBe('\n');
    expect(s.run('echo $?').output).toBe('130\n');
    // Nothing is left running: the next command is not disturbed by the old pipeline.
    k.advance(5000);
    expect(s.run('echo done').output).toBe('done\n');
  });

  test('a finite producer ends the pipeline at end of file, after exactly its own duration', () => {
    const { s, k } = session();
    const start = k.now;
    expect(s.run('ticker 3 | cat').output).toBe('tick 1\ntick 2 even\ntick 3\n');
    expect(k.now - start).toBe(3000);
  });

  test('a reader that exits makes the writer die of SIGPIPE (141), as in `yes | head -1`', () => {
    const { s } = session();
    expect(s.run('spew | takeone; echo $PIPESTATUS $?').output).toBe('y\n141 0\n');
  });

  test('a busy writer is preempted: it burns virtual time and Ctrl-C can stop it', () => {
    const { s, k } = session();
    const start = k.now;
    s.type('spew > /dev/null\n');
    k.advance(50);
    // Each slice runs SLICE_BUDGET syscalls and is charged 1 ms.
    expect(k.now - start).toBe(50);
    s.type('\x03');
    k.advance(1);
    expect(s.run('echo $?').output).toBe('\n130\n');
    expect(SLICE_BUDGET).toBe(1000);
  });
});

describe('descriptors', () => {
  test('an unlinked file stays readable through an open descriptor and is deleted on close', () => {
    const { s, k } = session();
    s.run('echo kept > f');
    const inodes = () => Object.keys(getMachineOf(k).vfs.inodes).length;
    const before = inodes();
    expect(s.run('holder f').output).toBe('read: kept\n');
    expect(inodes()).toBe(before - 1);
    expect(s.run('cat f').output).toBe('cat: f: No such file or directory\n');
  });
});

function getMachineOf(k: ReturnType<typeof session>['k']) {
  return k.act('inspect', (ctx) => getMachine(ctx, 'node01'));
}

describe('fork, snapshot and replay', () => {
  test('a fork ends a running command in the copy only; the shell at its prompt keeps working', () => {
    const { s, k, cap } = session();
    s.type('ticker 10\n');
    k.advance(2500);
    expect(s.take()).toBe('tick 1\ntick 2 even\n');
    const f = k.fork({ ports: cap.ports });
    // In the original, the command keeps running.
    k.advance(1000);
    expect(s.take()).toBe('tick 3\n');
    // In the fork, the command was killed and the shell (also mid-command) too: neither has a frame.
    const procs = f.act('inspect', (ctx) => getMachine(ctx, 'node01').procs);
    const states = Object.keys(procs).map((p) => procs[p]?.state);
    expect(states.every((st) => st === 'zombie')).toBe(true);
  });

  test('a shell at its prompt survives fork and restore: it is recreated from its saved state', () => {
    const { s, k, cap } = session();
    s.run('X=remembered; alias hi="echo hi"; cd /tmp');
    const f = k.fork({ ports: cap.ports });
    const fs2 = { kernel: f, tty: s.tty };
    f.input({ kind: 'tty.bytes', tty: fs2.tty, data: 'echo $X $PWD; hi\n' });
    f.settle({ timeout: 1000 });
    expect(cap.take(s.tty)).toBe('remembered /tmp\nhi\n');

    const text = snapshot(k.world, k.registry);
    const r = createKernel(restore(text, k.registry), k.registry, { ports: cap.ports });
    r.input({ kind: 'tty.bytes', tty: s.tty, data: 'echo $X\n' });
    r.settle({ timeout: 1000 });
    expect(cap.take(s.tty)).toBe('remembered\n');
    expect(r.hash()).not.toBe(k.hash());
  });

  test('the same inputs give the same world hash, and a recorded session replays exactly', () => {
    const run = () => {
      const { s, k } = session();
      s.run('echo a > f; cat f | cat -n; ticker 2 | cat > g');
      s.run('X=$(cat g); echo "$X"');
      return k.hash();
    };
    expect(run()).toBe(run());

    // Record a session from the terminal's opening on, then replay it into a fresh world.
    const cap = captureOutput();
    const k = world(cap.ports).kernel;
    const header = { topology: 'test', seed: 1, startTime: k.world.clock.start, engine: 'test' };
    const rec = createRecorder(k, header);
    rec.deliver({ kind: 'tty.open', tty: 't1', machine: 'node01', user: 'student', cols: 80, rows: 24 });
    k.advance(10);
    rec.deliver({ kind: 'tty.bytes', tty: 't1', data: 'ticker 2 | cat -n > out\n' });
    k.advance(1500);
    rec.checkpoint();
    k.advance(3500);
    rec.deliver({ kind: 'tty.bytes', tty: 't1', data: 'cat out\n' });
    k.advance(10);
    rec.checkpoint();
    // A `tty.open` terminal is a learner's: prompt, echo, then the output.
    expect(cap.take('t1')).toContain('$ cat out\n     1\ttick 1\n     2\ttick 2 even\n');
    const result = replay(rec.log(), () => world({}).kernel);
    expect(result.diverged).toBeUndefined();
    expect(result.kernel.hash()).toBe(k.hash());
  });
});
