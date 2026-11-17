// A card (docs/LEARNING_MODEL.md §2.2): a retrieval question answered in under a minute. The
// prompt, then one of three ways to answer: recall and rate yourself, pick a choice, or do it in
// the card's world and let the checks grade its state. The expected answer shows on reveal, with
// the grade the schedule got and a one-click override.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Rating } from '@simlab/learn';
import type { LabInfo, LabState } from '../protocol.ts';
import { RATING_NAMES } from './flow.ts';
import { NextButton, RatingStrip, Report, type NextStep, type Rated, type Review } from './parts.tsx';
import { Blocks, T, TranslationNote } from './Prose.tsx';
import type { Lang } from './storage.ts';
import { Button, Dots, Icon } from './ui.tsx';

export interface CardProps {
  lab: LabInfo;
  state: LabState;
  lang: Lang;
  reducedMotion: boolean;
  busy?: boolean;
  /** The review is recorded: what was answered. */
  done?: { correct?: boolean; choice?: number };
  rated?: Rated;
  review?: Review;
  /** Records the review: a choice, a self-grade, or (by command) giving up. */
  answerChoice(choice: number): void;
  grade(r: Rating): void;
  giveUp(): void;
  /** By command: grade the world. */
  check(): void;
  /** Replaces the grade of the recorded review. */
  rate(r: Rating): void;
  next?: NextStep;
}

const GRADES: { r: Rating; hint: string }[] = [
  { r: 1, hint: 'did not know it' },
  { r: 2, hint: 'knew it, with effort' },
  { r: 3, hint: 'knew it' },
  { r: 4, hint: 'knew it at once' },
];

function Head({ p }: { p: CardProps }) {
  return (
    <header className="lab-head">
      <div className="lab-kicker">
        <span>Card</span>
        <Dots n={p.lab.difficulty} of={5} />
        <span>under {Math.max(1, Math.ceil(p.lab.targetMinutes))} min</span>
        <TranslationNote translation={p.lab.translation} lang={p.lang} />
      </div>
      <h1 className="lab-title">
        <T t={p.lab.title} lang={p.lang} inline />
      </h1>
      <div className="lab-id">
        {p.lab.id} · seed {p.lab.seed}
      </div>
    </header>
  );
}

/** The question, the way to answer it, and after the answer what was expected. */
function Body({ p }: { p: CardProps }) {
  const card = p.lab.card;
  const [choice, setChoice] = useState<number>();
  const [typed, setTyped] = useState('');
  const [revealed, setRevealed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const done = p.done !== undefined;
  // Digits answer: a choice by its number, a self-grade by 1 to 4. Not while typing an answer.
  useEffect(() => {
    if (!card) return undefined;
    const key = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.altKey || e.metaKey || !/^[1-9]$/.test(e.key)) return;
      const el = document.activeElement;
      if (el instanceof HTMLTextAreaElement || el?.closest('.terminal-stack')) return;
      const n = Number(e.key);
      if (card.way === 'choice' && !done && card.choices && n <= card.choices.length) setChoice(n - 1);
      else if (card.way === 'self' && revealed && !done && n <= 4) p.grade(n as Rating);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [card, done, revealed, p]);
  useEffect(() => {
    if (!p.lab.world) box.current?.focus();
  }, [p.lab.id, p.lab.seed, p.lab.world]);
  if (!card) return null;
  const chosen = done ? p.done?.choice : choice;
  let answerArea: ReactNode;
  if (card.way === 'choice' && card.choices) {
    answerArea = (
      <>
        <div className="choices" role="radiogroup" aria-label="Your answer">
          {card.choices.map((c, i) => {
            const mark = !done ? undefined : i === card.correct ? 'right' : i === p.done?.choice ? 'wrong' : undefined;
            return (
              <button key={i} type="button" role="radio" aria-checked={chosen === i} disabled={done} className={`choice${chosen === i ? ' is-chosen' : ''}${mark ? ` is-${mark}` : ''}`} onClick={() => setChoice(i)}>
                <span className="choice-key" aria-hidden="true">
                  {mark === 'right' ? '✓' : mark === 'wrong' ? '✗' : i + 1}
                </span>
                <T t={c} lang={p.lang} inline />
                {mark ? <span className="sr-only">{mark === 'right' ? '(the answer)' : '(your answer, not right)'}</span> : null}
              </button>
            );
          })}
        </div>
        {done ? null : (
          <Button variant="primary" disabled={choice === undefined} onClick={() => choice !== undefined && p.answerChoice(choice)}>
            Answer
          </Button>
        )}
      </>
    );
  } else if (card.way === 'self') {
    answerArea = done ? (
      typed.trim() !== '' ? (
        <blockquote className="explained">{typed}</blockquote>
      ) : null
    ) : (
      <>
        <textarea className="textarea" rows={2} aria-label="Your answer (optional)" value={typed} disabled={revealed} onChange={(e) => setTyped(e.target.value)} placeholder="Type your answer, or answer in your head." />
        {revealed ? null : (
          <Button variant="primary" onClick={() => setRevealed(true)}>
            Show the answer
          </Button>
        )}
      </>
    );
  } else {
    answerArea = (
      <>
        <p className="card-how">Do it in the terminal. Check grades the state of the world, not the command.</p>
        {p.state.report && !p.state.report.passed ? <Report r={p.state.report} titles={p.lab.checkTitles} lang={p.lang} verdict="Not there yet." /> : null}
        {done ? null : (
          <div className="card-actions">
            <Button variant="primary" shortcut="Ctrl+Shift+Enter" disabled={p.busy === true} onClick={p.check}>
              <Icon name="check" />
              {p.busy ? 'Checking…' : 'Check'}
            </Button>
            <Button variant="ghost" title="Recorded: the card is rated Again" onClick={p.giveUp}>
              Give up and show the answer
            </Button>
          </div>
        )}
      </>
    );
  }
  const shown = done || (card.way === 'self' && revealed);
  return (
    <div className="card-body" tabIndex={-1} ref={box}>
      <div className="card-prompt">
        <Blocks blocks={p.lab.ticket} lang={p.lang} reducedMotion={p.reducedMotion} />
      </div>
      {answerArea}
      {shown ? (
        <section className="card-answer" aria-live="polite">
          {done && p.done?.correct !== undefined ? <p className={`predict-verdict ${p.done.correct ? 'is-right' : 'is-wrong'}`}>{p.done.correct ? '✓ Right.' : '✗ Not right.'}</p> : null}
          <h2 className="part-title">Answer</h2>
          <T t={card.answer} lang={p.lang} />
        </section>
      ) : null}
      {card.way === 'self' && revealed && !done ? (
        <div className="grades" role="group" aria-label="How well did you know it?">
          <p>How well did you know it? (1 to 4)</p>
          <div className="grades-row">
            {GRADES.map((g, i) => (
              <button key={g.r} type="button" className={`grade is-r${g.r}`} onClick={() => p.grade(g.r)}>
                <span className="choice-key" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="grade-name">{RATING_NAMES[g.r]}</span>
                <span className="grade-hint">{g.hint}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {done && p.rated ? <RatingStrip rated={p.rated} review={p.review} rate={p.rate} /> : null}
      {done ? <NextButton next={p.next} /> : null}
    </div>
  );
}

/** A card with no world: the whole workspace is the card. */
export function CardPage(p: CardProps) {
  return (
    <section className="card-page" aria-label="Card">
      <article className="card pane">
        <Head p={p} />
        <Body p={p} />
      </article>
    </section>
  );
}

/** A card answered in its world: the card sits where a lab's panel sits, beside the terminal. */
export function CardPanel(p: CardProps & { leave(): void }) {
  return (
    <aside
      className="lab-panel card-panel pane"
      aria-label="Card"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        p.leave();
      }}
    >
      <Head p={p} />
      <div className="lab-tabpanels">
        <div className="lab-scroll is-active" tabIndex={0}>
          <Body p={p} />
        </div>
      </div>
    </aside>
  );
}
