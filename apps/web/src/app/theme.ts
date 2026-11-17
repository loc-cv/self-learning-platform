// Terminal colors for the two themes: a terminal's own palette, whatever the interface's look.
// xterm needs concrete values. The background and the default foreground are the tokens
// `--term-bg` and `--term-fg` (tokens.css), read from the page so the terminal's surface is the
// pane it sits in; the cursor and the sixteen ANSI colors are kept here.

import type { ITheme } from '@xterm/xterm';

export const TERMINAL_THEMES: Record<'dark' | 'light', ITheme> = {
  dark: {
    cursor: '#9cc7f0',
    selectionBackground: 'rgba(127, 180, 230, 0.30)',
    black: '#1c2229',
    red: '#e07b7b',
    green: '#8cc79a',
    yellow: '#dcbf7a',
    blue: '#7fb0e0',
    magenta: '#c39ad8',
    cyan: '#79c2c4',
    white: '#c9d1da',
    brightBlack: '#5c6673',
    brightRed: '#f09191',
    brightGreen: '#a3d9b0',
    brightYellow: '#ebd294',
    brightBlue: '#9cc7f0',
    brightMagenta: '#d5b0ea',
    brightCyan: '#95d6d8',
    brightWhite: '#eef2f6',
  },
  light: {
    cursor: '#2f6fb0',
    selectionBackground: 'rgba(47, 111, 176, 0.22)',
    black: '#24292f',
    red: '#b8312f',
    green: '#2b7a3d',
    yellow: '#8a6a00',
    blue: '#2659a5',
    magenta: '#8a3fa0',
    cyan: '#1f7a80',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#d1453b',
    brightGreen: '#3a8f4e',
    brightYellow: '#a07d00',
    brightBlue: '#3a72c2',
    brightMagenta: '#a050b8',
    brightCyan: '#2a8f95',
    brightWhite: '#3d444d',
  },
};

/** The theme for xterm: the palette above on the terminal surface the tokens define. */
export function terminalTheme(theme: 'dark' | 'light'): ITheme {
  const base = TERMINAL_THEMES[theme];
  if (typeof document === 'undefined') return base;
  const css = getComputedStyle(document.documentElement);
  const background = css.getPropertyValue('--term-bg').trim();
  const foreground = css.getPropertyValue('--term-fg').trim();
  return { ...base, ...(background ? { background, cursorAccent: background } : {}), ...(foreground ? { foreground } : {}) };
}

export const MONO_FONT = '"JetBrains Mono", "Fira Mono", "DejaVu Sans Mono", "Cascadia Mono", Menlo, Consolas, monospace';
