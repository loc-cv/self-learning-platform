// vim, vi, view and nano through the editor protocol, answered headlessly as script mode and the
// scenario runner answer them.

import { createKernel, type GapEvent } from '@simlab/kernel';
import { describe, expect, test } from 'vitest';
import type { EditorRequest } from '../../proc/editor.ts';
import { asUser, bootHost } from '../../testing.ts';
import { captureOutput, openSession } from '../../transcript/session.ts';

function world(user = 'student') {
  const k0 = bootHost();
  const cap = captureOutput();
  const gaps: GapEvent[] = [];
  const kernel = createKernel(k0.world, k0.registry, { ports: { ...cap.ports, gap: (g) => gaps.push(g) } });
  const s = openSession(kernel, cap, { machine: 'node01', user });
  const seen: EditorRequest[] = [];
  return { kernel, s, cap, gaps, seen };
}

describe('vim and nano', () => {
  test('vim asks the front end to edit the file and the saved content lands in the file', () => {
    const w = world();
    w.s.run("printf 'name: web\\n' > app.yaml");
    w.s.onEditor((req) => {
      w.seen.push(req);
      return req.content.replace('web', 'api');
    });
    const r = w.s.run('vim app.yaml');
    expect(r).toMatchObject({ output: '', status: 0, finished: true });
    expect(w.seen).toEqual([{ flavor: 'vim', path: '/home/student/app.yaml', name: 'app.yaml', content: 'name: web\n', readOnly: false, language: 'yaml' }]);
    expect(w.s.run('cat app.yaml').output).toBe('name: api\n');
  });

  test('vi and nano too; a new file is created with the umask applied', () => {
    const w = world();
    w.s.onEditor((req) => {
      w.seen.push(req);
      return `${req.flavor}\n`;
    });
    w.s.run('vi notes.txt');
    w.s.run('nano todo');
    expect(w.seen.map((r) => [r.flavor, r.content, r.readOnly, r.isNew])).toEqual([
      ['vim', '', false, true],
      ['nano', '', false, true],
    ]);
    expect(w.s.run('cat notes.txt todo; ls -l notes.txt').output).toMatch(/^vim\nnano\n.*-rw-r--r-- /s);
  });

  test('closing without saving leaves the file alone', () => {
    const w = world();
    w.s.run('echo keep > f');
    w.s.onEditor(() => undefined);
    expect(w.s.run('vim f').status).toBe(0);
    expect(w.s.run('cat f').output).toBe('keep\n');
  });

  test('view and files the user cannot write are read-only; a save there fails as vim reports it', () => {
    const w = world();
    w.s.onEditor((req) => {
      w.seen.push(req);
      return 'changed\n';
    });
    w.s.run('view /etc/hostname');
    w.s.run('vim /etc/newfile');
    expect(w.seen.map((r) => r.readOnly)).toEqual([true, true]);
    expect(w.cap.editorErrors).toEqual([`"/etc/hostname" E212: Can't open file for writing`, `"/etc/newfile" E212: Can't open file for writing`]);
    expect(w.s.run('cat /etc/hostname; ls /etc/newfile').output).toBe("node01\nls: cannot access '/etc/newfile': No such file or directory\n");
  });

  test('root can write anywhere', () => {
    const w = world('root');
    w.s.onEditor(() => 'edited\n');
    w.s.run('vim /etc/motd-test');
    expect(asUser(w.kernel, 'root', (fs) => fs.readFile('/etc/motd-test'))).toBe('edited\n');
  });

  test('what is not one named file prints the notice', () => {
    const w = world();
    w.s.onEditor(() => {
      throw new Error('no editor should open');
    });
    const cases: [string, string][] = [
      ['vim', '[sim] vim: vim without a file name is not simulated yet\n[sim] give the file to edit: vim FILE\n'],
      ['vim -R f', '[sim] vim: the option -R is not simulated yet\n'],
      ['vim +3 f', '[sim] vim: the option +3 is not simulated yet\n'],
      ['nano a b', '[sim] nano: editing several files at once is not simulated yet\n'],
      ['vim /etc', '[sim] vim: editing a directory is not simulated yet\n'],
      ['ex f', "[sim] ex: vim's Ex mode is not simulated yet\n"],
      ['echo x | vim f', '[sim] vim: vim without a terminal is not simulated yet\n'],
    ];
    for (const [cmd, out] of cases) expect(w.s.run(cmd), cmd).toMatchObject({ output: out, status: 250 });
    expect(w.gaps.length).toBe(cases.length);
  });
});
