// The workspace's keyboard shortcuts. All use Ctrl+Shift: a terminal sends the same byte for
// Ctrl+Shift+<letter> as for Ctrl+<letter>, so taking the shifted chords costs the shell nothing,
// and none of these is a chord the browser keeps for itself.

export type Shortcut = 'check' | 'hint' | 'newTerminal' | 'closeTerminal' | 'tab' | 'panel' | 'pause' | 'labs' | 'help' | 'copy';

export interface ShortcutInfo {
  id: Shortcut;
  keys: string;
  what: string;
}

export const SHORTCUTS: ShortcutInfo[] = [
  { id: 'check', keys: 'Ctrl+Shift+Enter', what: 'Check the lab' },
  { id: 'hint', keys: 'Ctrl+Shift+H', what: 'Show the next hint' },
  { id: 'newTerminal', keys: 'Ctrl+Shift+E', what: 'Open another terminal' },
  { id: 'closeTerminal', keys: 'Ctrl+Shift+X', what: 'Close this terminal' },
  { id: 'tab', keys: 'Ctrl+Shift+1…9', what: 'Go to terminal 1…9' },
  { id: 'panel', keys: 'Ctrl+Shift+L', what: 'Show or hide the lab panel' },
  { id: 'pause', keys: 'Ctrl+Shift+Space', what: 'Pause or resume time' },
  { id: 'labs', keys: 'Ctrl+Shift+O', what: 'Open the lab list' },
  { id: 'copy', keys: 'Ctrl+Shift+C / V', what: 'Copy the selection / paste' },
  { id: 'help', keys: 'Ctrl+Shift+?', what: 'Show these shortcuts' },
];

export interface Matched {
  id: Shortcut;
  /** For `tab`: the terminal's position, 0-based. */
  index?: number;
}

/** The shortcut a key event is, if any. Ctrl+Shift+V is left alone: the browser pastes it. */
export function matchShortcut(e: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code' | 'key'>): Matched | undefined {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return undefined;
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) return { id: 'tab', index: Number(digit[1]) - 1 };
  switch (e.code) {
    case 'Enter':
    case 'NumpadEnter':
      return { id: 'check' };
    case 'KeyH':
      return { id: 'hint' };
    case 'KeyE':
      return { id: 'newTerminal' };
    case 'KeyX':
      return { id: 'closeTerminal' };
    case 'KeyL':
      return { id: 'panel' };
    case 'Space':
      return { id: 'pause' };
    case 'KeyO':
      return { id: 'labs' };
    case 'KeyC':
      return { id: 'copy' };
    case 'Slash':
      return { id: 'help' };
    default:
      return undefined;
  }
}

/** Ctrl+Shift+V: the terminal must not see it as Ctrl+V, so the browser's paste event reaches it. */
export function isPasteChord(e: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code'>): boolean {
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyV';
}
