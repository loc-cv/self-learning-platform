// Script mode (`npm run sim`): the screen it prints, transcript format, directives.

import { describe, expect, test } from 'vitest';
import { runScript, unescapeKeys, type ScriptOptions } from './script.ts';

const opts = (o: Partial<ScriptOptions> = {}): ScriptOptions => ({ topology: 'ubuntu-1', seed: 1, cols: 80, rows: 24, step: 0, timeout: 3_600_000, mode: 'screen', ...o });

describe('script mode', () => {
  test('prints the screen: prompts, commands and output', () => {
    const r = runScript(['cd /tmp', 'echo hi | cat'], opts());
    expect(r.output).toBe('student@node01:~$ cd /tmp\nstudent@node01:/tmp$ echo hi | cat\nhi\nstudent@node01:/tmp$\n');
    expect(r.notes).toEqual([]);
  });

  test('transcript format, with continuation lines and exit statuses', () => {
    const r = runScript(['cat <<EOF', 'x', 'EOF', 'false'], opts({ mode: 'transcript' }));
    expect(r.output).toBe('$ cat <<EOF\n> x\n> EOF\nx\n$ false\n[exit 1]\n');
  });

  test('@advance lets virtual time pass; @keys types raw keys; a long command is noted', () => {
    const r = runScript(['date +%T', '@advance 90s', 'date +%T', '@keys sleep 50\\r', '@keys \\x03', 'echo $?'], opts({ timeout: 10_000 }));
    expect(r.output).toContain('date +%T\n09:00:00\n');
    expect(r.output).toContain('date +%T\n09:01:30\n');
    expect(r.output).toContain('sleep 50\n^C\n');
    expect(r.output).toContain('echo $?\n130\n');
  });

  test('@editor supplies what the next editor saves', () => {
    const r = runScript(['@editor <<EOF', 'line one', 'EOF', 'nano f', 'cat f', 'vi g'], opts());
    expect(r.output).toContain('$ cat f\nline one\n');
    expect(r.notes).toEqual(['editor for /home/student/g closed without saving (no @editor content)']);
  });

  test('--step and the same seed give the same world', () => {
    const a = runScript(['touch a', 'touch b'], opts({ step: 1000 }));
    const b = runScript(['touch a', 'touch b'], opts({ step: 1000 }));
    expect(a.hash).toBe(b.hash);
  });

  test('key escapes', () => {
    expect(unescapeKeys('a\\tb\\x03\\e[A\\\\')).toBe('a\tb\x03\x1b[A\\');
  });
});
