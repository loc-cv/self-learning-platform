// The workspace's keyboard shortcuts. All use Ctrl+Shift: a terminal sends the same byte for
// Ctrl+Shift+<letter> as for Ctrl+<letter>, so taking the shifted chords costs the shell nothing.
// The browser gives every one of them to the page first, but it acts on some itself unless the
// page claims the event (Chrome: Ctrl+Shift+C opens DevTools, Ctrl+Shift+PageUp/PageDown moves
// the browser tab), so the workspace claims each chord here every time, whether or not it has
// something to do (docs/decisions.md D-112).
//
// Chords the browser never gives to a page in an ordinary tab (Ctrl+W, Ctrl+T, Ctrl+N) cannot be
// shortcuts at all; `isBrowserChord` is for the windows where the page does get them (D-113).

export type Shortcut = 'check' | 'hint' | 'newTerminal' | 'closeTerminal' | 'tab' | 'prevTab' | 'nextTab' | 'panel' | 'pause' | 'labs' | 'help' | 'copy' | 'fullscreen' | 'xray';

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
  { id: 'prevTab', keys: 'Ctrl+Shift+PgUp / PgDn', what: 'Go to the previous / next terminal' },
  { id: 'panel', keys: 'Ctrl+Shift+L', what: 'Show or hide the lab panel' },
  { id: 'xray', keys: 'Ctrl+Shift+Y', what: 'Open or close the X-ray (counts as help)' },
  { id: 'pause', keys: 'Ctrl+Shift+Space', what: 'Pause or resume time' },
  { id: 'labs', keys: 'Ctrl+Shift+O', what: 'Open the lab list' },
  { id: 'copy', keys: 'Ctrl+Shift+C / V', what: 'Copy the selection / paste' },
  { id: 'fullscreen', keys: 'Ctrl+Shift+F', what: 'Full screen: every key reaches the shell' },
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
    case 'KeyY':
      return { id: 'xray' };
    case 'Space':
      return { id: 'pause' };
    case 'KeyO':
      return { id: 'labs' };
    case 'KeyC':
      return { id: 'copy' };
    case 'KeyF':
      return { id: 'fullscreen' };
    case 'PageUp':
      return { id: 'prevTab' };
    case 'PageDown':
      return { id: 'nextTab' };
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

/**
 * Ctrl+W, Ctrl+T, Ctrl+N: close tab, new tab and new window in the browser; unix-word-rubout,
 * transpose-chars and next-history in the shell. In an ordinary tab the browser acts on them and
 * the page never sees the key. In full screen and in an installed app window the page gets them
 * (Chromium: chrome/browser/ui/browser_command_controller.cc IsReservedCommandOrKey, "In Apps
 * mode, no keys are reserved"; in fullscreen only the exit and fullscreen commands are), and the
 * workspace then keeps the browser from acting on one the terminal or the editor left alone.
 */
export function isBrowserChord(e: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code'>): boolean {
  return e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.code === 'KeyW' || e.code === 'KeyT' || e.code === 'KeyN');
}

/** The terminal to go to from `active` (0-based) among `count`, wrapping at the ends. */
export function neighbourTab(active: number, count: number, step: -1 | 1): number {
  return count === 0 ? 0 : (active + step + count) % count;
}
