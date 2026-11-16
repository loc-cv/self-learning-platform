import { expect, test } from 'vitest';
import { isBrowserChord, isPasteChord, matchShortcut, neighbourTab, SHORTCUTS } from './shortcuts.ts';

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

test('previous and next terminal, full screen, and copy whatever is selected', () => {
  expect(matchShortcut(key('PageUp'))).toEqual({ id: 'prevTab' });
  expect(matchShortcut(key('PageDown'))).toEqual({ id: 'nextTab' });
  expect(matchShortcut(key('KeyF'))).toEqual({ id: 'fullscreen' });
  expect(matchShortcut(key('KeyY'))).toEqual({ id: 'xray' });
  // Ctrl+Y is readline's yank: the X-ray takes only the shifted chord.
  expect(matchShortcut(key('KeyY', { ctrlKey: true }))).toBeUndefined();
  // Ctrl+Shift+C is a shortcut with or without a selection: unclaimed, Chrome opens DevTools.
  expect(matchShortcut(key('KeyC'))).toEqual({ id: 'copy' });
  // Shift+PageUp scrolls the terminal and Ctrl+F is forward-char: neither is taken.
  expect(matchShortcut(key('PageUp', { shiftKey: true }))).toBeUndefined();
  expect(matchShortcut(key('KeyF', { ctrlKey: true }))).toBeUndefined();
  expect(neighbourTab(0, 3, -1)).toBe(2);
  expect(neighbourTab(2, 3, 1)).toBe(0);
  expect(neighbourTab(1, 3, 1)).toBe(2);
  expect(neighbourTab(0, 1, 1)).toBe(0);
});

test('the chords the browser keeps in a tab', () => {
  for (const code of ['KeyW', 'KeyT', 'KeyN']) expect(isBrowserChord(key(code, { ctrlKey: true }))).toBe(true);
  expect(isBrowserChord(key('KeyW'))).toBe(false);
  expect(isBrowserChord(key('KeyW', { ctrlKey: true, altKey: true }))).toBe(false);
  expect(isBrowserChord(key('KeyR', { ctrlKey: true }))).toBe(false);
});

test('every shortcut the help lists is one the matcher knows', () => {
  const codes = ['Enter', 'KeyH', 'KeyE', 'KeyX', 'Digit1', 'PageUp', 'PageDown', 'KeyL', 'KeyY', 'Space', 'KeyO', 'KeyC', 'KeyF', 'Slash'];
  const matched = new Set(codes.map((c) => matchShortcut(key(c))?.id));
  // PageDown is listed on PageUp's line.
  for (const s of SHORTCUTS) expect(matched.has(s.id), s.id).toBe(true);
});
