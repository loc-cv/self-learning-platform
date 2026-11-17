// The command lines an interactive shell runs, as trace records and as the host's input events.

import { describe, expect, test } from 'vitest';
import { bootKernel, buildEvents, createRegistry, DEFAULT_START_TIME, validateEvents, type Kernel, type TraceRecord } from '@simlab/kernel';
import { hostPlugin } from '../plugin.ts';
import { ubuntu1Topology } from '../topology.ts';
import { captureOutput, openSession, type Session } from '../transcript/session.ts';
import { hostEvents } from './events.ts';

const registry = createRegistry([hostPlugin]);

function boot(terminal: boolean): { k: Kernel; s: Session } {
  const k = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME });
  k.act('topology', (ctx) => ubuntu1Topology.build(ctx, {}));
  const s = openSession(k, captureOutput(), { machine: 'node01', user: 'root', terminal });
  return { k, s };
}

const ofKind = (k: Kernel, kind: string): TraceRecord[] => k.traceRecords().filter((r) => r.kind === kind);
const lines = (k: Kernel): string[] => ofKind(k, 'shell.command').map((r) => String((r.data as { line: string }).line));

describe('shell.command records', () => {
  test('one pair per command line: a pipeline is one command, its status is the line’s', () => {
    const { k, s } = boot(false);
    const before = ofKind(k, 'shell.command').length;
    s.run('echo hello | tr a-z A-Z | wc -c');
    s.run('');
    s.run('ls /nonexistent');
    const starts = ofKind(k, 'shell.command').slice(before);
    expect(starts.map((r) => (r.data as { line: string }).line)).toEqual(['echo hello | tr a-z A-Z | wc -c', 'ls /nonexistent']);
    const done = ofKind(k, 'shell.command.done').filter((r) => starts.some((x) => r.causes?.[0] === x.id));
    expect(done.map((r) => (r.data as { status: number }).status)).toEqual([0, 2]);
    expect(starts[0]?.data).toMatchObject({ machine: 'node01', hostname: 'node01', user: 'root', uid: 0, tty: s.tty });
    expect(starts.every((r) => r.causes === undefined)).toBe(true);
  });

  test('a line typed into cat is cat’s, not the shell’s', () => {
    const { k, s } = boot(false);
    s.type('cat\n');
    s.wait(1000);
    s.type('not a command\n');
    s.wait(1000);
    s.type('\x04');
    s.wait(1000);
    expect(lines(k).filter((l) => l !== 'PS1=; PS2=')).toEqual(['cat']);
    const done = ofKind(k, 'shell.command.done');
    expect(done.at(-1)?.data).toMatchObject({ status: 0 });
  });

  test('Ctrl-C ends the running command with 130; Ctrl-C at the prompt is no command', () => {
    const { k, s } = boot(true);
    s.type('sleep 100\r');
    k.advance(2000);
    s.type('\x03');
    s.wait(1000);
    s.type('half a line\x03');
    s.wait(1000);
    expect(lines(k)).toEqual(['sleep 100']);
    const start = ofKind(k, 'shell.command')[0] as TraceRecord;
    const end = ofKind(k, 'shell.command.done')[0] as TraceRecord;
    expect(end.causes).toEqual([start.id]);
    expect((end.data as { status: number }).status).toBe(130);
    expect(end.t - start.t).toBe(2000);
  });

  test('the host’s events: an input per line, with its end and exit status', () => {
    const { k, s } = boot(false);
    const from = k.traceRecords().length;
    s.run('true');
    s.run('false');
    const events = hostEvents(k.traceRecords().slice(from));
    expect(events.map((e) => [e.text, e.actor, e.about, e.level, e.input, e.tone, e.items])).toEqual([
      ['true', 'root@node01', ['host/machine/node01'], 'key', true, 'neutral', [{ label: 'Exit status', value: '0', tone: 'neutral' }]],
      ['false', 'root@node01', ['host/machine/node01'], 'key', true, 'bad', [{ label: 'Exit status', value: '1', tone: 'bad' }]],
    ]);
    expect(events.every((e) => e.until !== undefined && e.until >= e.t)).toBe(true);
    expect(validateEvents(buildEvents(registry, k.traceRecords()))).toEqual([]);
  });

  test('a command still running has no end yet', () => {
    const { k, s } = boot(true);
    s.type('sleep 100\r');
    k.advance(1000);
    const [e] = hostEvents(k.traceRecords());
    expect(e?.text).toBe('sleep 100');
    expect(e?.until).toBeUndefined();
    expect(e?.items).toBeUndefined();
  });
});
