// Full screen with the keyboard locked (docs/decisions.md D-113). In an ordinary tab the browser
// keeps Ctrl+W, Ctrl+T and Ctrl+N; in full screen it gives them to the page. Full screen entered
// by the page ends on Escape unless the keyboard is locked, and vim needs Escape, so the lock is
// requested first, as the Keyboard Lock specification recommends (wicg.github.io/keyboard-lock:
// "we recommend that developers call lock() before they enter fullscreen"); holding Escape for
// two seconds then leaves full screen. Browsers without the API still enter full screen.

interface KeyboardLock {
  lock(keys?: string[]): Promise<void>;
  unlock(): void;
}

const keyboard = (): KeyboardLock | undefined => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;

export const isFullscreen = (): boolean => document.fullscreenElement !== null;

export function toggleFullscreen(): void {
  if (isFullscreen()) {
    void document.exitFullscreen().catch(() => undefined);
    return;
  }
  void keyboard()?.lock?.().catch(() => undefined);
  void document.documentElement.requestFullscreen().catch(() => undefined);
}

/** Calls `fn` when full screen starts or ends, and releases the keyboard when it ends. */
export function watchFullscreen(fn: (on: boolean) => void): () => void {
  const change = (): void => {
    if (!isFullscreen()) keyboard()?.unlock?.();
    fn(isFullscreen());
  };
  document.addEventListener('fullscreenchange', change);
  return () => document.removeEventListener('fullscreenchange', change);
}
