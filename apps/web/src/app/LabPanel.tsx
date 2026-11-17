// The lab panel: the ticket, check results per check, the hint ladder, the debrief and the
// reference solutions, with the actions at the bottom. Actions that give something away ask
// first, in the words `npm run lab` uses (apps/cli/src/labsession.ts).

import { useEffect, useRef, useState } from 'react';
import type { CheckReport, GradeReport, RenderedBlock } from '@simlab/learn';
import type { LabAction, LabInfo, LabState } from '../protocol.ts';
import { renderInline, renderMarkdown } from './markdown.ts';
import { Button, Dots, Icon } from './ui.tsx';
import { Blocks } from './Figure.tsx';

interface Props {
  lab: LabInfo;
  state: LabState;
  debrief?: RenderedBlock[];
  reducedMotion: boolean;
  solutions?: { name: string; text: string }[];
  busy?: LabAction;
  /** A short message from the last action (no more hints). */
  note?: string;
  act(action: LabAction): void;
}

type Pending = 'debrief' | 'solutions' | 'reset';

const CONFIRM: Record<Pending, { text: string; yes: string; danger?: boolean }> = {
  debrief: { text: 'The lab is not solved yet, and the debrief gives the answer away.', yes: 'Read it anyway' },
  solutions: { text: 'Viewing the reference solutions is recorded and lowers the rating.', yes: 'Show solutions' },
  reset: { text: 'This throws away everything you changed and starts again from the initial state. The hints you saw stay seen.', yes: 'Reset the world', danger: true },
};

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

function Report({ r }: { r: GradeReport }) {
  const passed = r.checks.filter((c) => c.status === 'pass').length;
  const pct = Math.round(r.score * 100);
  return (
    <section className={`lab-section report${r.passed ? ' is-solved' : ''}`} aria-live="polite">
      <header className="section-head">
        <h2>Check</h2>
        <span className="section-meta">
          {passed} of {r.checks.length} pass · {pct}%
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
    </section>
  );
}

export function LabPanel(p: Props) {
  const [pending, setPending] = useState<Pending | undefined>();
  const scroller = useRef<HTMLDivElement>(null);
  const reportAt = p.state.report?.at;

  // Bring new results into view. Only the panel's own scroller moves: `scrollIntoView` also scrolls
  // every ancestor that can scroll, the page included.
  const reveal = (selector: string, block: 'nearest' | 'start'): void => {
    const box = scroller.current;
    const el = box?.querySelector<HTMLElement>(selector);
    if (!box || !el) return;
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    const bottom = top + el.offsetHeight;
    let to = top;
    if (block === 'nearest') {
      if (top >= box.scrollTop && bottom <= box.scrollTop + box.clientHeight) return;
      // Whichever edge is nearer; an element taller than the scroller shows its start.
      to = top < box.scrollTop || el.offsetHeight > box.clientHeight ? top : bottom - box.clientHeight;
    }
    box.scrollTo({ top: to, behavior: p.reducedMotion ? 'auto' : 'smooth' });
  };
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  useEffect(() => {
    if (reportAt !== undefined) revealRef.current('.report', 'nearest');
  }, [reportAt]);
  useEffect(() => {
    revealRef.current('.hints li:last-child', 'nearest');
  }, [p.state.hints.length]);
  useEffect(() => {
    if (p.debrief) revealRef.current('.debrief', 'start');
  }, [p.debrief]);
  useEffect(() => {
    if (p.solutions) revealRef.current('.solutions', 'start');
  }, [p.solutions]);

  const ask = (what: Pending): void => {
    const free = (what === 'debrief' && (p.state.solved || p.state.debriefSeen)) || (what === 'solutions' && p.state.solutionViewed);
    if (free) p.act(what);
    else setPending(what);
  };
  const hintsLeft = p.lab.hintCount - p.state.hints.length;

  return (
    <aside className="lab-panel" aria-label="Lab">
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
      <div className="lab-scroll" ref={scroller}>
        <section className="ticket">
          <Blocks blocks={p.lab.ticket} reducedMotion={p.reducedMotion} />
        </section>
        {p.state.report ? <Report r={p.state.report} /> : null}
        {p.state.hints.length > 0 ? (
          <section className="lab-section">
            <header className="section-head">
              <h2>Hints</h2>
              <span className="section-meta">
                {p.state.hints.length} of {p.lab.hintCount}
              </span>
            </header>
            <ol className="hints">
              {p.state.hints.map((h, i) => (
                <li key={i} className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(h) }} />
              ))}
            </ol>
          </section>
        ) : null}
        {p.debrief ? (
          <section className="lab-section debrief">
            <header className="section-head">
              <h2>Debrief</h2>
            </header>
            <Blocks blocks={p.debrief} reducedMotion={p.reducedMotion} />
          </section>
        ) : null}
        {p.solutions ? (
          <section className="lab-section solutions">
            <header className="section-head">
              <h2>Reference solutions</h2>
            </header>
            {p.solutions.map((s) => (
              <div key={s.name} className="solution">
                <h3>{s.name}</h3>
                <pre>
                  <code>{s.text}</code>
                </pre>
              </div>
            ))}
          </section>
        ) : null}
      </div>
      <footer className="lab-actions">
        {pending ? (
          <div className="confirm" role="alertdialog">
            <p>{CONFIRM[pending].text}</p>
            <div className="confirm-buttons">
              <Button
                variant={CONFIRM[pending].danger ? 'danger' : 'primary'}
                small
                onClick={() => {
                  setPending(undefined);
                  p.act(pending);
                }}
              >
                {CONFIRM[pending].yes}
              </Button>
              <Button variant="ghost" small onClick={() => setPending(undefined)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        {p.note && !pending ? <p className="action-note">{p.note}</p> : null}
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
          <Button variant="ghost" small title="Debrief: the root cause and the mental model" aria-label="Debrief" onClick={() => ask('debrief')}>
            <Icon name="book" />
            <span className="label">Debrief</span>
          </Button>
          <Button variant="ghost" small title="Solutions: the reference solutions" aria-label="Solutions" onClick={() => ask('solutions')}>
            <Icon name="key" />
            <span className="label">Solutions</span>
          </Button>
          <Button variant="ghost" small title="Reset: start again from the initial state" aria-label="Reset" onClick={() => setPending('reset')}>
            <Icon name="reset" />
          </Button>
        </div>
      </footer>
    </aside>
  );
}
