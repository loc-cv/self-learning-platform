// The terminal player's core with a fake clock and a fake editor: what the user types reaches the
// machine, an edit in the "real" editor lands in the simulated file, and a recorded session
// replays into a fresh world with the same world hash.

import { describe, expect, test } from 'vitest';
import { createScreen, type EditorRequest } from '@simlab/host';
import { createPlayer, replaySession } from './player.ts';

function fakePlayer(edit: (req: EditorRequest) => string = (r) => r.content) {
  let clock = 0;
  let screenText = '';
  const notes: string[] = [];
  const edits: EditorRequest[] = [];
  const player = createPlayer(
    { topology: 'ubuntu-1', seed: 7, cols: 80, rows: 24 },
    {
      write: (d) => (screenText += d),
      note: (m) => notes.push(m),
      edit: (req) => {
        edits.push(req);
        clock += 5000; // five seconds in the editor
        return edit(req);
      },
      gap: () => {},
      now: () => clock,
    },
  );
  const type = (keys: string, after = 50): void => {
    clock += 20;
    player.keys(keys);
    clock += after;
    player.tick();
  };
  const screen = (): string => {
    const s = createScreen(80, 24);
    s.write(screenText);
    return s.text();
  };
  return { player, type, screen, notes, edits, advance: (ms: number) => ((clock += ms), player.tick()) };
}

describe('the terminal player', () => {
  test('typing reaches the shell; pipes and redirects work; virtual time follows the clock', () => {
    const p = fakePlayer();
    p.type('echo one two | tr a-z A-Z > f; cat f\r');
    expect(p.screen()).toContain('$ echo one two | tr a-z A-Z > f; cat f\nONE TWO\n');
    p.type('sleep 2; echo slept\r');
    expect(p.screen()).not.toContain('\nslept');
    p.advance(2100);
    expect(p.screen()).toContain('\nslept\n');
  });

  test('vim opens the real editor on the content; what it saves is written back', () => {
    const p = fakePlayer((req) => req.content.replace('old', 'new'));
    p.type('echo old > notes.txt\r');
    p.type('vim notes.txt\r');
    expect(p.edits.map((e) => [e.path, e.content])).toEqual([['/home/student/notes.txt', 'old\n']]);
    p.type('cat notes.txt\r');
    expect(p.screen()).toContain('$ cat notes.txt\nnew\n');
  });

  test('a recorded session replays into a fresh world with the same world hash', () => {
    const p = fakePlayer((req) => `${req.content}added\n`);
    p.type('mkdir d && cd d\r');
    p.type('ls /e\t');
    p.type('\x15sleep 30\r');
    p.advance(1000);
    p.type('\x03');
    p.type('vi x\r');
    p.type('cat x; exit\r');
    expect(p.player.ended).toBe(true);
    const log = p.player.finish();
    let replayed = '';
    const r = replaySession(JSON.parse(JSON.stringify(log)), (d) => (replayed += d));
    expect(r.divergedAt).toBeUndefined();
    expect(r.hash).toBe(r.recorded);
    expect(r.hash).toBe(p.player.kernel.hash());
    const s = createScreen(80, 24);
    s.write(replayed);
    expect(s.text()).toBe(p.screen());
    expect(log.inputs.map((i) => i.kind)).toContain('editor.save');
  });

  test('a replay of a changed log is detected', () => {
    const p = fakePlayer();
    p.type('echo a > f\r');
    p.player.keys('');
    const log = p.player.finish();
    const tampered = JSON.parse(JSON.stringify(log)) as typeof log;
    const bytes = tampered.inputs.find((i) => i.kind === 'tty.bytes') as unknown as { data: string };
    bytes.data = 'echo b > f\r';
    const r = replaySession(tampered, () => {});
    expect(r.divergedAt !== undefined || r.hash !== r.recorded).toBe(true);
  });
});
