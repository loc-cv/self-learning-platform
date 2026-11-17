// The lab panel: the ticket, the check's results, the hint ladder, the debrief and the reference
// solutions, each in its own tab, with the actions below every tab. What gives the answer away
// asks first: the Debrief tab before the lab is solved, and the Solutions tab; saying yes is
// giving up, recorded and rated as such. Check asks how sure the learner is first (calibration,
// PLAN.md §5); the debrief asks for the root cause in the learner's words before it shows its own.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LabAction, LabInfo, LabState, Note, PBlock, SolutionText } from '../protocol.ts';
import { Button, Dots, Icon, panelDomId, tabDomId, TabStrip, type TabItem } from './ui.tsx';
import { Blocks, T, TranslationNote } from './Prose.tsx';
import { Empty, NextButton, RatingStrip, Report, CheckRow, type NextStep, type Rated, type Review } from './parts.tsx';
import type { Lang } from './storage.ts';
import type { Rating } from '@simlab/learn';

export type LabTab = 'ticket' | 'check' | 'hints' | 'debrief' | 'solutions';
export const LAB_TABS: readonly LabTab[] = ['ticket', 'check', 'hints', 'debrief', 'solutions'];

/** The tab that shows an action's result. */
export const TAB_OF_ACTION: Record<LabAction, LabTab> = { check: 'check', hint: 'hints', debrief: 'debrief', solutions: 'solutions', reset: 'ticket' };

export interface DebriefData {
  blocks: PBlock[];
  /** The commands the learner's shells remember. */
  history: string[];
  solutions: SolutionText[];
}

interface Props {
  lab: LabInfo;
  state: LabState;
  lang: Lang;
  debrief?: DebriefData;
  reducedMotion: boolean;
  solutions?: SolutionText[];
  busy?: LabAction;
  /** A short message from the last action (no more hints). */
  note?: string;
  tab: LabTab;
  setTab(tab: LabTab): void;
  act(action: LabAction): void;
  say(note: Note): void;
  /** Check was asked for and waits for the confidence; `answer(undefined)` checks without one. */
  asking: boolean;
  answer(confidence: number | undefined): void;
  cancelAsk(): void;
  /** The grade of the finished attempt and when the item comes back. */
  rated?: Rated;
  review?: Review;
  rate(r: Rating): void;
  next?: NextStep;
  /** Escape in the panel goes back to the terminal. */
  leave(): void;
}

const ASK = {
  debrief: { text: 'The lab is not solved yet, and the debrief gives the answer away. Reading it now is giving up: it is recorded, and the lab is rated Again.', yes: 'Give up and read it' },
  solutions: { text: 'Seeing the reference solutions before the lab is solved is giving up: it is recorded, and the lab is rated Again.', yes: 'Give up and see the solution' },
  reset: { text: 'This throws away everything you changed and starts again from the initial state. The hints you saw stay seen.', yes: 'Reset the world' },
} as const;

const PREFIX = 'lab';
const KIND: Record<LabInfo['kind'], string> = { lab: 'Lab', drill: 'Drill', incident: 'Incident', lesson: 'Lesson', card: 'Card' };
const CONFIDENCE = ['guessing', 'unsure', 'maybe', 'fairly sure', 'certain'];

/** How sure before the check: 1 to 5 by click or by digit, Enter or Skip to check without saying. */
export function ConfidencePrompt({ answer, cancel }: { answer(c: number | undefined): void; cancel(): void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  return (
    <div
      className="confidence"
      role="group"
      aria-label="How sure are you that every check passes?"
      tabIndex={-1}
      ref={box}
      onKeyDown={(e) => {
        if (/^[1-5]$/.test(e.key)) answer(Number(e.key));
        else if (e.key === 'Enter' && e.target === e.currentTarget) answer(undefined);
        else if (e.key === 'Escape') cancel();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <p>How sure are you that every check passes?</p>
      <div className="confidence-scale">
        {CONFIDENCE.map((word, i) => (
          <button key={word} type="button" className="confidence-n" title={word} aria-label={`${i + 1}: ${word}`} onMouseDown={(e) => e.preventDefault()} onClick={() => answer(i + 1)}>
            <span className="confidence-digit">{i + 1}</span>
            <span className="confidence-word">{word}</span>
          </button>
        ))}
      </div>
      <div className="confidence-foot">
        <span className="confidence-keys">Press 1 to 5, or Enter to skip</span>
        <Button variant="ghost" small onClick={() => answer(undefined)}>
          Skip
        </Button>
      </div>
    </div>
  );
}

/** The root cause in the learner's words, written before the debrief shows its own (PLAN.md §5). */
function ExplainPrompt({ submit, busy }: { submit(text: string): void; busy: boolean }) {
  const [text, setText] = useState('');
  return (
    <form
      className="explain"
      onSubmit={(e) => {
        e.preventDefault();
        submit(text);
      }}
    >
      <h2>Before the debrief: what was behind it?</h2>
      <p>One sentence, in your own words. Writing it first is what makes the debrief stick; it is stored with the attempt.</p>
      <textarea className="textarea" aria-label="The root cause in your words" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="The Pods stayed Pending because…" />
      <div className="explain-actions">
        <Button variant="primary" type="submit" disabled={busy}>
          Show the debrief
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => submit('')}>
          Skip
        </Button>
      </div>
    </form>
  );
}

/** The debrief's parts in order: figures, the checks, the two command lists, the explanation and the prose, the rating. */
function Debrief({ p, data }: { p: Props; data: DebriefData }) {
  const firstText = data.blocks.findIndex((b) => 'text' in b);
  const figures = firstText === -1 ? data.blocks : data.blocks.slice(0, firstText);
  const rest = firstText === -1 ? [] : data.blocks.slice(firstText);
  const report = p.state.report;
  return (
    <div className="debrief">
      <Blocks blocks={figures} lang={p.lang} reducedMotion={p.reducedMotion} />
      {report ? (
        <section className="debrief-part" aria-label="Checks">
          <h2 className="part-title">Checks</h2>
          <ul className="checks">
            {report.checks.map((c) => (
              <CheckRow key={c.id} c={c} title={p.lab.checkTitles[c.id]} lang={p.lang} />
            ))}
          </ul>
        </section>
      ) : null}
      <section className="debrief-part" aria-label="Your commands and the reference solution">
        <div className="versus">
          <div className="versus-side">
            <h2 className="part-title">Your commands</h2>
            {data.history.length > 0 ? (
              <pre className="versus-code" tabIndex={0} aria-label="Your commands">
                <code>{data.history.join('\n')}</code>
              </pre>
            ) : (
              <p className="versus-none">The open terminals remember no command. A closed terminal and a reset world take their history with them.</p>
            )}
          </div>
          <div className="versus-side">
            <h2 className="part-title">Reference solution</h2>
            {data.solutions.map((s, i) => (
              <div key={i} className="versus-solution">
                {data.solutions.length > 1 ? (
                  <h3>
                    <T t={s.name} lang={p.lang} inline />
                  </h3>
                ) : null}
                <pre className="versus-code" tabIndex={0} aria-label="Reference solution">
                  <code>{s.text}</code>
                </pre>
              </div>
            ))}
          </div>
        </div>
      </section>
      {p.state.explanation ? (
        <section className="debrief-part" aria-label="Your explanation">
          <h2 className="part-title">Your explanation</h2>
          <blockquote className="explained">{p.state.explanation}</blockquote>
        </section>
      ) : null}
      <Blocks blocks={rest} lang={p.lang} reducedMotion={p.reducedMotion} />
      {p.rated ? <RatingStrip rated={p.rated} review={p.review} rate={p.rate} /> : null}
      <NextButton next={p.next} />
    </div>
  );
}

export function LabPanel(p: Props) {
  const [resetting, setResetting] = useState(false);
  const scrollers = useRef(new Map<LabTab, HTMLDivElement>());
  const hintsLeft = p.lab.hintCount - p.state.hints.length;
  /** The answer was seen before the lab was solved: the attempt is given up. */
  const gaveUp = p.state.solutionViewed && !p.state.solved;
  const debriefFree = p.state.solved || p.state.solutionViewed || p.state.debriefSeen;
  const solutionsFree = p.state.solved || p.state.solutionViewed;
  /** Solved unaided: the debrief waits for the learner's own explanation. */
  const explainFirst = p.state.solved && p.state.explanation === undefined && !p.state.debriefSeen;

  // What each tab holds, as a number that changes when something arrives. A tab whose number
  // moved while another tab was open says so until it is opened.
  const holds: Record<LabTab, number> = { ticket: 0, check: p.state.report?.at ?? 0, hints: p.state.hints.length, debrief: p.state.solved ? 1 : 0, solutions: 0 };
  const [seen, setSeen] = useState(holds);
  const held = holds[p.tab];
  useEffect(() => {
    setSeen((s) => (s[p.tab] === held ? s : { ...s, [p.tab]: held }));
  }, [p.tab, held]);
  const fresh = (t: LabTab): boolean => t !== p.tab && holds[t] !== 0 && holds[t] !== seen[t];

  // New results come into view. Only the tab's own scroller moves (D-130): `scrollIntoView` also
  // scrolls every ancestor that can scroll, the page included.
  const scrollTo = (tab: LabTab, selector?: string): void => {
    const box = scrollers.current.get(tab);
    if (!box) return;
    const el = selector === undefined ? undefined : box.querySelector<HTMLElement>(selector);
    let top = 0;
    if (el) {
      const at = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      const bottom = at + el.offsetHeight;
      if (at >= box.scrollTop && bottom <= box.scrollTop + box.clientHeight) return;
      // Whichever edge is nearer; an element taller than the scroller shows its start.
      top = at < box.scrollTop || el.offsetHeight > box.clientHeight ? at : bottom - box.clientHeight;
    }
    box.scrollTo({ top, behavior: p.reducedMotion ? 'auto' : 'smooth' });
  };
  const scroll = useRef(scrollTo);
  scroll.current = scrollTo;
  const reportAt = p.state.report?.at;
  useEffect(() => {
    if (reportAt !== undefined) scroll.current('check');
  }, [reportAt]);
  useEffect(() => {
    scroll.current('hints', '.hints li:last-child');
  }, [p.state.hints.length]);
  useEffect(() => {
    if (p.debrief) scroll.current('debrief');
  }, [p.debrief]);
  useEffect(() => {
    if (p.solutions) scroll.current('solutions');
  }, [p.solutions]);

  // A tab that no longer asks (the lab is solved, or its content was already seen before a
  // reload) fetches its content when it is opened.
  const { tab, act, busy } = p;
  const wantDebrief = tab === 'debrief' && debriefFree && !explainFirst && !p.debrief;
  const wantSolutions = tab === 'solutions' && solutionsFree && !p.solutions;
  useEffect(() => {
    if (busy !== undefined) return;
    if (wantDebrief) act('debrief');
    else if (wantSolutions) act('solutions');
  }, [wantDebrief, wantSolutions, busy, act]);

  const report = p.state.report;
  const passed = report?.checks.filter((c) => c.status === 'pass').length ?? 0;
  const tabs: TabItem<LabTab>[] = [
    { id: 'ticket', label: 'Ticket' },
    { id: 'check', label: 'Check', ...(report ? { badge: `${passed}/${report.checks.length}`, badgeLabel: `${passed} of ${report.checks.length} checks pass`, ...(report.passed ? { tone: 'ok' as const, icon: 'check' } : {}) } : {}), fresh: fresh('check') },
    { id: 'hints', label: 'Hints', badge: `${p.state.hints.length}/${p.lab.hintCount}`, badgeLabel: `${p.state.hints.length} of ${p.lab.hintCount} hints taken`, fresh: fresh('hints') },
    { id: 'debrief', label: 'Debrief', ...(debriefFree ? {} : { icon: 'lock' }), fresh: fresh('debrief') },
    { id: 'solutions', label: 'Solutions', ...(solutionsFree ? {} : { icon: 'lock' }) },
  ];

  const content: Record<LabTab, ReactNode> = {
    ticket: (
      <section className="ticket">
        <Blocks blocks={p.lab.ticket} lang={p.lang} reducedMotion={p.reducedMotion} />
      </section>
    ),
    check: report ? (
      <Report r={report} titles={p.lab.checkTitles} lang={p.lang} verdict={report.passed ? <strong>Solved. Every check passes; the debrief explains what was behind it.</strong> : `${Math.round(report.score * 100)}% of the checks' weight passes. Keep going, or take a hint.`}>
        {report.passed || p.state.solved ? (
          <>
            {p.rated ? <RatingStrip rated={p.rated} review={p.review} rate={p.rate} /> : null}
            <div className="report-actions">
              <Button variant={p.next ? 'plain' : 'primary'} onClick={() => p.setTab('debrief')}>
                <Icon name="book" />
                Read the debrief
              </Button>
              <NextButton next={p.next} />
            </div>
          </>
        ) : null}
      </Report>
    ) : (
      <Empty icon="check" title="Not checked yet">
        Check grades the world as it is now: the state of the cluster, never the commands you typed. Run it as often as you like.
      </Empty>
    ),
    hints:
      p.state.hints.length > 0 ? (
        <ol className="hints">
          {p.state.hints.map((h, i) => (
            <li key={i}>
              <span className="hint-n" aria-hidden="true">
                {i + 1}
              </span>
              <T t={h} lang={p.lang} />
            </li>
          ))}
        </ol>
      ) : (
        <Empty icon="hint" title="No hint taken">
          This {KIND[p.lab.kind].toLowerCase()} has {p.lab.hintCount} {p.lab.hintCount === 1 ? 'hint' : 'hints'}, each more direct than the one before. Every hint is recorded and lowers the rating.
        </Empty>
      ),
    debrief: explainFirst ? (
      <ExplainPrompt busy={p.busy === 'debrief'} submit={(text) => p.say({ kind: 'explanation', text })} />
    ) : p.debrief ? (
      <Debrief p={p} data={p.debrief} />
    ) : debriefFree ? (
      <Empty icon="book" title="Debrief">
        Drawing the debrief…
      </Empty>
    ) : (
      <Empty icon="book" title="Debrief" ask={ASK.debrief} onYes={() => p.act('debrief')} busy={p.busy === 'debrief'}>
        The root cause and the mental model behind this lab, shown on your world and on the solved one. It opens by itself once the lab is solved.
      </Empty>
    ),
    solutions: p.solutions ? (
      <div className="solutions">
        {gaveUp ? <p className="gave-up">You gave up on this attempt. Apply the solution to see it work, then move on; the lab comes back tomorrow.</p> : null}
        {p.solutions.map((s, i) => (
          <div key={i} className="solution">
            <h3>
              <T t={s.name} lang={p.lang} inline />
            </h3>
            <pre>
              <code>{s.text}</code>
            </pre>
          </div>
        ))}
        {gaveUp ? <NextButton next={p.next} /> : null}
      </div>
    ) : solutionsFree ? (
      <Empty icon="key" title="Reference solutions">
        Fetching the solutions…
      </Empty>
    ) : (
      <Empty icon="key" title="Reference solutions" ask={ASK.solutions} onYes={() => p.act('solutions')} busy={p.busy === 'solutions'}>
        The commands of each reference solution, the ones this lab is validated with.
      </Empty>
    ),
  };

  return (
    <aside
      className="lab-panel pane"
      aria-label="Lab"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        p.leave();
      }}
    >
      <header className="lab-head">
        <div className="lab-kicker">
          <span>{KIND[p.lab.kind]}</span>
          <Dots n={p.lab.difficulty} of={5} />
          <span>target {p.lab.targetMinutes} min</span>
          {p.state.solved ? <span className="pill pill-ok">solved</span> : gaveUp ? <span className="pill pill-warn">gave up</span> : null}
          <TranslationNote translation={p.lab.translation} lang={p.lang} />
        </div>
        <h1 className="lab-title">
          <T t={p.lab.title} lang={p.lang} inline />
        </h1>
        <div className="lab-id">
          {p.lab.id} · seed {p.lab.seed}
        </div>
      </header>
      <TabStrip tabs={tabs} active={p.tab} onSelect={p.setTab} label="The lab" prefix={PREFIX} />
      <div className="lab-tabpanels">
        {LAB_TABS.map((t) => (
          <div
            key={t}
            role="tabpanel"
            id={panelDomId(PREFIX, t)}
            aria-labelledby={tabDomId(PREFIX, t)}
            className={`lab-scroll${t === p.tab ? ' is-active' : ''}`}
            tabIndex={t === p.tab ? 0 : -1}
            ref={(el) => {
              if (el) scrollers.current.set(t, el);
              else scrollers.current.delete(t);
            }}
          >
            {content[t]}
          </div>
        ))}
      </div>
      <footer className="lab-actions">
        {resetting ? (
          <div className="confirm" role="alertdialog" aria-label="Reset the world">
            <p>{ASK.reset.text}</p>
            <div className="confirm-buttons">
              <Button
                variant="danger"
                small
                onClick={() => {
                  setResetting(false);
                  p.act('reset');
                }}
              >
                {ASK.reset.yes}
              </Button>
              <Button variant="ghost" small onClick={() => setResetting(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        {p.asking && !resetting ? <ConfidencePrompt answer={p.answer} cancel={p.cancelAsk} /> : null}
        {p.note && !resetting && !p.asking ? <p className="action-note">{p.note}</p> : null}
        <div className="action-row">
          <Button variant="primary" shortcut="Ctrl+Shift+Enter" title="Grade the current state of the world" disabled={p.busy === 'check'} onClick={() => p.act('check')}>
            <Icon name="check" />
            {p.busy === 'check' ? 'Checking…' : 'Check'}
          </Button>
          <Button shortcut="Ctrl+Shift+H" title="The next hint (recorded; hints lower the rating)" disabled={hintsLeft <= 0} onClick={() => p.act('hint')}>
            <Icon name="hint" />
            Hint{hintsLeft > 0 ? ` ${p.state.hints.length + 1}/${p.lab.hintCount}` : 's used'}
          </Button>
          <span className="spacer" />
          <Button variant="ghost" title="Reset: start again from the initial state" aria-label="Reset" onClick={() => setResetting(true)}>
            <Icon name="reset" />
            <span className="label">Reset</span>
          </Button>
        </div>
      </footer>
    </aside>
  );
}
