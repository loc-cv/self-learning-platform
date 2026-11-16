// One terminal tab: an xterm.js view wired to an engine TTY. Bytes go both ways and nothing else
// (docs/ARCHITECTURE.md §3.6): the engine keeps no screen, xterm.js does. The view outlives its
// TTY: when the shell exits, Enter starts a new login shell in the same view.

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { EngineClient } from './engine.ts';
import { isPasteChord, matchShortcut } from './shortcuts.ts';
import { MONO_FONT, TERMINAL_THEMES } from './theme.ts';

export interface Tab {
  key: number;
  tty?: string;
  ended: boolean;
  /** The size the TTY had when it was recorded (resume), applied before its output is written. */
  size?: { cols: number; rows: number };
  /** The window title the shell set (OSC 0/2), as a terminal emulator shows it on the tab. */
  title?: string;
}

export interface TerminalHandle {
  focus(): void;
  hasSelection(): boolean;
  selection(): string;
  /** Types text as if the user had (keys pressed while focus was elsewhere). */
  input(data: string): void;
  /** The visible screen as text, one string per row (tests and the latency probe). */
  screen(): string[];
  /** The cursor's row up to the cursor: the prompt and what is typed after it. */
  beforeCursor(): string;
  /** Calls `fn` after each write has been parsed into the screen. */
  onParsed(fn: () => void): () => void;
}

interface Props {
  client: EngineClient;
  tab: Tab;
  active: boolean;
  theme: 'dark' | 'light';
  fontSize: number;
  /** Keyboard input goes to the editor overlay instead. */
  covered: boolean;
  onOpened(key: number, tty: string): void;
  onRelaunch(key: number): void;
  onTitle(key: number, title: string): void;
  register(key: number, handle: TerminalHandle | null): void;
}

export function TerminalView(p: Props) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fitter = useRef<FitAddon | null>(null);
  const tty = useRef<string | undefined>(p.tab.tty);
  const ended = useRef(p.tab.ended);
  const props = useRef(p);
  props.current = p;
  tty.current = p.tab.tty;
  ended.current = p.tab.ended;

  const fit = (): void => {
    const t = term.current;
    const f = fitter.current;
    if (!t || !f || !host.current || host.current.clientWidth === 0) return;
    const d = f.proposeDimensions();
    if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows) || d.cols < 2 || d.rows < 2) return;
    if (d.cols === t.cols && d.rows === t.rows) return;
    t.resize(d.cols, d.rows);
    if (tty.current && !ended.current) props.current.client.send({ type: 'tty.resize', tty: tty.current, cols: d.cols, rows: d.rows });
  };

  useEffect(() => {
    const t = new Terminal({
      fontFamily: MONO_FONT,
      fontSize: props.current.fontSize,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      scrollback: 10_000,
      theme: TERMINAL_THEMES[props.current.theme],
      allowProposedApi: false,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current as HTMLDivElement);
    term.current = t;
    fitter.current = f;
    const size = props.current.tab.size;
    if (size) t.resize(size.cols, size.rows);
    // Workspace shortcuts and Ctrl+Shift+V never reach the shell (shortcuts.ts).
    t.attachCustomKeyEventHandler((e) => !(matchShortcut(e) || isPasteChord(e)));
    const data = t.onData((d) => {
      const id = tty.current;
      if (ended.current) {
        if (d === '\r') props.current.onRelaunch(props.current.tab.key);
        return;
      }
      if (id) props.current.client.send({ type: 'tty.bytes', tty: id, data: d });
    });
    const title = t.onTitleChange((s) => props.current.onTitle(props.current.tab.key, s));
    const parsed = new Set<() => void>();
    const onParsed = t.onWriteParsed(() => {
      for (const fn of parsed) fn();
    });
    props.current.register(props.current.tab.key, {
      focus: () => t.focus(),
      hasSelection: () => t.hasSelection(),
      selection: () => t.getSelection(),
      input: (d) => t.input(d, true),
      screen() {
        const b = t.buffer.active;
        const rows: string[] = [];
        for (let y = 0; y < t.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
        return rows;
      },
      beforeCursor() {
        const b = t.buffer.active;
        return b.getLine(b.baseY + b.cursorY)?.translateToString(false, 0, b.cursorX) ?? '';
      },
      onParsed(fn) {
        parsed.add(fn);
        return () => parsed.delete(fn);
      },
    });
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(host.current as HTMLDivElement);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      data.dispose();
      title.dispose();
      onParsed.dispose();
      props.current.register(props.current.tab.key, null);
      t.dispose();
      term.current = null;
    };
  }, []);

  // A TTY for this view: opened at the view's size, or the recorded one attached.
  useEffect(() => {
    const t = term.current;
    if (!t) return undefined;
    if (!p.tab.tty) {
      if (!p.tab.ended) {
        fit();
        void p.client.openTty(t.cols, t.rows).then((id) => props.current.onOpened(p.tab.key, id));
      }
      return undefined;
    }
    const detach = p.client.attach(p.tab.tty, (d) => t.write(d));
    // A resumed TTY was recorded at another size: the shell redraws its line after the resize.
    requestAnimationFrame(fit);
    return detach;
  }, [p.tab.tty, p.tab.ended]);

  useEffect(() => {
    const t = term.current;
    if (!t) return;
    t.options.theme = TERMINAL_THEMES[p.theme];
    t.options.fontSize = p.fontSize;
    requestAnimationFrame(fit);
  }, [p.theme, p.fontSize]);

  useEffect(() => {
    if (p.active && !p.covered) {
      requestAnimationFrame(() => {
        fit();
        term.current?.focus();
      });
    }
  }, [p.active, p.covered]);

  return <div className={`terminal-view${p.active ? ' is-active' : ''}`} ref={host} aria-hidden={!p.active} />;
}
