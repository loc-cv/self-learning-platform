// The top bar: where you are, the clock with its pause, the [sim] notices of this session, the
// settings and the keyboard shortcuts.

import { useEffect, useRef, type ReactNode } from 'react';
import type { Clock } from '../protocol.ts';
import type { GapEntry, SinkState } from './gaps.ts';
import { SHORTCUTS } from './shortcuts.ts';
import type { Settings } from './storage.ts';
import { Button, formatElapsed, Icon } from './ui.tsx';

export type Popover = 'gaps' | 'settings' | 'help' | undefined;

interface Props {
  title?: string;
  clock?: Clock;
  gaps: GapEntry[];
  sink: SinkState;
  settings: Settings;
  panelOpen: boolean;
  popover: Popover;
  setPopover(p: Popover): void;
  setSettings(s: Settings): void;
  togglePause(): void;
  togglePanel(): void;
  openLabs(): void;
  fullscreen: boolean;
  toggleFullscreen(): void;
}

function Pop({ children, onClose, label }: { children: ReactNode; onClose(): void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.topbar-trigger')) onClose();
    };
    // Capture phase: the Escape that closes the popover must not reach the shell (ESC is meta).
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);
  return (
    <div className="popover" ref={ref} role="dialog" aria-label={label}>
      {children}
    </div>
  );
}

function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? 'is-on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TopBar(p: Props) {
  const toggle = (which: Popover) => () => p.setPopover(p.popover === which ? undefined : which);
  const close = () => p.setPopover(undefined);
  const fresh = p.gaps.filter((g) => !g.replayed).length;
  return (
    <header className="topbar">
      <div className="brand" aria-label="Simlab">
        <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="var(--brand-bg)" />
          <path d="M8 11l6 5-6 5" stroke="var(--accent)" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M16 22h8" stroke="var(--text)" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
        <span>simlab</span>
      </div>
      <Button variant="ghost" small className="topbar-trigger" shortcut="Ctrl+Shift+L" title={p.panelOpen ? 'Hide the lab panel' : 'Show the lab panel'} aria-pressed={p.panelOpen} onClick={p.togglePanel}>
        <Icon name="panel" />
      </Button>
      <Button variant="ghost" small shortcut="Ctrl+Shift+O" title="All labs" onClick={p.openLabs}>
        <Icon name="list" />
        Labs
      </Button>
      <div className="topbar-title">{p.title ?? ''}</div>
      {p.clock ? (
        <div className={`clock${p.clock.paused ? ' is-paused' : ''}`}>
          <span className="clock-time" title="Time spent in the lab (virtual time, over every attempt)">
            {formatElapsed(p.clock.elapsed)}
          </span>
          <Button variant="ghost" small shortcut="Ctrl+Shift+Space" title={p.clock.paused ? 'Resume time' : 'Pause time: nothing in the world moves'} onClick={p.togglePause}>
            <Icon name={p.clock.paused ? 'play' : 'pause'} />
            {p.clock.paused ? 'Paused' : null}
          </Button>
        </div>
      ) : null}
      <div className="topbar-right">
        <Button variant="ghost" small className={`topbar-trigger gap-trigger${p.gaps.length > 0 ? ' has-gaps' : ''}`} title="Simulator notices this session" onClick={toggle('gaps')}>
          <span className="sim-tag">[sim]</span>
          <span className="gap-count">{p.gaps.length}</span>
        </Button>
        <Button variant="ghost" small shortcut="Ctrl+Shift+F" title={p.fullscreen ? 'Leave full screen' : 'Full screen: Ctrl+W, Ctrl+T and Ctrl+N reach the shell'} aria-pressed={p.fullscreen} onClick={p.toggleFullscreen}>
          <Icon name={p.fullscreen ? 'shrink' : 'expand'} />
        </Button>
        <Button variant="ghost" small className="topbar-trigger" title="Settings" onClick={toggle('settings')}>
          <Icon name="gear" />
        </Button>
        <Button variant="ghost" small className="topbar-trigger" shortcut="Ctrl+Shift+?" title="Keyboard shortcuts" onClick={toggle('help')}>
          <Icon name="keyboard" />
        </Button>
      </div>
      {p.popover === 'gaps' ? (
        <Pop onClose={close} label="Simulator notices">
          <h2>Simulator notices</h2>
          <p className="pop-lead">Things you tried that the simulator does not cover yet. Each one is a note for the next round of work, not a mistake of yours.</p>
          {p.gaps.length === 0 ? (
            <p className="pop-empty">None so far.</p>
          ) : (
            <ul className="gap-list">
              {[...p.gaps].reverse().map((g, i) => (
                <li key={i}>
                  <div className="gap-what">
                    <code>{g.gap.program}</code> {g.gap.what}
                    {g.replayed ? <span className="pill">earlier</span> : null}
                  </div>
                  <code className="gap-line">{g.gap.commandLine}</code>
                </li>
              ))}
            </ul>
          )}
          <p className="pop-foot">{fresh === 0 ? 'Notices are appended to data/gaps.jsonl.' : p.sink === 'unreachable' ? 'The local server did not take them: they are not in data/gaps.jsonl.' : 'Appended to data/gaps.jsonl.'}</p>
        </Pop>
      ) : null}
      {p.popover === 'settings' ? (
        <Pop onClose={close} label="Settings">
          <h2>Settings</h2>
          <div className="setting">
            <span>Theme</span>
            <Segmented value={p.settings.theme} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} onChange={(theme) => p.setSettings({ ...p.settings, theme })} />
          </div>
          <div className="setting">
            <span>
              Editor keys
              <small>for vim, vi and kubectl edit</small>
            </span>
            <Segmented value={p.settings.editorKeys} options={[{ value: 'vim', label: 'Vim' }, { value: 'plain', label: 'Plain' }]} onChange={(editorKeys) => p.setSettings({ ...p.settings, editorKeys })} />
          </div>
          <div className="setting">
            <span>Terminal text</span>
            <Segmented value={p.settings.fontSize} options={[12, 13, 14, 15, 16].map((n) => ({ value: n, label: String(n) }))} onChange={(fontSize) => p.setSettings({ ...p.settings, fontSize })} />
          </div>
        </Pop>
      ) : null}
      {p.popover === 'help' ? (
        <Pop onClose={close} label="Keyboard shortcuts">
          <h2>Keyboard shortcuts</h2>
          <table className="keys">
            <tbody>
              {SHORTCUTS.map((s) => (
                <tr key={s.id}>
                  <td>
                    <kbd>{s.keys}</kbd>
                  </td>
                  <td>{s.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="pop-foot">Every other key goes to the shell, Ctrl+C, Ctrl+R and Tab included.</p>
          <p className="pop-foot">
            In a browser tab, Chrome and Edge keep <kbd>Ctrl+W</kbd>, <kbd>Ctrl+T</kbd> and <kbd>Ctrl+N</kbd> for themselves. In full screen, or with Simlab installed as an app (the install button in the address bar), they reach the shell.
          </p>
          <p className="pop-foot">
            An extension that adds vim keys to pages (Vimium) takes <kbd>Esc</kbd> before the editor sees it: exclude this address in the extension's settings.
          </p>
        </Pop>
      ) : null}
    </header>
  );
}
