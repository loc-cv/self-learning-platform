import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { E37, E45, E492, EX_COMMANDS, fileInfo, isVimCommand, MODES, written } from './vimref.ts';

const ref = JSON.parse(readFileSync(new URL('../../../../fixtures/reference/vim/messages.json', import.meta.url), 'utf8')) as Record<string, string> & { exCommands: string[] };

test('the overlay says what the captured vim says', () => {
  expect(fileInfo('f.yaml', 'a: 1\nb: 2\n')).toBe(ref['open']);
  expect(fileInfo('new.yaml', '', { isNew: true })).toBe(ref['openNew']);
  expect(fileInfo('ro.yaml', 'a: 1\n', { readOnly: true })).toBe(ref['openReadonly']);
  expect(fileInfo('nonl.yaml', 'a\nb')).toBe(ref['openNoEol']);
  expect(written('f.yaml', ': 1\nb: 2\n', false)).toBe(ref['written']);
  expect(written('n2.yaml', 'hello\n', true)).toBe(ref['writtenNew']);
  expect(written('f.yaml', '', false)).toBe(ref['writtenEmpty']);
  expect(E37).toBe(ref['E37']);
  expect(E45).toBe(ref['E45']);
  expect(E492('foo')).toBe(ref['E492']);
  expect([MODES['insert'], MODES['replace'], MODES['visual'], MODES['visual-linewise'], MODES['visual-blockwise']]).toEqual([ref['modeInsert'], ref['modeReplace'], ref['modeVisual'], ref['modeVisualLine'], ref['modeVisualBlock']]);
  expect(EX_COMMANDS).toEqual(ref.exCommands);
});

test('vim command names and their prefixes are known, other words are not', () => {
  expect(isVimCommand('sp')).toBe(true);
  expect(isVimCommand('vsplit')).toBe(true);
  expect(isVimCommand('e')).toBe(true);
  expect(isVimCommand('foo')).toBe(false);
  expect(isVimCommand('')).toBe(false);
});
