// Key-level tests of the terminal beyond the captured reference cases (editor.reference.test.ts):
// completers, notices for readline commands that are not simulated, Ctrl-C and Ctrl-Z during a
// command, resize, hang-up, and a line being edited across snapshot and restore.

import { createKernel, restore, snapshot, type GapEvent, type Plugin } from '@simlab/kernel';
import { describe, expect, test } from 'vitest';
import { hostSlice } from '../machine.ts';
import { PROGRAM, type ProgramSpec } from '../proc/program.ts';
import { asUser, bootHost } from '../testing.ts';
import { captureOutput, openSession } from '../transcript/session.ts';
import { createScreen } from './screen.ts';

/** A program whose completer offers fixed words, as kubectl's will (phase 08). */
const fakeTool: ProgramSpec = {
  name: 'faketool',
  // eslint-disable-next-line require-yield -- the program does nothing; only its completer matters
  *main() {
    return 0;
  },
  complete(c) {
    if (c.cword === 1) return { matches: ['apply', 'apply-all', 'get'].filter((w) => w.startsWith(c.cur)) };
    return undefined;
  },
};
const testPlugin: Plugin = { name: 'test-tools', contributions: { [PROGRAM]: [fakeTool] } };

function terminal(opts: { cols?: number; rows?: number; plugins?: Plugin[] } = {}) {
  const k0 = bootHost(opts.plugins ?? []);
  const cap = captureOutput();
  const gaps: GapEvent[] = [];
  const kernel = createKernel(k0.world, k0.registry, { ports: { ...cap.ports, gap: (g) => gaps.push(g) } });
  const s = openSession(kernel, cap, { machine: 'node01', user: 'student', terminal: true, cols: opts.cols ?? 80, rows: opts.rows ?? 24 });
  const screen = createScreen(opts.cols ?? 80, opts.rows ?? 24);
  screen.write(s.takeRaw());
  const keys = (data: string, wait = 10): void => {
    s.type(data);
    kernel.advance(wait);
    screen.write(s.takeRaw());
  };
  /** The cursor's row, with the trailing spaces a screen does not keep. */
  const line = (): string => screen.lines()[screen.cursor.row] as string;
  return { kernel, s, screen, keys, line, gaps };
}

const PROMPT = 'student@node01:~$ ';

describe('the prompt', () => {
  test('a login shell shows Ubuntu .bashrc prompt, in color, with the xterm title', () => {
    const t = terminal();
    expect(t.line()).toBe((PROMPT).trimEnd());
    t.keys('cd /etc\r');
    expect(t.line()).toBe(('student@node01:/etc$ ').trimEnd());
    t.keys('echo "$PS1"\r');
    expect(t.screen.text().replace(/\n/g, '')).toContain(
      '\\[\\e]0;${debian_chroot:+($debian_chroot)}\\u@\\h: \\w\\a\\]${debian_chroot:+($debian_chroot)}\\[\\033[01;32m\\]\\u@\\h',
    );
  });

  test('PS2 continues an open quote; the history keeps the command as one entry', () => {
    const t = terminal();
    t.keys("echo 'a\r");
    expect(t.line()).toBe(('> ').trimEnd());
    t.keys("b'\r");
    expect(t.screen.text()).toContain("> b'\na\nb\n");
    t.keys('history\r');
    expect(t.screen.text()).toContain("    1  echo 'a\nb'");
  });
});

describe('completion', () => {
  test("a program's own completer completes its arguments; files are the default after that", () => {
    const t = terminal({ plugins: [testPlugin] });
    asUser(t.kernel, 'root', (fs, ctx) => {
      fs.installProgram('/usr/local/bin/faketool', 'faketool', { size: 100 });
      void ctx;
    });
    t.keys('faketool g\t');
    expect(t.line()).toBe((`${PROMPT}faketool get `).trimEnd());
    t.keys('\x15faketool app\t');
    expect(t.line()).toBe((`${PROMPT}faketool apply`).trimEnd());
    t.keys('\t\t');
    expect(t.screen.text()).toContain('apply      apply-all');
    t.keys('\x15faketool get .pro\t');
    expect(t.line()).toBe((`${PROMPT}faketool get .profile `).trimEnd());
  });

  test('cd completes directories only, as bash-completion does', () => {
    const t = terminal();
    t.keys('mkdir proj; touch prog\r');
    t.keys('cd pro\t');
    expect(t.line()).toBe((`${PROMPT}cd proj/`).trimEnd());
    t.keys('\x15ls pro\t\t');
    expect(t.screen.text()).toContain('\nprog  proj/\n');
  });

  test('~user completes user names to their home', () => {
    const t = terminal();
    t.keys('ls ~stu\t');
    expect(t.line()).toBe((`${PROMPT}ls ~student/`).trimEnd());
  });
});

describe('readline commands that are not simulated', () => {
  test('print a notice under the line, record a gap, and give the line back', () => {
    const t = terminal();
    t.keys('echo abc');
    t.keys('\x1bu'); // M-u upcase-word
    expect(t.screen.text()).toContain('[sim] bash: the readline command upcase-word (\\eu) is not simulated yet');
    expect(t.line()).toBe((`${PROMPT}echo abc`).trimEnd());
    expect(t.gaps.map((g) => g.what)).toEqual(['the readline command upcase-word (\\eu)']);
  });
});

describe('signals from the keyboard', () => {
  test('Ctrl-C ends a blocking command with status 130 and the prompt returns', () => {
    const t = terminal();
    t.keys('sleep 100\r');
    t.keys('\x03');
    expect(t.screen.text()).toContain(`${PROMPT}sleep 100\n^C\n${PROMPT.trimEnd()}`);
    t.keys('echo $?\r');
    expect(t.screen.text()).toContain('echo $?\n130\n');
  });

  test('Ctrl-C at the prompt discards the line and sets $? to 130', () => {
    const t = terminal();
    t.keys('echo half');
    t.keys('\x03');
    t.keys('echo $?\r');
    expect(t.screen.text()).toBe(`${PROMPT}echo half^C\n${PROMPT}echo $?\n130\n${PROMPT}`.trimEnd());
  });

  test('Ctrl-Z during a command prints a notice; at the prompt it does nothing', () => {
    const t = terminal();
    t.keys('\x1a');
    expect(t.screen.text()).toBe(PROMPT.trimEnd());
    t.keys('sleep 5\r');
    t.keys('\x1a');
    expect(t.screen.text()).toContain('^Z\n[sim] bash: job control (Ctrl-Z, SIGTSTP) is not simulated yet');
    expect(t.gaps.map((g) => g.what)).toEqual(['job control (Ctrl-Z, SIGTSTP)']);
  });
});

describe('the terminal itself', () => {
  test('a resize redraws the line being edited for the new width', () => {
    const t = terminal({ cols: 40 });
    t.keys('echo 0123456789012345678901234567890');
    expect(t.screen.lines().slice(0, 2)).toEqual([`${PROMPT}echo 01234567890123456`, '78901234567890']);
    t.s.kernel.input({ kind: 'tty.resize', tty: t.s.tty, cols: 60, rows: 24 });
    t.screen.resize(60, 24);
    t.screen.write(t.s.takeRaw());
    t.keys('X');
    expect(t.line()).toBe((`${PROMPT}echo 0123456789012345678901234567890X`).trimEnd());
    expect(hostSlice({ slice: () => t.kernel.world.slices['host'] } as never).ttys[t.s.tty]?.cols).toBe(60);
  });

  test('closing the terminal hangs up the shell', () => {
    const t = terminal();
    t.s.kernel.input({ kind: 'tty.close', tty: t.s.tty });
    t.kernel.advance(10);
    const shell = (t.kernel.world.slices['host'] as ReturnType<typeof hostSlice>).machines['node01']?.procs[t.s.pid];
    expect(shell?.state ?? 'reaped').not.toBe('running');
  });

  test('a line being edited survives snapshot and restore, and the restored shell runs it', () => {
    const t = terminal();
    t.keys('echo hel');
    const text = snapshot(t.kernel.world, t.kernel.registry);
    let out = '';
    const r = createKernel(restore(text, t.kernel.registry), t.kernel.registry, { ports: { output: (o) => (out += o.kind === 'tty' ? o.data : '') } });
    r.input({ kind: 'tty.bytes', tty: t.s.tty, data: 'lo\r' });
    r.advance(10);
    const screen = createScreen();
    screen.write(out);
    expect(screen.text()).toBe(`lo\nhello\n${PROMPT}`.trimEnd());
  });
});
