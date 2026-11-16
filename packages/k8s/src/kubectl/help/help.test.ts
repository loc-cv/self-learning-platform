// Unit tests of the help module's pieces. The help text itself is compared with captures of the
// real binary in tools/src/golden/help.test.ts.

import { validateProvenance } from '@simlab/kernel';
import { describe, expect, test } from 'vitest';
import { manifest } from '../manifest.ts';
import { helpCommand, helpRun, HELP_RUN } from './commands.ts';
import { findCommand } from './find.ts';
import { goQuote, goSharpQuoteSlice } from './goquote.ts';
import { HELP_PROVENANCE } from './provenance.ts';
import { terminalLimit, wrapString } from './wordwrap.ts';

describe('wrapString (go-wordwrap)', () => {
  test('breaks at the last space that keeps a line within the limit, dropping that space', () => {
    expect(wrapString('aaa bbb ccc', 7)).toBe('aaa bbb\nccc');
  });

  test('never breaks a word longer than the limit', () => {
    expect(wrapString('abcdefghij k', 5)).toBe('abcdefghij\nk');
  });

  test('keeps existing newlines and the indentation after them', () => {
    expect(wrapString('a b\n  c d', 3)).toBe('a b\n  c\nd');
  });

  test('counts runes, not UTF-16 units', () => {
    expect(wrapString('ééé ééé', 7)).toBe('ééé ééé');
  });

  test('an infinite limit changes nothing', () => {
    const s = 'x '.repeat(200) + '  \t end  ';
    expect(wrapString(s, Infinity)).toBe(s);
  });

  test('the terminal limit steps at 80, 100 and 120 columns', () => {
    expect([undefined, 79, 80, 99, 100, 119, 120, 300].map(terminalLimit)).toEqual([0, 0, 80, 80, 100, 100, 120, 120]);
  });
});

describe('Go quoting', () => {
  test('%q escapes like strconv.Quote', () => {
    expect(goQuote('a b')).toBe('"a b"');
    expect(goQuote('a"b\\c\td\x01\x7f')).toBe('"a\\"b\\\\c\\td\\x01\\x7f"');
    expect(goQuote('­')).toBe('"\\u00ad"');
  });

  test('%#q backquotes when it can (outputs of the real kubectl help)', () => {
    expect(goSharpQuoteSlice(['nosuch'])).toBe('[`nosuch`]');
    expect(goSharpQuoteSlice(['a`b', 'c'])).toBe('["a`b" `c`]');
    expect(goSharpQuoteSlice(['a\tb'])).toBe('[`a\tb`]');
    expect(goSharpQuoteSlice(['a"b'])).toBe('[`a"b`]');
  });
});

describe('findCommand (cobra Find)', () => {
  const m = manifest();

  test('walks names and aliases and keeps the words after the command', () => {
    expect(findCommand(m, ['create', 'deploy', 'x'])).toEqual({ path: 'create deployment', args: ['x'] });
    expect(findCommand(m, ['get', 'pods'])).toEqual({ path: 'get', args: ['pods'] });
    expect(findCommand(m, [])).toEqual({ path: '', args: [] });
    expect(findCommand(m, ['options'])).toEqual({ path: 'options', args: [] });
  });

  test('an unknown first word is an error; an unknown later word is an argument', () => {
    expect(findCommand(m, ['nosuch'])).toEqual({ error: 'unknown command "nosuch" for "kubectl"' });
    expect(findCommand(m, ['create', 'nosuch'])).toEqual({ path: 'create', args: ['nosuch'] });
  });

  test('skips flags and the values of flags that take one', () => {
    expect(findCommand(m, ['-n', 'x', 'get', 'pods'])).toEqual({ path: 'get', args: ['-n', 'x', 'pods'] });
    expect(findCommand(m, ['--v=3', 'get'])).toEqual({ path: 'get', args: ['--v=3'] });
  });
});

describe('help behaviors', () => {
  test('kubectl help <unknown> prints the topic and kubectl usage on standard error, exit 0', () => {
    const r = helpCommand(['a', 'b']);
    expect(r.stdout).toBe('');
    expect(r.exit).toBe(0);
    expect(r.stderr.startsWith('Unknown help topic [`a` `b`]\n\n\nBasic Commands (Beginner):\n')).toBe(true);
  });

  test('a command group run with words is an unknown command', () => {
    expect(helpRun('set', ['x', 'y'])).toEqual({ stdout: '', stderr: `error: unknown command "x y"\nSee 'kubectl set -h' for help and examples\n`, exit: 1 });
  });

  test('every command of HELP_RUN is in the manifest and has subcommands', () => {
    for (const p of Object.keys(HELP_RUN)) expect(manifest().commands.find((c) => c.path === p)?.subcommands.length).toBeGreaterThan(0);
  });

  test('other commands have no help run', () => {
    expect(helpRun('get', [])).toBeUndefined();
  });
});

test('provenance entries are valid', () => {
  expect(validateProvenance(HELP_PROVENANCE)).toEqual([]);
});
