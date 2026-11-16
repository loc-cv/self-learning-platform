// The workspace: top bar, the lab panel and the terminals side by side, the editor overlay over
// the terminal that asked for it. State lives here; the engine lives in the worker.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Item } from '@simlab/learn';
import type { Clock, LabAction, LabInfo, LabState, OpenEditor, ResumeProblem } from '../protocol.ts';
import { itemById } from '../content.ts';
import { createEngineClient, type EngineClient } from './engine.ts';
import { EditorOverlay, type SaveResult } from './EditorOverlay.tsx';
import { createGapSink, type GapEntry, type SinkState } from './gaps.ts';
import { ItemPicker } from './ItemPicker.tsx';
import { LabPanel } from './LabPanel.tsx';
import { matchShortcut } from './shortcuts.ts';
import { createStore, type Settings } from './storage.ts';
import { TerminalView, type Tab, type TerminalHandle } from './Terminal.tsx';
import { TopBar, type Popover } from './TopBar.tsx';
import { Button, Icon } from './ui.tsx';
import { installProbe } from './probe.ts';
import { createAttemptKeeper } from './attempts.ts';

type Phase = { kind: 'picker' } | { kind: 'loading'; title: string; resuming: boolean } | { kind: 'ready' } | { kind: 'failed'; problem: ResumeProblem; message: string; item: string };

function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return (a[0] as number) % 1_000_000;
}

let tabKeys = 0;
const newTab = (): Tab => ({ key: ++tabKeys, ended: false });

export function App() {
  const store = useMemo(() => createStore(), []);
  const client: EngineClient = useMemo(() => createEngineClient(new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' })), []);
  const [settings, setSettingsState] = useState<Settings>(() => store.settings());
  const [phase, setPhase] = useState<Phase>({ kind: 'picker' });
  const [picker, setPicker] = useState(false);
  const [lab, setLab] = useState<LabInfo>();
  const [labState, setLabState] = useState<LabState>();
  const [debrief, setDebrief] = useState<string>();
  const [solutions, setSolutions] = useState<{ name: string; text: string }[]>();
  const [busy, setBusy] = useState<LabAction>();
  const [note, setNote] = useState<string>();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<number>();
  const [editors, setEditors] = useState<Record<string, OpenEditor>>({});
  const [clock, setClock] = useState<Clock>();
  const [gaps, setGaps] = useState<GapEntry[]>([]);
  const [sinkState, setSinkState] = useState<SinkState>('idle');
  const [popover, setPopover] = useState<Popover>();
  const [storageWarning, setStorageWarning] = useState(false);
  const [engineError, setEngineError] = useState<string>();
  const handles = useRef(new Map<number, TerminalHandle>());
  /** The item being started, for a failure that comes before its lab is known. */
  const starting = useRef<string | undefined>(undefined);
  const saves = useRef(new Map<string, (r: SaveResult) => void>());
  const current = useRef<{ item?: string; lab?: LabInfo; tabs: Tab[]; activeTab?: number }>({ tabs: [] });
  current.current = { ...(lab ? { item: lab.id, lab } : {}), tabs, ...(activeTab !== undefined ? { activeTab } : {}) };
  const sink = useMemo(
    () =>
      createGapSink(
        (body) => fetch('/api/gaps', { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
        setSinkState,
        (body) => navigator.sendBeacon('/api/gaps', new Blob([body], { type: 'application/json' })),
      ),
    [],
  );

  const keeper = useMemo(() => createAttemptKeeper((a) => store.saveAttempt(a), { askForFull: () => client.send({ type: 'flush' }), onSaved: (ok) => setStorageWarning(!ok) }), [store, client]);

  const setSettings = useCallback(
    (s: Settings) => {
      setSettingsState(s);
      document.documentElement.dataset.theme = s.theme;
      store.saveSettings(s);
    },
    [store],
  );
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, []);

  const focusTerminal = useCallback(() => {
    const k = current.current.activeTab;
    if (k !== undefined) requestAnimationFrame(() => handles.current.get(k)?.focus());
  }, []);

  /** Starts an item: resumes its stored attempt unless `fresh`. */
  const start = useCallback(
    (item: Item, fresh: boolean, seed?: number) => {
      const stored = fresh ? undefined : store.attempt(item.id);
      // The attempt being left goes to storage as it stands.
      keeper.persist();
      keeper.clear();
      if (fresh) store.dropAttempt(item.id);
      for (const t of current.current.tabs) if (t.tty) client.forget(t.tty);
      starting.current = item.id;
      setPicker(false);
      setPhase({ kind: 'loading', title: item.title, resuming: stored !== undefined });
      setTabs([]);
      setEditors({});
      setDebrief(undefined);
      setSolutions(undefined);
      setNote(undefined);
      setLab(undefined);
      setLabState(undefined);
      setClock(undefined);
      // An interactive session starts at the real current time (docs/SCENARIO_FORMAT.md §5.2).
      client.send({ type: 'start', item: item.id, seed: seed ?? randomSeed(), startTime: Math.floor(Date.now() / 1000) * 1000, ...(stored ? { resume: stored } : {}) });
    },
    [client, store, keeper],
  );

  // Messages from the engine.
  useEffect(
    () =>
      client.on((m) => {
        switch (m.type) {
          case 'ready': {
            setLab(m.lab);
            setLabState(m.state);
            setClock(m.clock);
            const t: Tab[] = m.ttys.map((x) => ({ key: ++tabKeys, tty: x.tty, ended: x.ended, size: { cols: x.cols, rows: x.rows } }));
            const all = t.length > 0 ? t : [newTab()];
            setTabs(all);
            const withEditor = m.editors.find((e) => e.tty !== undefined);
            setActiveTab((all.find((x) => x.tty === withEditor?.tty) ?? all[all.length - 1])?.key);
            setEditors(Object.fromEntries(m.editors.map((e) => [e.session, e])));
            store.setActive(m.lab.id);
            setPhase({ kind: 'ready' });
            return;
          }
          case 'failed':
            setPhase({ kind: 'failed', problem: m.problem, message: m.message, item: starting.current ?? '' });
            return;
          case 'tty.ended':
            setTabs((ts) => ts.map((t) => (t.tty === m.tty ? { ...t, ended: true } : t)));
            return;
          case 'editor.open':
            setEditors((es) => ({ ...es, [m.editor.session]: m.editor }));
            if (m.editor.tty) setActiveTab(current.current.tabs.find((t) => t.tty === m.editor.tty)?.key ?? current.current.activeTab);
            return;
          case 'editor.closed':
            setEditors((es) => {
              const { [m.session]: _gone, ...rest } = es;
              return rest;
            });
            focusTerminal();
            return;
          case 'editor.status': {
            const done = saves.current.get(m.session);
            saves.current.delete(m.session);
            done?.(m.message === undefined ? { ok: m.ok } : { ok: m.ok, message: m.message });
            return;
          }
          case 'gap': {
            const e: GapEntry = { gap: m.gap, item: current.current.item ?? '', seenAt: Date.now(), replayed: m.replayed };
            setGaps((g) => [...g, e]);
            if (current.current.lab) sink.add(e, current.current.lab.engine);
            return;
          }
          case 'clock':
            setClock(m.clock);
            return;
          case 'attempt':
            keeper.full(m.attempt);
            return;
          case 'attempt.delta':
            keeper.delta(m);
            return;
          case 'error':
            console.error(m.message);
            setEngineError(m.message.split('\n')[0]);
            return;
          default:
            return;
        }
      }),
    [client, store, sink, keeper, focusTerminal],
  );

  // `?lab=<id>&seed=<n>` opens that variant (resuming it if it is the attempt in progress);
  // otherwise the item in progress resumes after a reload.
  useEffect(() => {
    installProbe(client, handles.current, () => current.current);
    const q = new URLSearchParams(location.search);
    const linked = q.get('lab');
    if (linked !== null) {
      history.replaceState(null, '', location.pathname);
      const item = itemById(linked);
      const seed = q.get('seed');
      if (item) {
        const n = seed !== null && /^\d+$/.test(seed) ? Number(seed) : undefined;
        const stored = store.attempt(item.id);
        start(item, stored === undefined || (n !== undefined && stored.seed !== n), n);
        return;
      }
    }
    const id = store.active();
    const item = id === undefined ? undefined : itemById(id);
    if (item && store.attempt(item.id)) start(item, false);
  }, []);

  // The attempt goes to storage before the page goes away: the page holds the latest log.
  useEffect(() => {
    const leave = (): void => {
      keeper.persist();
      sink.flush(true);
    };
    const hide = (): void => {
      if (document.visibilityState === 'hidden') leave();
    };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', leave);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', leave);
    };
  }, [keeper, sink]);

  const act = useCallback(
    async (action: LabAction) => {
      setBusy(action);
      setNote(undefined);
      const { result, state } = await client.lab(action);
      setBusy(undefined);
      setLabState(state);
      if (result.action === 'hint' && !result.hint) setNote(`No more hints: all ${state.hints.length} are shown. Solutions shows the reference solutions.`);
      if (result.action === 'debrief') setDebrief(result.text);
      if (result.action === 'solutions') setSolutions(result.solutions);
      if (result.action === 'reset') {
        for (const t of current.current.tabs) if (t.tty) client.forget(t.tty);
        const fresh = newTab();
        setTabs([fresh]);
        setActiveTab(fresh.key);
        setEditors({});
        setNote('The world is back where it started.');
      }
      focusTerminal();
    },
    [client, focusTerminal],
  );

  const openTerminal = useCallback(() => {
    const t = newTab();
    setTabs((ts) => [...ts, t]);
    setActiveTab(t.key);
  }, []);

  const closeTerminal = useCallback(
    (key: number) => {
      const t = current.current.tabs.find((x) => x.key === key);
      if (!t) return;
      if (t.tty) {
        client.send({ type: 'tty.close', tty: t.tty });
        client.forget(t.tty);
      }
      setEditors((es) => Object.fromEntries(Object.entries(es).filter(([, e]) => e.tty === undefined || e.tty !== t.tty)));
      const rest = current.current.tabs.filter((x) => x.key !== key);
      setTabs(rest);
      if (current.current.activeTab === key) setActiveTab(rest[Math.max(0, current.current.tabs.indexOf(t) - 1)]?.key);
    },
    [client],
  );

  const togglePause = useCallback(() => {
    if (clock) client.send({ type: 'pause', paused: !clock.paused });
    focusTerminal();
  }, [client, clock, focusTerminal]);

  const togglePanel = useCallback(() => {
    setSettings({ ...settings, panelOpen: !settings.panelOpen });
    focusTerminal();
  }, [settings, setSettings, focusTerminal]);

  // Workspace shortcuts, before the terminal or the editor sees the key (shortcuts.ts).
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && picker && phase.kind !== 'picker') {
        e.preventDefault();
        e.stopPropagation();
        setPicker(false);
        focusTerminal();
        return;
      }
      const m = matchShortcut(e);
      if (m) {
        if (m.id === 'copy') {
          const h = current.current.activeTab === undefined ? undefined : handles.current.get(current.current.activeTab);
          if (h?.hasSelection()) void navigator.clipboard?.writeText(h.selection());
          else return;
        }
        e.preventDefault();
        e.stopPropagation();
        const ready = phase.kind === 'ready';
        if (m.id === 'check' && ready) void act('check');
        else if (m.id === 'hint' && ready) void act('hint');
        else if (m.id === 'newTerminal' && ready) openTerminal();
        else if (m.id === 'closeTerminal' && ready && current.current.activeTab !== undefined) closeTerminal(current.current.activeTab);
        else if (m.id === 'tab') {
          const t = current.current.tabs[m.index ?? 0];
          if (t) setActiveTab(t.key);
        } else if (m.id === 'panel') togglePanel();
        else if (m.id === 'pause' && ready) togglePause();
        else if (m.id === 'labs') setPicker((v) => !v);
        else if (m.id === 'help') setPopover((v) => (v === 'help' ? undefined : 'help'));
        return;
      }
      // Keys typed while nothing has focus (after selecting text in the panel) go to the terminal.
      const el = document.activeElement;
      if (phase.kind !== 'ready' || picker || popover) return;
      if (el && el !== document.body) return;
      const k = current.current.activeTab;
      const h = k === undefined ? undefined : handles.current.get(k);
      if (!h || e.ctrlKey || e.altKey || e.metaKey) return;
      const data = e.key.length === 1 ? e.key : e.key === 'Enter' ? '\r' : e.key === 'Backspace' ? '\x7f' : e.key === 'Tab' ? '\t' : undefined;
      h.focus();
      if (data !== undefined) {
        e.preventDefault();
        h.input(data);
      }
    };
    window.addEventListener('keydown', down, true);
    return () => window.removeEventListener('keydown', down, true);
  }, [phase.kind, picker, popover, act, openTerminal, closeTerminal, togglePanel, togglePause, focusTerminal]);

  // Returning to the window returns to the terminal.
  useEffect(() => {
    const back = (): void => {
      if (!document.querySelector('.editor-overlay')) focusTerminal();
    };
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
  }, [focusTerminal]);

  const startPanelDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = settings.panelWidth;
    let w = startW;
    const move = (ev: PointerEvent): void => {
      w = Math.round(Math.min(Math.max(300, startW + ev.clientX - startX), window.innerWidth * 0.6));
      document.documentElement.style.setProperty('--panel-width', `${w}px`);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('is-dragging');
      setSettings({ ...settings, panelWidth: w });
      focusTerminal();
    };
    document.body.classList.add('is-dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const nudgePanel = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const d = e.key === 'ArrowLeft' ? -24 : e.key === 'ArrowRight' ? 24 : 0;
    if (d === 0) return;
    e.preventDefault();
    setSettings({ ...settings, panelWidth: Math.min(Math.max(300, settings.panelWidth + d), window.innerWidth * 0.6) });
  };
  useEffect(() => {
    document.documentElement.style.setProperty('--panel-width', `${settings.panelWidth}px`);
  }, [settings.panelWidth]);

  const editorFor = (t: Tab): OpenEditor | undefined => Object.values(editors).find((e) => e.tty !== undefined && e.tty === t.tty);
  const showPicker = phase.kind === 'picker' || picker;

  return (
    <div className={`app${settings.panelOpen ? '' : ' panel-closed'}`}>
      <TopBar
        {...(lab ? { title: lab.title } : {})}
        {...(clock ? { clock } : {})}
        gaps={gaps}
        sink={sinkState}
        settings={settings}
        panelOpen={settings.panelOpen}
        popover={popover}
        setPopover={setPopover}
        setSettings={setSettings}
        togglePause={togglePause}
        togglePanel={togglePanel}
        openLabs={() => setPicker((v) => !v)}
      />
      {storageWarning ? <div className="banner banner-warn">Browser storage is full or unavailable: a reload would lose this attempt.</div> : null}
      {engineError ? (
        <div className="banner banner-bad">
          Internal simulator error: {engineError}
          <Button variant="ghost" small onClick={() => setEngineError(undefined)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      <main className="workspace">
        {phase.kind === 'ready' && lab && labState && settings.panelOpen ? (
          <>
            <LabPanel lab={lab} state={labState} {...(debrief ? { debrief } : {})} {...(solutions ? { solutions } : {})} {...(busy ? { busy } : {})} {...(note ? { note } : {})} act={(a) => void act(a)} />
            <div className="splitter" role="separator" aria-orientation="vertical" aria-label="Resize the lab panel" tabIndex={0} onPointerDown={startPanelDrag} onKeyDown={nudgePanel} />
          </>
        ) : null}
        <section className="terminals" aria-label="Terminals">
          {phase.kind === 'ready' ? (
            <>
              <nav className="tabs" role="tablist">
                {tabs.map((t, i) => (
                  <div key={t.key} role="tab" aria-selected={t.key === activeTab} className={`tab${t.key === activeTab ? ' is-active' : ''}${t.ended ? ' is-ended' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => setActiveTab(t.key)} title={`Ctrl+Shift+${i + 1}`}>
                    <Icon name="terminal" size={14} />
                    <span className="tab-title" title={t.tty}>
                      {t.title ?? t.tty ?? 'opening…'}
                    </span>
                    {editorFor(t) ? <span className="tab-badge">{editorFor(t)?.request.flavor}</span> : null}
                    <button
                      type="button"
                      className="tab-close"
                      aria-label="Close terminal"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTerminal(t.key);
                      }}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                ))}
                <Button variant="ghost" small className="tab-new" shortcut="Ctrl+Shift+E" title="Another terminal on the same machine" onClick={openTerminal}>
                  <Icon name="plus" size={14} />
                </Button>
              </nav>
              <div className="terminal-stack">
                {tabs.map((t) => {
                  const ed = editorFor(t);
                  return (
                    <div key={t.key} className={`terminal-slot${t.key === activeTab ? ' is-active' : ''}`}>
                      <TerminalView
                        client={client}
                        tab={t}
                        active={t.key === activeTab}
                        theme={settings.theme}
                        fontSize={settings.fontSize}
                        covered={ed !== undefined}
                        onOpened={(key, tty) => setTabs((ts) => ts.map((x) => (x.key === key ? { ...x, tty } : x)))}
                        onTitle={(key, title) => setTabs((ts) => ts.map((x) => (x.key === key ? { ...x, title } : x)))}
                        onRelaunch={(key) => {
                          const old = current.current.tabs.find((x) => x.key === key)?.tty;
                          if (old) client.forget(old);
                          setTabs((ts) => ts.map((x) => (x.key === key ? { key, ended: false } : x)));
                        }}
                        register={(key, h) => {
                          if (h) handles.current.set(key, h);
                          else handles.current.delete(key);
                        }}
                      />
                      {t.ended ? <div className="ended-note">The shell has exited. Press Enter for a new login shell, or close the tab.</div> : null}
                      {ed && t.key === activeTab ? (
                        <EditorOverlay
                          key={ed.session}
                          editor={ed}
                          keys={settings.editorKeys}
                          save={(content) =>
                            new Promise<SaveResult>((ok) => {
                              saves.current.set(ed.session, ok);
                              client.send({ type: 'editor.save', session: ed.session, content });
                            })
                          }
                          close={() => client.send({ type: 'editor.close', session: ed.session })}
                          gap={(what, commandLine) => client.send({ type: 'gap', session: ed.session, gap: { kind: 'command', program: 'vim', what, commandLine } })}
                        />
                      ) : null}
                    </div>
                  );
                })}
                {tabs.length === 0 ? (
                  <div className="empty">
                    <p>No terminal is open.</p>
                    <Button variant="primary" shortcut="Ctrl+Shift+E" onClick={openTerminal}>
                      Open a terminal
                    </Button>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
          {phase.kind === 'loading' ? (
            <div className="loading">
              <div className="spinner" aria-hidden="true" />
              <p>{phase.resuming ? `Replaying your attempt at “${phase.title}”…` : `Building the world for “${phase.title}”…`}</p>
            </div>
          ) : null}
          {phase.kind === 'failed' ? (
            <div className="failed">
              <h2>{phase.problem === 'error' ? 'The lab could not be started' : 'This attempt cannot be resumed'}</h2>
              <p>{phase.message}</p>
              {phase.problem === 'changed' || phase.problem === 'diverged' ? <p>The simulator never continues on a world it cannot vouch for. Starting again builds the same variant from its initial state.</p> : null}
              <div className="failed-actions">
                {itemById(phase.item) ? (
                  <Button
                    variant="primary"
                    onClick={() => {
                      const item = itemById(phase.item) as Item;
                      start(item, true, store.attempt(item.id)?.seed);
                    }}
                  >
                    Start this lab again
                  </Button>
                ) : null}
                <Button variant="ghost" onClick={() => setPhase({ kind: 'picker' })}>
                  All labs
                </Button>
              </div>
            </div>
          ) : null}
        </section>
        {showPicker ? (
          <div className={phase.kind === 'picker' ? 'picker-page' : 'picker-overlay'} onMouseDown={(e) => e.target === e.currentTarget && setPicker(false)}>
            <ItemPicker store={store} {...(lab ? { current: lab.id } : {})} start={(item, fresh) => (lab?.id === item.id && !fresh ? setPicker(false) : start(item, fresh))} {...(phase.kind !== 'picker' ? { onClose: () => setPicker(false) } : {})} />
          </div>
        ) : null}
      </main>
    </div>
  );
}
