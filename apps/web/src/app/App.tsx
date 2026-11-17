// The app: the home screen with today's session, and the workspace for one item at a time: top
// bar, the item's panel and the terminals side by side, the editor overlay over the terminal that
// asked for it. State lives here; the engine lives in the worker; what is learned is the progress
// log (progress.ts), which this file writes as things happen (docs/LEARNING_MODEL.md §12).

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ViewModel } from '@simlab/kernel';
import { assistAllows, cardReview, finishAttempt, PROGRESS_VERSION, seedFor, type AttemptMode, type ProgressEvent, type Rating, type RatingReason } from '@simlab/learn';
import { SPEEDS, type Clock, type LabAction, type LabInfo, type LabState, type Note, type OpenEditor, type ResumeProblem, type SolutionText, type StoredAttempt } from '../protocol.ts';
import { CATALOG, itemById, ITEMS_BY_ID, type Practiced } from '../content.ts';
import { Browser } from './Browser.tsx';
import { CardPage, CardPanel } from './CardView.tsx';
import { attemptId, initialSettings, loadSession, openAttemptOf, saveSession, sessionQueue, settingsEvent, today, type DailySession } from './daily.ts';
import { gateDone, leaveOutcome, lessonDone, lessonPages, nextReview, noteEvent, resultEvents, startedEvent, type AttemptRef, type LeaveReason } from './flow.ts';
import { Home } from './Home.tsx';
import { LessonPanel } from './LessonPanel.tsx';
import type { NextStep, Rated } from './parts.tsx';
import { browserIo, createProgressStore } from './progress.ts';
import { createEngineClient, type EngineClient } from './engine.ts';
import { EditorOverlay, type SaveResult } from './EditorOverlay.tsx';
import { createGapSink, type GapEntry, type SinkState } from './gaps.ts';
import { LAB_TABS, LabPanel, TAB_OF_ACTION, type DebriefData, type LabTab, type ReferenceRun } from './LabPanel.tsx';
import { isBrowserChord, matchShortcut, neighbourTab } from './shortcuts.ts';
import { isFullscreen, toggleFullscreen, watchFullscreen } from './fullscreen.ts';
import { createStore, withDefaults, type KeyValue, type Settings } from './storage.ts';
import { createLatest, mergeEvents, nextSpeed, type TraceState } from './timeline.ts';
import { TerminalView, type Tab, type TerminalHandle } from './Terminal.tsx';
import { TopBar, type Popover, type SkipNote } from './TopBar.tsx';
import { Button, Icon } from './ui.tsx';
import { installProbe } from './probe.ts';
import { attemptApi, createAttemptKeeper, longerAttempt } from './attempts.ts';
import { XRay, type XRayMode } from './XRay.tsx';
import type { Rect } from './floating.ts';
import { tabDomId } from './ui.tsx';
import { MONO_FONT } from './theme.ts';
import { usePrefersReducedMotion } from './motion.ts';

type Phase = { kind: 'home' } | { kind: 'loading'; title: string; resuming: boolean } | { kind: 'ready' } | { kind: 'failed'; problem: ResumeProblem; message: string; item: string };

/** The attempt on screen as the progress log knows it. */
interface AttemptInfo extends AttemptRef {
  seed: number;
  /** Set once the attempt is finished in the log. */
  outcome?: 'passed' | 'failed' | 'abandoned';
  /** The grade of the finished attempt, as last recorded. */
  rated?: Rated;
  /** A card's recorded review. */
  card?: { correct?: boolean; choice?: number };
}

interface StartOptions {
  /** A new attempt, whatever is in progress. */
  fresh: boolean;
  seed?: number;
  mode: AttemptMode;
}

function browserKv(): KeyValue | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

const utcOffset = (): number => -new Date().getTimezoneOffset();

let tabKeys = 0;
const newTab = (): Tab => ({ key: ++tabKeys, ended: false });

export function App() {
  const store = useMemo(() => createStore(), []);
  const client: EngineClient = useMemo(() => createEngineClient(new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' })), []);
  const [settings, setSettingsState] = useState<Settings>(() => store.settings());
  const kv = useMemo(browserKv, []);
  const progress = useMemo(() => createProgressStore(browserIo(), kv), [kv]);
  useSyncExternalStore(progress.subscribe, progress.version);
  const pstate = progress.state();
  /** The log is loaded: until then there is no queue and nothing may be recorded. */
  const [loaded, setLoaded] = useState(false);
  /** Wall-clock time as the screens see it: moved on every minute and when the window comes back. */
  const [now, setNow] = useState(() => Date.now());
  const [session, setSessionState] = useState<DailySession>(() => loadSession(kv, today(progress.state(), Date.now())));
  const sessionRef = useRef(session);
  const setSession = useCallback(
    (s: DailySession) => {
      sessionRef.current = s;
      setSessionState(s);
      saveSession(kv, s);
    },
    [kv],
  );
  const [attempt, setAttemptState] = useState<AttemptInfo>();
  const attemptRef = useRef<AttemptInfo | undefined>(undefined);
  const setAttempt = useCallback((a: AttemptInfo | undefined) => {
    attemptRef.current = a;
    setAttemptState(a);
  }, []);
  const attempts = useMemo(attemptApi, []);
  const [phase, setPhase] = useState<Phase>({ kind: 'home' });
  const [picker, setPicker] = useState(false);
  const [lab, setLab] = useState<LabInfo>();
  const [labState, setLabStateRaw] = useState<LabState>();
  const labStateRef = useRef<LabState | undefined>(undefined);
  const setLabState = useCallback((s: LabState | undefined) => {
    labStateRef.current = s;
    setLabStateRaw(s);
  }, []);
  const [debrief, setDebrief] = useState<DebriefData>();
  const [solutions, setSolutions] = useState<SolutionText[]>();
  /** Check was asked for and waits for the confidence prompt. */
  const [asking, setAsking] = useState(false);
  /** The lesson's open page. */
  const [lessonPage, setLessonPageRaw] = useState(0);
  const lessonPageRef = useRef(0);
  const setLessonPage = useCallback((n: number) => {
    lessonPageRef.current = n;
    setLessonPageRaw(n);
  }, []);
  /** When a card with no world was shown, for the time it took. */
  const cardShownAt = useRef(0);
  const [busy, setBusy] = useState<LabAction>();
  const [note, setNote] = useState<string>();
  /** The lab panel's open tab: the ticket at the start of every attempt. */
  const [labTab, setLabTab] = useState<LabTab>('ticket');
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<number>();
  const [editors, setEditors] = useState<Record<string, OpenEditor>>({});
  const [clock, setClockRaw] = useState<Clock>();
  const clockRef = useRef<Clock | undefined>(undefined);
  const setClock = useCallback((c: Clock | undefined) => {
    clockRef.current = c;
    setClockRaw(c);
  }, []);
  const [gaps, setGaps] = useState<GapEntry[]>([]);
  const [sinkState, setSinkState] = useState<SinkState>('idle');
  const [popover, setPopover] = useState<Popover>();
  const [fullscreen, setFullscreen] = useState(isFullscreen);
  useEffect(() => watchFullscreen(setFullscreen), []);
  const [storageWarning, setStorageWarning] = useState(false);
  const [engineError, setEngineError] = useState<string>();
  /** The X-ray is open, and the last view model the worker sent. */
  const [xray, setXray] = useState(false);
  const [viewModel, setViewModel] = useState<ViewModel>();
  /** The trace for the timeline (assist level full, X-ray open), as the worker sends it. */
  const [trace, setTrace] = useState<TraceState>();
  /** The past moment the X-ray reads (undefined: now), and its view once the worker rebuilt it. */
  const [pastAt, setPastAt] = useState<number>();
  const [past, setPast] = useState<{ t: number; model: ViewModel }>();
  const pastRequests = useMemo(() => createLatest((t: number) => client.past(t), (r) => setPast(r)), [client]);
  /** What the last skip to the next event did, for a few seconds. */
  const [skipNote, setSkipNote] = useState<SkipNote>();
  /** The reference solution's run beside the attempt's replay in the debrief. */
  const [reference, setReference] = useState<ReferenceRun>();
  const systemReduced = usePrefersReducedMotion();
  const reducedMotion = settings.motion === 'reduced' || systemReduced;
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

  /** The X-ray's view of the trace and of past moments, gone: it closed, or a new world began. */
  const clearTrace = useCallback(() => {
    pastRequests.cancel();
    setTrace(undefined);
    setPastAt(undefined);
    setPast(undefined);
  }, [pastRequests]);

  const keeper = useMemo(() => createAttemptKeeper((a) => store.saveAttempt(a), { askForFull: () => client.send({ type: 'flush' }), onSaved: (ok) => setStorageWarning(!ok), send: attempts.send }), [store, client, attempts]);

  /** Appends to the progress log; before the log is loaded nothing is recorded. */
  const record = useCallback(
    (events: readonly (ProgressEvent | undefined)[]) => {
      const list = events.filter((e): e is ProgressEvent => e !== undefined);
      if (list.length > 0) progress.record(list);
    },
    [progress],
  );

  const setSettings = useCallback(
    (s: Settings) => {
      setSettingsState(s);
      document.documentElement.dataset.theme = s.theme;
      store.saveSettings(s);
      // The server's copy (data/settings.json) is what another browser starts from.
      void fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) }).catch(() => undefined);
    },
    [store],
  );
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, []);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const focusTerminal = useCallback(() => {
    const k = current.current.activeTab;
    if (k !== undefined) requestAnimationFrame(() => handles.current.get(k)?.focus());
  }, []);

  /** The item's meta and how long its hint ladder is, for the rating. */
  const hintCountOf = (info: LabInfo): number => (info.steps ? info.steps.reduce((n, st) => n + (st.kind === 'task' ? st.hintCount : 0), 0) : info.hintCount);

  /** Ends the attempt on screen in the log, if it is still open there. */
  const finish = useCallback(
    (outcome: 'passed' | 'failed' | 'abandoned', activeMs?: number) => {
      const a = attemptRef.current;
      const info = current.current.lab;
      const meta = a ? CATALOG.items[a.item] : undefined;
      if (!a || a.outcome || !meta || !progress.state().open[a.id]) return;
      const events = finishAttempt(progress.state(), meta, { attempt: a.id, at: Date.now(), outcome, activeMs: activeMs ?? clockRef.current?.elapsed ?? 0, hintCount: info ? hintCountOf(info) : 0 });
      progress.record(events);
      const rating = events.find((e) => e.type === 'rating');
      setAttempt({ ...a, outcome, ...(rating?.type === 'rating' ? { rated: { rating: rating.rating, source: 'auto' as const, reasons: (rating.reasons ?? []) as RatingReason[] } } : {}) });
    },
    [progress, setAttempt],
  );

  /**
   * Leaves the item on screen. An attempt that saw the answer without passing ends failed; a
   * skipped one is abandoned; any other unfinished attempt stays open and resumes later.
   */
  const leaveItem = useCallback(
    (reason: LeaveReason): 'passed' | 'failed' | 'abandoned' | undefined => {
      const a = attemptRef.current;
      const st = labStateRef.current;
      if (!a) return undefined;
      let outcome = a.outcome;
      if (!outcome && current.current.lab?.kind !== 'card') {
        const gaveUp = st !== undefined && !st.solved && (st.solutionViewed || st.debriefSeen);
        const end = leaveOutcome(gaveUp, reason);
        if (end) {
          finish(end);
          outcome = end;
        }
      }
      // The attempt being left goes to storage as it stands; a finished one needs no copy.
      keeper.persist();
      keeper.clear();
      if (outcome || current.current.lab?.kind === 'card') store.dropAttempt(a.item);
      store.setActive(undefined);
      setAttempt(undefined);
      return outcome;
    },
    [finish, keeper, store, setAttempt],
  );

  /** Starts an item: resumes its unfinished attempt unless `fresh`. */
  const start = useCallback(
    async (item: Practiced, opts: StartOptions) => {
      const leaving = attemptRef.current;
      leaveItem(leaving && leaving.item === item.id && opts.fresh ? 'skip' : 'away');
      for (const t of current.current.tabs) if (t.tty) client.forget(t.tty);
      starting.current = item.id;
      setPicker(false);
      setPhase({ kind: 'loading', title: item.title, resuming: !opts.fresh && (store.attempt(item.id) !== undefined || openAttemptOf(progress.state(), item.id) !== undefined) });
      setTabs([]);
      setEditors({});
      setDebrief(undefined);
      setSolutions(undefined);
      setNote(undefined);
      setAsking(false);
      setLabTab('ticket');
      setLessonPage(0);
      setLab(undefined);
      setLabState(undefined);
      setClock(undefined);
      // Every attempt starts with the X-ray closed: it is help, opened on purpose.
      setXray(false);
      setViewModel(undefined);
      clearTrace();
      setReference(undefined);
      setSkipNote(undefined);

      // What there is to resume: the log's open attempt of this item, from this browser's copy or
      // the server's, whichever holds more; or the attempt that just finished, to read its debrief
      // again after a reload.
      const state = progress.state();
      const open = openAttemptOf(state, item.id);
      let stored: StoredAttempt | undefined;
      let info: AttemptInfo | undefined;
      const local = store.attempt(item.id);
      if (!opts.fresh && item.kind !== 'card') {
        if (open !== undefined) {
          stored = longerAttempt(local?.id === open ? local : undefined, await attempts.load(open));
          if (starting.current !== item.id) return;
          if (stored) info = { id: open, item: item.id, mode: opts.mode, seed: stored.seed };
        } else if (local?.id !== undefined && state.items[item.id]?.last?.attempt === local.id) {
          const last = state.items[item.id]?.last;
          const p = state.items[item.id];
          stored = local;
          info = { id: local.id, item: item.id, mode: opts.mode, seed: local.seed, ...(last ? { outcome: last.outcome } : {}), ...(p?.ratedAttempt === local.id && p.schedule ? { rated: { rating: p.schedule.rating, source: 'auto' as const } } : {}) };
        }
      }
      if (!info) {
        // A new attempt. One left open earlier is given up: an item has one attempt at a time.
        if (open !== undefined) {
          const meta = CATALOG.items[item.id];
          if (meta) progress.record(finishAttempt(state, meta, { attempt: open, at: Date.now(), outcome: 'abandoned', activeMs: 0, hintCount: 0 }));
        }
        store.dropAttempt(item.id);
        const at = Date.now();
        info = { id: attemptId(at, Math.random()), item: item.id, mode: opts.mode, seed: opts.seed ?? seedFor(item.id, progress.state(), { items: ITEMS_BY_ID }) };
      }
      setAttempt(info);
      keeper.begin(item.kind === 'card' ? undefined : info.id);
      // An interactive session starts at the real current time (docs/SCENARIO_FORMAT.md §5.2).
      // The learner's assist level; the worker lowers it to the item's and fixes it for the attempt.
      client.send({ type: 'start', item: item.id, seed: info.seed, startTime: Math.floor(Date.now() / 1000) * 1000, assist: settingsRef.current.assist, ...(stored ? { resume: stored } : {}) });
    },
    [client, store, keeper, progress, attempts, leaveItem, setAttempt, setLabState, setClock, clearTrace],
  );
  const startNow = useCallback((item: Practiced, opts: StartOptions) => void start(item, opts), [start]);

  const goHome = useCallback(() => {
    leaveItem('away');
    for (const t of current.current.tabs) if (t.tty) client.forget(t.tty);
    starting.current = undefined;
    setPicker(false);
    setLab(undefined);
    setLabState(undefined);
    setClock(undefined);
    setTabs([]);
    setEditors({});
    setXray(false);
    setViewModel(undefined);
    clearTrace();
    setNow(Date.now());
    setPhase({ kind: 'home' });
  }, [leaveItem, client, setLabState, setClock, clearTrace]);

  /** The session's next entry, or home when today's queue is empty. */
  const openNext = useCallback(
    (s: DailySession) => {
      const q = sessionQueue(progress.state(), CATALOG, ITEMS_BY_ID, Date.now(), s.skipped);
      const entry = q.entries[0];
      const item = entry ? itemById(entry.item) : undefined;
      if (!entry || !item) {
        setSession({ ...s, running: false });
        goHome();
        return;
      }
      setSession({ ...s, running: true });
      startNow(item, { fresh: false, seed: entry.seed, mode: entry.reason });
    },
    [progress, setSession, goHome, startNow],
  );

  const startSession = useCallback(() => {
    const day = today(progress.state(), Date.now());
    const s = sessionRef.current.day === day ? sessionRef.current : { day, running: false, skipped: [], done: [] };
    openNext(s);
  }, [progress, openNext]);

  /** Moves the session on from the item on screen: finished, or skipped (abandoned, back tomorrow or from home). */
  const sessionNext = useCallback(
    (skip: boolean) => {
      const a = attemptRef.current;
      const s = sessionRef.current;
      if (!a) return openNext(s);
      const outcome = leaveItem(skip ? 'skip' : 'away') ?? 'abandoned';
      const skipped = outcome === 'abandoned' && !s.skipped.includes(a.item) ? [...s.skipped, a.item] : s.skipped;
      openNext({ ...s, skipped, done: [...s.done, { item: a.item, outcome }] });
    },
    [leaveItem, openNext],
  );

  const stopSession = useCallback(() => {
    setSession({ ...sessionRef.current, running: false });
    goHome();
  }, [setSession, goHome]);

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
            cardShownAt.current = Date.now();
            if (m.lab.kind !== 'card') {
              store.setActive(m.lab.id);
              // A new attempt opens in the log; a resumed one is already there.
              const a = attemptRef.current;
              if (a && !a.outcome && !progress.state().open[a.id]) record([startedEvent(a, m.lab.seed, Date.now())]);
            }
            if (m.lab.steps) {
              // A resumed lesson opens where the learner was: the first step not done yet.
              const pages = lessonPages(m.lab.steps);
              const at = pages.findIndex((pg) => !gateDone(pg, m.lab.steps ?? [], m.state.tasks, m.state.predictions));
              setLessonPage(at === -1 ? pages.length - 1 : at);
            }
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
          case 'view':
            setViewModel(m.model);
            return;
          case 'events':
            setTrace((prev) => ({ events: mergeEvents(prev?.events ?? [], m.events, m.reset || prev === undefined), marks: m.marks, start: m.start }));
            return;
          case 'skipped':
            setSkipNote({ found: m.found, by: m.by, n: Date.now() });
            return;
          case 'attempt':
            if (current.current.lab?.kind !== 'card') keeper.full(m.attempt);
            return;
          case 'attempt.delta':
            if (current.current.lab?.kind !== 'card') keeper.delta(m);
            return;
          case 'error':
            console.error(m.message);
            setEngineError(m.message.split('\n')[0]);
            return;
          default:
            return;
        }
      }),
    [client, store, sink, keeper, focusTerminal, progress, record, setLabState, setClock],
  );

  // Once the log is loaded: `?lab=<id>&seed=<n>` opens that variant (resuming it if it is the
  // attempt in progress); otherwise the item in progress resumes after a reload, a running
  // session opens its next entry, and anything else is the home screen.
  useEffect(() => {
    installProbe(client, handles.current, () => current.current);
    let gone = false;
    void progress.ready.then(() => {
      if (gone) return;
      const at = Date.now();
      record([initialSettings(progress.state(), CATALOG, utcOffset(), at)]);
      const s = loadSession(kv, today(progress.state(), at));
      setSession(s);
      setNow(at);
      setLoaded(true);
      const q = new URLSearchParams(location.search);
      const linked = q.get('lab');
      if (linked !== null) {
        history.replaceState(null, '', location.pathname);
        const item = itemById(linked);
        const seed = q.get('seed');
        if (item) {
          const n = seed !== null && /^\d+$/.test(seed) ? Number(seed) : undefined;
          const stored = store.attempt(item.id);
          startNow(item, { fresh: stored === undefined || (n !== undefined && stored.seed !== n), mode: 'free', ...(n !== undefined ? { seed: n } : {}) });
          return;
        }
      }
      const id = store.active();
      const item = id === undefined ? undefined : itemById(id);
      if (item && store.attempt(item.id)) startNow(item, { fresh: false, mode: 'free' });
      else if (s.running) openNext(s);
    });
    // Settings another browser left on the server, when this one has none of its own.
    if (!store.hasSettings())
      void fetch('/api/settings')
        .then((r) => (r.ok ? (r.json() as Promise<Partial<Settings>>) : undefined))
        .then((remote) => {
          if (remote && typeof remote === 'object' && Object.keys(remote).length > 0 && !store.hasSettings()) setSettingsState((cur) => withDefaults({ ...cur, ...remote }));
        })
        .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, []);

  // The screens' clock: the home screen's "due today" follows the day.
  useEffect(() => {
    const tick = (): void => setNow(Date.now());
    const timer = setInterval(tick, 60_000);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, []);

  // The attempt goes to storage before the page goes away: the page holds the latest log.
  useEffect(() => {
    const leave = (): void => {
      keeper.persist(true);
      sink.flush(true);
      progress.flush(true);
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
  }, [keeper, sink, progress]);

  /**
   * Runs a lab action in the engine and records what it means in the log. `step` names a
   * lesson's guided task.
   */
  const run = useCallback(
    async (action: LabAction, step?: number) => {
      const before = labStateRef.current;
      setBusy(action);
      setNote(undefined);
      setAsking(false);
      // An action shows its result: its tab opens, and the panel if it was hidden.
      setLabTab(TAB_OF_ACTION[action]);
      const now = settingsRef.current;
      if (!now.panelOpen) setSettings({ ...now, panelOpen: true });
      const { result, state, clock: at } = await client.lab(action, step);
      setBusy(undefined);
      setLabState(state);
      setClock(at);
      const a = attemptRef.current;
      const info = current.current.lab;
      if (a && info && info.kind !== 'card' && !a.outcome && progress.state().open[a.id]) {
        // The answer shown before the attempt passed is giving up, once.
        const gaveUp = (action === 'solutions' || action === 'debrief') && before !== undefined && !before.solved && !before.solutionViewed && !before.debriefSeen;
        record(resultEvents(a.id, result, Date.now(), gaveUp));
        const done = info.steps ? lessonDone(info.steps, state.tasks, state.predictions) : state.solved;
        if (done) finish('passed', at.elapsed);
      }
      if (result.action === 'hint' && !result.hint) setNote(info?.steps ? 'No more hints for this task.' : `No more hints: all ${state.hints.length} are shown. Solutions shows the reference solutions.`);
      if (result.action === 'debrief') setDebrief({ blocks: result.blocks, history: result.history, solutions: result.solutions, ...(result.replay ? { replay: result.replay } : {}) });
      if (result.action === 'reference') setReference({ ...(result.name ? { name: result.name } : {}), ...(result.replay ? { replay: result.replay } : {}) });
      if (result.action === 'solutions') setSolutions(result.solutions);
      if (result.action === 'reset') {
        for (const t of current.current.tabs) if (t.tty) client.forget(t.tty);
        const fresh = newTab();
        setTabs([fresh]);
        setActiveTab(fresh.key);
        setEditors({});
        // The worker sends the new world's trace; a past moment of the old one is gone.
        pastRequests.cancel();
        setPastAt(undefined);
        setPast(undefined);
        setNote('The world is back where it started.');
      }
      // Back to the terminal, unless the action was run from the lab panel with the keyboard.
      if (!document.activeElement?.closest('.lab-panel')) focusTerminal();
      return { result, state, clock: at };
    },
    [client, focusTerminal, setSettings, progress, record, finish, setLabState, setClock, pastRequests],
  );

  /** The guided task of the lesson page that is open, if it has one that is not done. */
  const lessonTask = useCallback((): number | undefined => {
    const info = current.current.lab;
    if (!info?.steps) return undefined;
    const page = lessonPages(info.steps)[lessonPageRef.current];
    return page?.gateKind === 'task' && page.gate !== undefined && labStateRef.current?.tasks?.[page.gate]?.passed !== true ? page.gate : undefined;
  }, []);

  /** A card with a world: its review is one event, recorded when the checks pass or the learner gives up. */
  const reviewCard = useCallback(
    (answer: { correct?: boolean; choice?: number; rating?: Rating }, activeMs: number) => {
      const a = attemptRef.current;
      if (!a || a.outcome) return;
      const events = cardReview({ attempt: a.id, item: a.item, seed: a.seed, at: Date.now(), activeMs, ...answer });
      record(events);
      const rating = events.find((e) => e.type === 'rating');
      const reviewed = events.find((e) => e.type === 'card.reviewed');
      setAttempt({
        ...a,
        outcome: reviewed?.type === 'card.reviewed' ? reviewed.outcome : 'passed',
        ...(rating?.type === 'rating' ? { rated: { rating: rating.rating, source: rating.source } } : {}),
        card: { ...(answer.correct !== undefined ? { correct: answer.correct } : {}), ...(answer.choice !== undefined ? { choice: answer.choice } : {}) },
      });
    },
    [record, setAttempt],
  );

  /**
   * What Check, Hint and the lab panel's tabs ask for. A lab's check first asks how sure the
   * learner is (until it is solved); a lesson's check and hint are its open task's.
   */
  const act = useCallback(
    async (action: LabAction, step?: number) => {
      const info = current.current.lab;
      if (!info) return;
      if (info.kind === 'card') {
        if (action !== 'check' || attemptRef.current?.outcome) return;
        const { state, clock: at } = await run('check');
        if (state.solved) reviewCard({ correct: true }, at.elapsed);
        return;
      }
      if (info.steps) {
        const task = step ?? lessonTask();
        if ((action === 'check' || action === 'hint') && task === undefined) return;
        await run(action, action === 'check' || action === 'hint' ? task : undefined);
        return;
      }
      if (action === 'check' && labStateRef.current?.solved !== true) {
        const now = settingsRef.current;
        if (!now.panelOpen) setSettings({ ...now, panelOpen: true });
        setNote(undefined);
        // The result will be in the Check tab: the question is asked there.
        setLabTab('check');
        setAsking(true);
        return;
      }
      await run(action);
    },
    [run, reviewCard, lessonTask, setSettings],
  );

  /** Something the learner says about the attempt: kept in its log and recorded as an event. */
  const say = useCallback(
    (note: Note) => {
      const a = attemptRef.current;
      const info = current.current.lab;
      const st = labStateRef.current;
      if (!a || !info || !st) return;
      client.send({ type: 'note', note });
      // An explanation comes after the attempt passed, so the log has it although nothing is open.
      if (progress.state().open[a.id] || note.kind === 'explanation') record([noteEvent(a.id, note, Date.now(), info.steps)]);
      if (note.kind === 'confidence') setLabState({ ...st, confidence: note.value });
      else if (note.kind === 'explanation') {
        setLabState({ ...st, explanation: note.text.trim() });
        void run('debrief');
      } else {
        const predictions = { ...st.predictions, [note.step]: { ...(note.choice !== undefined ? { choice: note.choice } : {}), ...(note.text !== undefined ? { text: note.text } : {}) } };
        setLabState({ ...st, predictions });
        if (info.steps && lessonDone(info.steps, st.tasks, predictions)) finish('passed');
      }
    },
    [client, progress, record, run, finish, setLabState],
  );

  /** The confidence prompt's answer: recorded when given, then the check runs. */
  const answerConfidence = useCallback(
    (confidence: number | undefined) => {
      setAsking(false);
      if (confidence !== undefined) say({ kind: 'confidence', value: confidence });
      void run('check');
    },
    [say, run],
  );
  const cancelAsk = useCallback(() => {
    setAsking(false);
    focusTerminal();
  }, [focusTerminal]);

  /** One click replaces the grade of the finished attempt (docs/LEARNING_MODEL.md §5.2). */
  const rate = useCallback(
    (rating: Rating) => {
      const a = attemptRef.current;
      if (!a?.outcome) return;
      record([{ v: PROGRESS_VERSION, type: 'rating', at: Date.now(), attempt: a.id, item: a.item, rating, source: 'manual' }]);
      setAttempt({ ...a, rated: { rating, source: 'manual' } });
    },
    [record, setAttempt],
  );

  /** After Escape in the lab panel or a drag of the X-ray: the terminal has the keyboard again at
   *  once, so the next key is not lost and a later focus is not undone. */
  const focusTerminalNow = useCallback(() => {
    // An open editor keeps the keyboard: a drag never took it away.
    if (document.activeElement?.closest('.editor-overlay')) return;
    const k = current.current.activeTab;
    if (k !== undefined) handles.current.get(k)?.focus();
  }, []);
  const actNow = useCallback((a: LabAction, step?: number) => void act(a, step), [act]);

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

  const setSpeed = useCallback(
    (speed: number) => {
      client.send({ type: 'speed', speed });
      focusTerminal();
    },
    [client, focusTerminal],
  );
  const cycleSpeed = useCallback(() => {
    const c = clockRef.current;
    if (c) client.send({ type: 'speed', speed: nextSpeed(c.speed, SPEEDS) });
  }, [client]);
  /** To the next moment something shows; the worker answers `skipped`. */
  const skip = useCallback(() => {
    client.send({ type: 'advance' });
    focusTerminal();
  }, [client, focusTerminal]);
  // A skip's note goes after a few seconds; the next skip replaces it.
  useEffect(() => {
    if (!skipNote) return;
    const timer = setTimeout(() => setSkipNote(undefined), 5000);
    return () => clearTimeout(timer);
  }, [skipNote]);

  /** The X-ray reads a past moment (undefined: now): one request in flight, the newest wins. */
  const scrub = useCallback(
    (t: number | undefined) => {
      setPastAt(t);
      if (t === undefined) {
        pastRequests.cancel();
        setPast(undefined);
      } else pastRequests.push(t);
    },
    [pastRequests],
  );
  const askWhy = useCallback((entity: string) => client.why(entity), [client]);

  const xrayOpen = useRef(false);
  xrayOpen.current = xray;
  const toggleXray = useCallback(() => {
    if (current.current.lab === undefined || current.current.lab.world === false) return;
    // At assist level off there is no X-ray (the worker would ignore it too).
    if (!assistAllows(current.current.lab.assist, 'view')) return;
    const open = !xrayOpen.current;
    client.send({ type: 'view', open });
    const a = attemptRef.current;
    if (a && !a.outcome && progress.state().open[a.id]) record([{ v: PROGRESS_VERSION, type: 'attempt.xray', at: Date.now(), attempt: a.id, open }]);
    setXray(open);
    if (!open) {
      setViewModel(undefined);
      clearTrace();
    }
    focusTerminal();
  }, [client, focusTerminal, progress, record, clearTrace]);

  const togglePanel = useCallback(() => {
    setSettings({ ...settings, panelOpen: !settings.panelOpen });
    focusTerminal();
  }, [settings, setSettings, focusTerminal]);

  /** The lab panel's previous or next tab, by chord: the panel opens and the tab takes focus. */
  const stepLabTab = useCallback(
    (step: -1 | 1) => {
      const now = settingsRef.current;
      if (!now.panelOpen) setSettings({ ...now, panelOpen: true });
      setLabTab((t) => {
        // A panel that was hidden opens on the tab it had.
        const to = now.panelOpen ? (LAB_TABS[(LAB_TABS.indexOf(t) + step + LAB_TABS.length) % LAB_TABS.length] as LabTab) : t;
        requestAnimationFrame(() => document.getElementById(tabDomId('lab', to))?.focus());
        return to;
      });
    },
    [setSettings],
  );
  const setXrayMode = useCallback((xrayMode: XRayMode) => setSettings({ ...settingsRef.current, xrayMode }), [setSettings]);
  const setXrayFloat = useCallback((xrayFloat: Rect) => setSettings({ ...settingsRef.current, xrayFloat }), [setSettings]);

  // Workspace shortcuts, before the terminal or the editor sees the key (shortcuts.ts).
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && picker) {
        e.preventDefault();
        e.stopPropagation();
        setPicker(false);
        focusTerminal();
        return;
      }
      const m = matchShortcut(e);
      if (m) {
        // Claimed every time: a chord the page leaves alone is the browser's (Ctrl+Shift+C
        // opens DevTools in Chrome).
        e.preventDefault();
        e.stopPropagation();
        if (m.id === 'copy') {
          // The terminal's selection, or text selected in the lab panel or the editor.
          const h = current.current.activeTab === undefined ? undefined : handles.current.get(current.current.activeTab);
          const text = h?.hasSelection() ? h.selection() : (window.getSelection()?.toString() ?? '');
          if (text !== '') void navigator.clipboard?.writeText(text);
          return;
        }
        if (m.id === 'fullscreen') {
          toggleFullscreen();
          return;
        }
        const ready = phase.kind === 'ready';
        const world = ready && current.current.lab?.world !== false;
        if (m.id === 'check' && world) void act('check');
        else if (m.id === 'hint' && world && current.current.lab?.kind !== 'card') void act('hint');
        else if (m.id === 'home') goHome();
        else if (m.id === 'next' && ready && sessionRef.current.running) sessionNext(attemptRef.current?.outcome === undefined);
        else if (!world && m.id !== 'labs' && m.id !== 'help') return;
        else if (m.id === 'newTerminal' && ready) openTerminal();
        else if (m.id === 'closeTerminal' && ready && current.current.activeTab !== undefined) closeTerminal(current.current.activeTab);
        else if (m.id === 'tab') {
          const t = current.current.tabs[m.index ?? 0];
          if (t) setActiveTab(t.key);
        } else if (m.id === 'prevTab' || m.id === 'nextTab') {
          const ts = current.current.tabs;
          const at = ts.findIndex((t) => t.key === current.current.activeTab);
          const t = ts[neighbourTab(Math.max(at, 0), ts.length, m.id === 'prevTab' ? -1 : 1)];
          if (t) setActiveTab(t.key);
        } else if (m.id === 'panel') togglePanel();
        else if ((m.id === 'prevLabTab' || m.id === 'nextLabTab') && ready) {
          const info = current.current.lab;
          if (info?.steps) {
            // A lesson's tabs are its pages.
            const to = Math.min(Math.max(0, lessonPageRef.current + (m.id === 'prevLabTab' ? -1 : 1)), lessonPages(info.steps).length - 1);
            setLessonPage(to);
            requestAnimationFrame(() => document.getElementById(tabDomId('lesson', `p${to}`))?.focus());
          } else if (info?.kind !== 'card') stepLabTab(m.id === 'prevLabTab' ? -1 : 1);
        }
        else if (m.id === 'xray' && ready) toggleXray();
        // The floating X-ray's move handle takes the keyboard; docked or closed there is none.
        else if (m.id === 'grabXray') document.querySelector<HTMLElement>('.xray-grip')?.focus();
        else if (m.id === 'pause' && ready) togglePause();
        else if (m.id === 'speed' && ready) cycleSpeed();
        else if (m.id === 'skip' && ready) skip();
        else if (m.id === 'labs') setPicker((v) => !v);
        else if (m.id === 'help') setPopover((v) => (v === 'help' ? undefined : 'help'));
        return;
      }
      // Keys typed while nothing has focus (after selecting text in the panel) go to the terminal.
      const el = document.activeElement;
      if (phase.kind !== 'ready' || picker || popover || current.current.lab?.world === false) return;
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
  }, [phase.kind, picker, popover, act, openTerminal, closeTerminal, togglePanel, stepLabTab, toggleXray, togglePause, cycleSpeed, skip, focusTerminal, goHome, sessionNext, setLessonPage]);

  // In full screen or an installed app window the browser hands over Ctrl+W, Ctrl+T and Ctrl+N.
  // The terminal and vim's insert mode use them; where nothing does (vim's normal mode, no
  // focus), the browser must still not close the window (shortcuts.ts). Bubble phase, after the
  // terminal and the editor: CodeMirror ignores a key whose default is already prevented.
  useEffect(() => {
    const keep = (e: KeyboardEvent): void => {
      if (isBrowserChord(e)) e.preventDefault();
    };
    window.addEventListener('keydown', keep);
    return () => window.removeEventListener('keydown', keep);
  }, []);

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
  const startXrayDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = settings.xrayWidth;
    let w = startW;
    const move = (ev: PointerEvent): void => {
      w = Math.round(Math.min(Math.max(320, startW - (ev.clientX - startX)), window.innerWidth * 0.6));
      document.documentElement.style.setProperty('--xray-width', `${w}px`);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('is-dragging');
      setSettings({ ...settings, xrayWidth: w });
      focusTerminal();
    };
    document.body.classList.add('is-dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const nudgeXray = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const d = e.key === 'ArrowLeft' ? 24 : e.key === 'ArrowRight' ? -24 : 0;
    if (d === 0) return;
    e.preventDefault();
    setSettings({ ...settings, xrayWidth: Math.min(Math.max(320, settings.xrayWidth + d), window.innerWidth * 0.6) });
  };
  useEffect(() => {
    document.documentElement.style.setProperty('--xray-width', `${settings.xrayWidth}px`);
  }, [settings.xrayWidth]);
  const nudgePanel = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const d = e.key === 'ArrowLeft' ? -24 : e.key === 'ArrowRight' ? 24 : 0;
    if (d === 0) return;
    e.preventDefault();
    setSettings({ ...settings, panelWidth: Math.min(Math.max(300, settings.panelWidth + d), window.innerWidth * 0.6) });
  };
  useEffect(() => {
    document.documentElement.style.setProperty('--panel-width', `${settings.panelWidth}px`);
  }, [settings.panelWidth]);

  // The terminal keeps 80 columns while the window has room for them: the lab panel and a docked
  // X-ray give way down to their own minimums first (styles.css, .terminals).
  useEffect(() => {
    const c = document.createElement('canvas').getContext('2d');
    if (!c) return;
    c.font = `${settings.fontSize}px ${MONO_FONT}`;
    document.documentElement.style.setProperty('--term-cell', `${c.measureText('M').width.toFixed(3)}px`);
  }, [settings.fontSize]);

  const lang = settings.lang;
  const worldless = phase.kind === 'ready' && lab?.world === false;
  /** The attempt may show the world beyond the terminal and the ticket (assist level view or full). */
  const xrayAllowed = phase.kind === 'ready' && lab !== undefined && !(lab.world === false) && assistAllows(lab.assist, 'view');
  const xrayDocked = xrayAllowed && xray && settings.xrayMode === 'docked';
  const panelShown = phase.kind === 'ready' && settings.panelOpen && !worldless;
  const editorFor = (t: Tab): OpenEditor | undefined => Object.values(editors).find((e) => e.tty !== undefined && e.tty === t.tty);

  // What the log says about the attempt on screen: its grade's next review, and where the session stands.
  const itemProgress = attempt ? pstate.items[attempt.item] : undefined;
  const reviewAt = attempt?.outcome && attempt.outcome !== 'abandoned' && itemProgress?.schedule && itemProgress.ratedAttempt === attempt.id ? nextReview(itemProgress.schedule, pstate.settings, now) : undefined;
  const review = reviewAt ? { text: reviewAt.text, date: reviewAt.date } : undefined;
  const queue = useMemo(() => sessionQueue(pstate, CATALOG, ITEMS_BY_ID, now, session.skipped), [pstate, now, session.skipped]);
  const resumable = useMemo(() => {
    const newest = new Map<string, { item: string; attempt: string; startedAt: number }>();
    for (const [id, a] of Object.entries(pstate.open)) if (CATALOG.items[a.item] && (newest.get(a.item)?.startedAt ?? -1) < a.startedAt) newest.set(a.item, { item: a.item, attempt: id, startedAt: a.startedAt });
    return [...newest.values()].sort((x, y) => y.startedAt - x.startedAt);
  }, [pstate]);
  const gaveUp = labState !== undefined && !labState.solved && (labState.solutionViewed || labState.debriefSeen);
  const over = attempt?.outcome !== undefined || gaveUp;
  const ahead = queue.entries.filter((e) => e.item !== attempt?.item).length;
  const next: NextStep | undefined = !over ? undefined : session.running ? { label: ahead > 0 ? 'Next item' : 'Finish the session', run: () => sessionNext(false) } : { label: 'Back to home', run: goHome };
  const spentToday = (pstate.days[String(today(pstate, now))]?.activeMs ?? 0) / 60_000;
  const sessionBar =
    session.running && phase.kind !== 'home'
      ? {
          done: session.done.length,
          total: session.done.length + ahead + (attempt ? 1 : 0),
          minutesLeft: Math.max(0, pstate.settings.dailyMinutes - spentToday - (attempt && !attempt.outcome ? (clock?.elapsed ?? 0) / 60_000 : 0)),
          over,
          next: () => sessionNext(false),
          skip: () => sessionNext(true),
          stop: stopSession,
        }
      : undefined;
  const openItem = useCallback((id: string, o: { fresh: boolean }) => {
    const item = itemById(id);
    if (item) startNow(item, { fresh: o.fresh, mode: 'free' });
  }, [startNow]);
  const cardProps = lab && labState && lab.kind === 'card' ? {
    lab,
    state: labState,
    lang,
    reducedMotion,
    busy: busy === 'check',
    ...(attempt?.card ? { done: attempt.card } : {}),
    ...(attempt?.rated ? { rated: attempt.rated } : {}),
    ...(review ? { review } : {}),
    answerChoice: (choice: number) => reviewCard({ correct: choice === lab.card?.correct, choice }, Date.now() - cardShownAt.current),
    grade: (rating: Rating) => reviewCard({ rating }, Date.now() - cardShownAt.current),
    giveUp: () => reviewCard({ correct: false }, clockRef.current?.elapsed ?? 0),
    check: () => void act('check'),
    rate,
    ...(next ? { next } : {}),
  } : undefined;

  return (
    <div className={`app${settings.panelOpen ? '' : ' panel-closed'}${panelShown ? ' has-panel' : ''}${xrayDocked ? ' has-xray-docked' : ''}${reducedMotion ? ' motion-reduced' : ''}`}>
      <TopBar
        {...(lab ? { title: lang !== 'en' && lab.title.vi !== undefined ? lab.title.vi : lab.title.en } : {})}
        {...(clock && !worldless ? { clock } : {})}
        gaps={gaps}
        sink={sinkState}
        sync={progress.sync()}
        settings={settings}
        panelOpen={settings.panelOpen}
        inWorkspace={phase.kind === 'ready' && !worldless}
        {...(xrayAllowed ? { xrayOpen: xray } : {})}
        toggleXray={toggleXray}
        setSpeed={setSpeed}
        skip={skip}
        {...(skipNote ? { skipNote } : {})}
        {...(lab && phase.kind === 'ready' && !worldless ? { attemptAssist: lab.assist } : {})}
        popover={popover}
        setPopover={setPopover}
        setSettings={setSettings}
        togglePause={togglePause}
        togglePanel={togglePanel}
        openLabs={() => setPicker((v) => !v)}
        home={goHome}
        atHome={phase.kind === 'home'}
        {...(sessionBar ? { session: sessionBar } : {})}
        fullscreen={fullscreen}
        toggleFullscreen={() => {
          toggleFullscreen();
          focusTerminal();
        }}
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
        {phase.kind === 'home' ? (
          <div className="page">
            {loaded ? (
              <Home
                state={pstate}
                catalog={CATALOG}
                items={ITEMS_BY_ID}
                now={now}
                queue={queue}
                session={session}
                resumable={resumable}
                lang={lang}
                sync={progress.sync()}
                startSession={startSession}
                setDailyMinutes={(dailyMinutes) => record([settingsEvent({ dailyMinutes }, Date.now())])}
                setTrack={(activeTrack) => record([settingsEvent({ activeTrack }, Date.now())])}
                openItem={openItem}
                openBrowser={() => setPicker(true)}
              />
            ) : (
              <div className="loading">
                <div className="spinner" aria-hidden="true" />
                <p>Reading your progress…</p>
              </div>
            )}
          </div>
        ) : null}
        {worldless && cardProps ? <CardPage {...cardProps} /> : null}
        {phase.kind === 'ready' && lab && labState && panelShown ? (
          <>
            {lab.kind === 'card' && cardProps ? (
              <CardPanel {...cardProps} leave={focusTerminalNow} />
            ) : lab.steps ? (
              <LessonPanel lab={lab} state={labState} lang={lang} reducedMotion={reducedMotion} {...(busy ? { busy } : {})} {...(note ? { note } : {})} page={lessonPage} setPage={setLessonPage} act={actNow} say={say} done={attempt?.outcome === 'passed'} {...(next ? { next } : {})} leave={focusTerminalNow} />
            ) : (
              <LabPanel
                lab={lab}
                state={labState}
                lang={lang}
                reducedMotion={reducedMotion}
                {...(debrief ? { debrief } : {})}
                {...(reference ? { reference } : {})}
                {...(solutions ? { solutions } : {})}
                {...(busy ? { busy } : {})}
                {...(note ? { note } : {})}
                tab={labTab}
                setTab={setLabTab}
                act={actNow}
                say={say}
                asking={asking}
                answer={answerConfidence}
                cancelAsk={cancelAsk}
                {...(attempt?.rated ? { rated: attempt.rated } : {})}
                {...(review ? { review } : {})}
                rate={rate}
                {...(next ? { next } : {})}
                leave={focusTerminalNow}
              />
            )}
            <div className="splitter" role="separator" aria-orientation="vertical" aria-label="Resize the lab panel" tabIndex={0} onPointerDown={startPanelDrag} onKeyDown={nudgePanel} />
          </>
        ) : null}
        {phase.kind === 'home' || worldless ? null : (
        <section className="terminals pane" aria-label="Terminals">
          {phase.kind === 'ready' ? (
            <>
              <nav className="tabs" role="tablist" aria-label="Terminals">
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
                      {t.ended ? <div className="ended-note">The shell has exited. Press Enter for a new login shell, or close the tab.</div> : clock?.paused && t.key === activeTab && !ed ? (
                        <div className="paused-note" role="status">
                          <Icon name="pause" size={14} />
                          <span>Time is paused: the world stands still, and a command that needs time waits for it.</span>
                          <Button variant="ghost" small shortcut="Ctrl+Shift+Space" title="Resume time" onClick={togglePause}>
                            Resume
                          </Button>
                        </div>
                      ) : null}
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
              <h2>{phase.problem === 'error' ? 'This item could not be started' : 'This attempt cannot be resumed'}</h2>
              <p>{phase.message}</p>
              {phase.problem === 'changed' || phase.problem === 'diverged' ? <p>The simulator never continues on a world it cannot vouch for. Starting again builds the same variant from its initial state.</p> : null}
              <div className="failed-actions">
                {itemById(phase.item) ? (
                  <Button
                    variant="primary"
                    onClick={() => {
                      const item = itemById(phase.item) as Practiced;
                      const seed = store.attempt(item.id)?.seed;
                      startNow(item, { fresh: true, mode: 'free', ...(seed !== undefined ? { seed } : {}) });
                    }}
                  >
                    Start it again
                  </Button>
                ) : null}
                <Button variant="ghost" onClick={goHome}>
                  Home
                </Button>
              </div>
            </div>
          ) : null}
        </section>
        )}
        {xrayAllowed && xray && lab ? (
          <>
            {xrayDocked ? <div className="splitter splitter-xray" role="separator" aria-orientation="vertical" aria-label="Resize the X-ray" tabIndex={0} onPointerDown={startXrayDrag} onKeyDown={nudgeXray} /> : null}
            <XRay
              {...(viewModel ? { model: viewModel } : {})}
              reducedMotion={reducedMotion}
              mode={settings.xrayMode}
              setMode={setXrayMode}
              {...(settings.xrayFloat ? { rect: settings.xrayFloat } : {})}
              setRect={setXrayFloat}
              close={toggleXray}
              done={focusTerminalNow}
              assist={lab.assist}
              trace={trace}
              now={clock?.now}
              at={pastAt}
              past={past}
              scrub={scrub}
              why={askWhy}
            />
          </>
        ) : null}
        {picker ? (
          <div className={phase.kind === 'home' ? 'picker-page' : 'picker-overlay'} onMouseDown={(e) => e.target === e.currentTarget && setPicker(false)}>
            <Browser state={pstate} catalog={CATALOG} items={ITEMS_BY_ID} now={now} lang={lang} resumable={resumable} {...(lab && phase.kind === 'ready' ? { current: lab.id } : {})} openItem={(id, o) => (lab?.id === id && !o.fresh && phase.kind === 'ready' ? setPicker(false) : openItem(id, o))} onClose={() => setPicker(false)} />
          </div>
        ) : null}
      </main>
    </div>
  );
}
