// The top bar: where you are, the clock with the time controls (pause, speed, skip to the next
// event), the [sim] notices of this session, the settings and the keyboard shortcuts.

import { useEffect, useRef, type ReactNode } from 'react';
import type { Assist } from '@simlab/learn';
import { SPEEDS, type Clock } from '../protocol.ts';
import { formatJump } from './timeline.ts';
import type { GapEntry, SinkState } from './gaps.ts';
import { SHORTCUTS } from './shortcuts.ts';
import type { SyncState } from './progress.ts';
import type { Lang, Settings } from './storage.ts';
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
  setSpeed(speed: number): void;
  /** To the next moment something shows. */
  skip(): void;
  /** What the last skip did, while it is worth saying. */
  skipNote?: SkipNote;
  /** The assist level of the attempt on screen, when one is. */
  attemptAssist?: Assist;
  togglePanel(): void;
  /** Undefined when there is no lab to look at. */
  xrayOpen?: boolean;
  toggleXray(): void;
  openLabs(): void;
  home(): void;
  atHome: boolean;
  /** An item with a terminal is on screen: the panel toggle makes sense. */
  inWorkspace: boolean;
  /** Whether the progress log reaches the server. */
  sync: SyncState;
  /** The daily session, while it runs. */
  session?: SessionBar;
  fullscreen: boolean;
  toggleFullscreen(): void;
}

/** A skip's answer: whether it found something to show and how far it jumped; `n` tells two apart. */
export interface SkipNote {
  found: boolean;
  by: number;
  n: number;
}

/** The assist levels as the settings offer them (docs/LEARNING_MODEL.md §13). */
const ASSISTS: { value: Assist; label: string; means: string }[] = [
  { value: 'full', label: 'Full', means: 'the X-ray, with Why? and the timeline' },
  { value: 'view', label: 'View', means: 'the X-ray shows the world, and explains nothing' },
  { value: 'off', label: 'Off', means: 'no X-ray: the terminal and the ticket only' },
];

export interface SessionBar {
  /** Items the session went through, and how many it holds with the ones ahead. */
  done: number;
  total: number;
  /** Minutes of today's time box not yet spent. */
  minutesLeft: number;
  /** The item on screen is finished or given up: the next one can open. */
  over: boolean;
  next(): void;
  skip(): void;
  stop(): void;
}

const LANGS: { value: Lang; label: string; title: string }[] = [
  { value: 'en', label: 'EN', title: 'Prose in English' },
  { value: 'vi', label: 'VI', title: 'Prose in Vietnamese where it is translated' },
  { value: 'both', label: 'EN·VI', title: 'English and Vietnamese side by side' },
];

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
      <button type="button" className="brand" aria-label="Simlab: home" title="Home (Ctrl+Shift+D)" aria-current={p.atHome ? 'page' : undefined} onMouseDown={(e) => e.preventDefault()} onClick={p.home}>
        <span className="brand-mark">
          <svg width="16" height="16" viewBox="4 4 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 11l6 5-6 5" />
            <path d="M16 22h8" />
          </svg>
        </span>
        <span>simlab</span>
      </button>
      {p.inWorkspace ? (
        <Button variant="ghost" small className="topbar-trigger" shortcut="Ctrl+Shift+L" title={p.panelOpen ? 'Hide the lab panel' : 'Show the lab panel'} aria-pressed={p.panelOpen} onClick={p.togglePanel}>
          <Icon name="panel" />
        </Button>
      ) : null}
      <Button variant="ghost" small shortcut="Ctrl+Shift+O" title="Browse all content" onClick={p.openLabs}>
        <Icon name="list" />
        Browse
      </Button>
      {p.session ? (
        <div className="session-bar" role="group" aria-label="Today's session">
          <span className="session-label">Session</span>
          <span className="session-pips" role="img" aria-label={`Item ${Math.min(p.session.done + 1, p.session.total)} of ${p.session.total}`}>
            {Array.from({ length: p.session.total }, (_, i) => (
              <span key={i} className={`session-pip${i < p.session!.done ? ' is-done' : i === p.session!.done ? ' is-current' : ''}`} />
            ))}
          </span>
          <span className="session-count">
            {Math.min(p.session.done + 1, p.session.total)}/{p.session.total}
          </span>
          <span className="session-left" title="What is left of today's time box">
            {Math.ceil(p.session.minutesLeft)} min left
          </span>
          {p.session.over ? (
            <Button variant="primary" small shortcut="Ctrl+Shift+K" title="The session's next item" onClick={p.session.next}>
              Next
              <Icon name="next" size={14} />
            </Button>
          ) : (
            <Button variant="ghost" small shortcut="Ctrl+Shift+K" title="Skip this item: it stays due and changes no schedule" onClick={p.session.skip}>
              Skip
            </Button>
          )}
          <Button variant="ghost" small title="Stop the session: an unfinished item stays open and resumes later" onClick={p.session.stop}>
            Stop
          </Button>
        </div>
      ) : null}
      <div className="topbar-title">{p.title ?? ''}</div>
      {p.clock ? (
        <div className={`clock${p.clock.paused ? ' is-paused' : ''}${p.clock.speed !== 1 ? ' is-fast' : ''}`} role="group" aria-label="Time">
          <span className="clock-time" title="Time spent in the lab (virtual time, over every attempt)">
            {formatElapsed(p.clock.elapsed)}
          </span>
          <Button variant="ghost" small className="clock-pause" shortcut="Ctrl+Shift+Space" title={p.clock.paused ? 'Resume time' : 'Pause time: nothing in the world moves'} aria-pressed={p.clock.paused} onClick={p.togglePause}>
            <Icon name={p.clock.paused ? 'play' : 'pause'} />
            {p.clock.paused ? 'Paused' : null}
          </Button>
          <div className="segmented speed-switch" role="radiogroup" aria-label="Speed of virtual time (Ctrl+Shift+S: the next speed)">
            {SPEEDS.map((n) => (
              <button key={n} type="button" role="radio" aria-checked={p.clock?.speed === n} title={n === 1 ? 'Time runs as the clock on the wall' : `Time runs ${n} times as fast as the clock on the wall`} className={p.clock?.speed === n ? 'is-on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => p.setSpeed(n)}>
                {n}×
              </button>
            ))}
          </div>
          <Button variant="ghost" small className="clock-skip" shortcut="Ctrl+Shift+J" title="Skip to the next event: the next moment a terminal prints or the system acts, up to an hour ahead" aria-label="Skip to the next event" onClick={p.skip}>
            <Icon name="skip" />
          </Button>
          {p.skipNote ? (
            <span key={p.skipNote.n} className={`skip-note${p.skipNote.found ? '' : ' is-none'}`} role="status" title={p.skipNote.found ? `Virtual time jumped ${formatJump(p.skipNote.by).slice(1)} to the next event` : undefined}>
              {p.skipNote.found ? formatJump(p.skipNote.by) : `Nothing is scheduled to happen within the hour${p.skipNote.by > 0 ? ` (${formatJump(p.skipNote.by)})` : ''}`}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="topbar-right">
        {p.sync === 'offline' ? (
          <span className="sync-note" title="The local server does not answer. Progress is kept in this browser and sent when it is back.">
            offline
          </span>
        ) : null}
        <div className="segmented lang-switch" role="radiogroup" aria-label="Language of prose">
          {LANGS.map((l) => (
            <button key={l.value} type="button" role="radio" aria-checked={p.settings.lang === l.value} title={l.title} className={p.settings.lang === l.value ? 'is-on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => p.setSettings({ ...p.settings, lang: l.value })}>
              {l.label}
            </button>
          ))}
        </div>
        <Button variant="ghost" small className={`topbar-trigger gap-trigger${p.gaps.length > 0 ? ' has-gaps' : ''}`} title="Simulator notices this session" onClick={toggle('gaps')}>
          <span className="sim-tag">[sim]</span>
          <span className="gap-count">{p.gaps.length}</span>
        </Button>
        {p.xrayOpen !== undefined ? (
          <Button variant="ghost" small className="topbar-trigger xray-trigger" shortcut="Ctrl+Shift+Y" title={p.xrayOpen ? 'Close the X-ray' : 'X-ray: see the simulated world (counts as help)'} aria-pressed={p.xrayOpen} onClick={p.toggleXray}>
            <Icon name="xray" />
            X-ray
          </Button>
        ) : null}
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
              Language
              <small>of lessons, tickets, hints and debriefs; the terminal stays English</small>
            </span>
            <Segmented value={p.settings.lang} options={[{ value: 'en', label: 'English' }, { value: 'vi', label: 'Tiếng Việt' }, { value: 'both', label: 'Both' }]} onChange={(lang) => p.setSettings({ ...p.settings, lang })} />
          </div>
          <div className="setting">
            <span>
              Editor keys
              <small>for vim, vi and kubectl edit</small>
            </span>
            <Segmented value={p.settings.editorKeys} options={[{ value: 'vim', label: 'Vim' }, { value: 'plain', label: 'Plain' }]} onChange={(editorKeys) => p.setSettings({ ...p.settings, editorKeys })} />
          </div>
          <div className="setting">
            <span>
              Motion
              <small>how views show change</small>
            </span>
            <Segmented value={p.settings.motion} options={[{ value: 'system', label: 'As the system' }, { value: 'reduced', label: 'Reduced' }]} onChange={(motion) => p.setSettings({ ...p.settings, motion })} />
          </div>
          <div className="setting setting-assist">
            <span>
              X-ray help
              <small>
                {ASSISTS.find((a) => a.value === p.settings.assist)?.label}: {ASSISTS.find((a) => a.value === p.settings.assist)?.means}. The exam gives none. A change applies from the next attempt.
              </small>
              {p.attemptAssist !== undefined && p.attemptAssist !== p.settings.assist ? (
                <small className="setting-now">
                  This attempt runs at {ASSISTS.find((a) => a.value === p.attemptAssist)?.label}: the level is fixed when an attempt starts, and an item may allow less.
                </small>
              ) : null}
            </span>
            <Segmented value={p.settings.assist} options={ASSISTS.map((a) => ({ value: a.value, label: a.label }))} onChange={(assist) => p.setSettings({ ...p.settings, assist })} />
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
