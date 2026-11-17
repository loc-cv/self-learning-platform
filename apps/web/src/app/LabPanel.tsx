// The lab panel: the ticket, the check's results, the hint ladder, the debrief and the reference
// solutions, each in its own tab, with the actions below every tab. What gives the answer away
// asks first, in the words `npm run lab` uses (apps/cli/src/labsession.ts): the Debrief tab before
// the lab is solved, and the Solutions tab.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CheckReport, GradeReport, RenderedBlock } from '@simlab/learn';
import type { LabAction, LabInfo, LabState } from '../protocol.ts';
import { renderInline, renderMarkdown } from './markdown.ts';
import { Button, Dots, Icon, panelDomId, tabDomId, TabStrip, type TabItem } from './ui.tsx';
import { Blocks } from './Figure.tsx';

export type LabTab = 'ticket' | 'check' | 'hints' | 'debrief' | 'solutions';
export const LAB_TABS: readonly LabTab[] = ['ticket', 'check', 'hints', 'debrief', 'solutions'];

/** The tab that shows an action's result. */
export const TAB_OF_ACTION: Record<LabAction, LabTab> = { check: 'check', hint: 'hints', debrief: 'debrief', solutions: 'solutions', reset: 'ticket' };

interface Props {
  lab: LabInfo;
  state: LabState;
  debrief?: RenderedBlock[];
  reducedMotion: boolean;
  solutions?: { name: string; text: string }[];
  busy?: LabAction;
  /** A short message from the last action (no more hints). */
  note?: string;
  tab: LabTab;
  setTab(tab: LabTab): void;
  act(action: LabAction): void;
  /** Escape in the panel goes back to the terminal. */
  leave(): void;
}

const ASK = {
  debrief: { text: 'The lab is not solved yet, and the debrief gives the answer away.', yes: 'Read it anyway' },
  solutions: { text: 'Viewing the reference solutions is recorded and lowers the rating.', yes: 'Show solutions' },
  reset: { text: 'This throws away everything you changed and starts again from the initial state. The hints you saw stay seen.', yes: 'Reset the world' },
} as const;

const PREFIX = 'lab';

function CheckRow({ c }: { c: CheckReport }) {
  const mark = c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '!';
  return (
    <li className={`check is-${c.status}`}>
      <span className="check-mark" aria-label={c.status}>
        {mark}
      </span>
      <div className="check-body">
        <div className="check-title">
          <span dangerouslySetInnerHTML={{ __html: renderInline(c.title) }} />
          {c.weight !== 1 ? <span className="check-weight">weight {c.weight}</span> : null}
        </div>
        {c.status === 'fail' ? (
          <dl className="check-detail">
            <dt>wanted</dt>
            <dd>{c.expected}</dd>
            <dt>found</dt>
            <dd>{c.observed}</dd>
          </dl>
        ) : null}
        {c.status === 'error' ? <div className="check-detail">could not be evaluated: {c.error ?? ''}</div> : null}
      </div>
    </li>
  );
}

function Report({ r, openDebrief }: { r: GradeReport; openDebrief(): void }) {
  const passed = r.checks.filter((c) => c.status === 'pass').length;
  const pct = Math.round(r.score * 100);
  return (
    <section className={`report${r.passed ? ' is-solved' : ''}`} aria-live="polite">
      <header className="score">
        <span className="score-pct">{pct}%</span>
        <span className="score-count">
          {passed} of {r.checks.length} checks pass
        </span>
      </header>
      <div className="meter" aria-hidden="true">
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <ul className="checks">
        {r.checks.map((c) => (
          <CheckRow key={c.id} c={c} />
        ))}
      </ul>
      <p className="verdict">{r.passed ? <strong>Solved. Every check passes; the debrief explains what was behind it.</strong> : `${pct}% of the checks' weight passes. Keep going, or take a hint.`}</p>
      {r.passed ? (
        <Button variant="primary" onClick={openDebrief}>
          <Icon name="book" />
          Read the debrief
        </Button>
      ) : null}
    </section>
  );
}

/** What a tab says while it holds nothing, and the question before something that gives the answer away. */
function Empty({ icon, title, children, ask, onYes, busy }: { icon: string; title: string; children: ReactNode; ask?: { text: string; yes: string }; onYes?: () => void; busy?: boolean }) {
  return (
    <div className="tab-empty">
      <span className="tab-empty-icon">
        <Icon name={icon} size={20} />
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
      {ask ? (
        <div className="tab-ask">
          <p>{ask.text}</p>
          <Button variant="primary" disabled={busy} onClick={onYes}>
            {ask.yes}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function LabPanel(p: Props) {
  const [resetting, setResetting] = useState(false);
  const scrollers = useRef(new Map<LabTab, HTMLDivElement>());
  const hintsLeft = p.lab.hintCount - p.state.hints.length;
  const debriefFree = p.state.solved || p.state.debriefSeen;
  const solutionsFree = p.state.solutionViewed;

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
  const wantDebrief = tab === 'debrief' && debriefFree && !p.debrief;
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
        <Blocks blocks={p.lab.ticket} reducedMotion={p.reducedMotion} />
      </section>
    ),
    check: report ? (
      <Report r={report} openDebrief={() => p.setTab('debrief')} />
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
              <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(h) }} />
            </li>
          ))}
        </ol>
      ) : (
        <Empty icon="hint" title="No hint taken">
          This lab has {p.lab.hintCount} {p.lab.hintCount === 1 ? 'hint' : 'hints'}, each more direct than the one before. Hints lower the rating.
        </Empty>
      ),
    debrief: p.debrief ? (
      <div className="debrief">
        <Blocks blocks={p.debrief} reducedMotion={p.reducedMotion} />
      </div>
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
        {p.solutions.map((s) => (
          <div key={s.name} className="solution">
            <h3>{s.name}</h3>
            <pre>
              <code>{s.text}</code>
            </pre>
          </div>
        ))}
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
          <span>Lab</span>
          <Dots n={p.lab.difficulty} of={5} />
          <span>about {p.lab.targetMinutes} min</span>
          {p.state.solved ? <span className="pill pill-ok">solved</span> : null}
        </div>
        <h1 className="lab-title">{p.lab.title}</h1>
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
        {p.note && !resetting ? <p className="action-note">{p.note}</p> : null}
        <div className="action-row">
          <Button variant="primary" shortcut="Ctrl+Shift+Enter" title="Grade the current state of the world" disabled={p.busy === 'check'} onClick={() => p.act('check')}>
            <Icon name="check" />
            {p.busy === 'check' ? 'Checking…' : 'Check'}
          </Button>
          <Button shortcut="Ctrl+Shift+H" title="The next hint (hints lower the rating)" disabled={hintsLeft <= 0} onClick={() => p.act('hint')}>
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
