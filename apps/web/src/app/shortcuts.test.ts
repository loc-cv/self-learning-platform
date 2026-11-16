import { expect, test } from 'vitest';
import { isPasteChord, matchShortcut } from './shortcuts.ts';

const key = (code: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = { ctrlKey: true, shiftKey: true }) => ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, key: '', code, ...mods });

test('Ctrl+Shift chords are the workspace shortcuts; the shell keeps everything else', () => {
  expect(matchShortcut(key('Enter'))).toEqual({ id: 'check' });
  expect(matchShortcut(key('Digit3'))).toEqual({ id: 'tab', index: 2 });
  expect(matchShortcut(key('KeyH'))).toEqual({ id: 'hint' });
  expect(matchShortcut(key('Slash'))).toEqual({ id: 'help' });
  // Ctrl+H is backspace and Ctrl+E end-of-line for readline.
  expect(matchShortcut(key('KeyH', { ctrlKey: true }))).toBeUndefined();
  expect(matchShortcut(key('KeyE', { ctrlKey: true }))).toBeUndefined();
  expect(matchShortcut(key('KeyE', { ctrlKey: true, shiftKey: true, altKey: true }))).toBeUndefined();
  expect(matchShortcut(key('KeyV'))).toBeUndefined();
  expect(isPasteChord(key('KeyV'))).toBe(true);
  expect(isPasteChord(key('KeyV', { ctrlKey: true }))).toBe(false);
});
