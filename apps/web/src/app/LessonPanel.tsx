// A lesson beside the live terminal (docs/LEARNING_MODEL.md §2.1): its steps in pages of the same
// tab strip as a lab's parts. A page ends at a prediction or a guided task; the next page opens
// when the prediction is locked in or the task's checks pass. Figures come before prose.

import { useEffect, useRef, useState } from 'react';
import type { LabAction, LabInfo, LabState, LessonStep, Note, Text } from '../protocol.ts';
import { gateDone, lessonFrontier, lessonPages } from './flow.ts';
import { Empty, NextButton, Report, type NextStep } from './parts.tsx';
import { FigureBlock, T, TranslationNote } from './Prose.tsx';
import type { Lang } from './storage.ts';
import { Button, Dots, Icon, panelDomId, tabDomId, TabStrip, type TabItem } from './ui.tsx';

interface Props {
  lab: LabInfo;
  state: LabState;
  lang: Lang;
  reducedMotion: boolean;
  busy?: LabAction;
  note?: string;
  page: number;
  setPage(page: number): void;
  act(action: LabAction, step?: number): void;
  say(note: Note): void;
  /** Every task passed and every prediction is answered. */
  done: boolean;
  next?: NextStep;
  leave(): void;
}

const PREFIX = 'lesson';
const pageId = (i: number): string => `p${i}`;

/** A prediction prompt: answer, lock it in, then see what happens (PLAN.md §5 "Prediction"). */
export function Prediction({ step, index, answered, lang, say }: { step: Extract<LessonStep, { kind: 'predict' }>; index: number; answered?: { choice?: number; text?: string } | undefined; lang: Lang; say(note: Note): void }) {
  const [choice, setChoice] = useState<number>();
  const [text, setText] = useState('');
  const locked = answered !== undefined;
  const chosen = locked ? answered.choice : choice;
  const right = locked && step.answer !== undefined && answered.choice === step.answer;
  return (
    <section className={`predict${locked ? ' is-locked' : ''}`} aria-label="Prediction">
      <div className="predict-kicker">
        <Icon name="hint" size={14} />
        Predict first
      </div>
      <T t={step.prompt} lang={lang} />
      {step.choices ? (
        <div className="choices" role="radiogroup" aria-label="Your prediction">
          {step.choices.map((c: Text, i) => {
            const mark = !locked ? undefined : i === step.answer ? 'right' : i === answered.choice ? 'wrong' : undefined;
            return (
              <button key={i} type="button" role="radio" aria-checked={chosen === i} disabled={locked} className={`choice${chosen === i ? ' is-chosen' : ''}${mark ? ` is-${mark}` : ''}`} onClick={() => setChoice(i)}>
                <span className="choice-key" aria-hidden="true">
                  {mark === 'right' ? '✓' : mark === 'wrong' ? '✗' : String.fromCharCode(65 + i)}
                </span>
                <T t={c} lang={lang} inline />
                {mark ? <span className="sr-only">{mark === 'right' ? '(the answer)' : '(your answer, not right)'}</span> : null}
              </button>
            );
          })}
        </div>
      ) : locked ? (
        <blockquote className="explained">{answered.text === undefined || answered.text === '' ? 'You answered in your head.' : answered.text}</blockquote>
      ) : (
        <textarea className="textarea" rows={2} aria-label="Your prediction" value={text} onChange={(e) => setText(e.target.value)} placeholder="What do you expect? A few words are enough." />
      )}
      {locked ? (
        <div className="predict-reveal" aria-live="polite">
          {step.answer !== undefined ? <p className={`predict-verdict ${right ? 'is-right' : 'is-wrong'}`}>{right ? '✓ Right.' : '✗ Not what happens.'}</p> : <p className="predict-verdict">What happens:</p>}
          <T t={step.explain} lang={lang} />
        </div>
      ) : (
        <Button variant="primary" disabled={step.choices !== undefined && choice === undefined} onClick={() => say(step.choices ? { kind: 'prediction', step: index, choice: choice as number } : { kind: 'prediction', step: index, text: text.trim() })}>
          Lock in my answer
        </Button>
      )}
    </section>
  );
}

export function LessonPanel(p: Props) {
  const steps = p.lab.steps ?? [];
  const pages = lessonPages(steps);
  const { tasks, predictions } = p.state;
  const frontier = lessonFrontier(pages, steps, tasks, predictions);
  const at = Math.min(p.page, pages.length - 1);
  const page = pages[at];
  const locked = at > frontier;
  const task = page?.gateKind === 'task' && page.gate !== undefined ? { step: page.gate, info: steps[page.gate] as Extract<LessonStep, { kind: 'task' }>, state: tasks?.[page.gate] } : undefined;
  const pageDone = page !== undefined && gateDone(page, steps, tasks, predictions);
  const scroller = useRef<HTMLDivElement>(null);
  const [resetting, setResetting] = useState(false);

  // A gate just passed: the next page opens by itself (a task's checks passed, a prediction read).
  const { setPage } = p;
  const taskPassed = task?.state?.passed === true;
  const was = useRef(taskPassed);
  useEffect(() => {
    if (taskPassed && !was.current && at < pages.length - 1) setPage(at + 1);
    was.current = taskPassed;
  }, [taskPassed, at, pages.length, setPage]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [at]);

  const tabs: TabItem[] = pages.map((pg, i) => {
    const done = pg.gate !== undefined && gateDone(pg, steps, tasks, predictions);
    const what = pg.gateKind === 'task' ? 'task' : pg.gateKind === 'predict' ? 'prediction' : 'reading';
    return { id: pageId(i), label: `${i + 1}`, icon: i > frontier ? 'lock' : done ? 'check' : pg.gateKind === 'task' ? 'terminal' : pg.gateKind === 'predict' ? 'hint' : 'book', name: `Step ${i + 1}: ${what}${done ? ', done' : i > frontier ? ', locked' : ''}`, ...(done ? { tone: 'ok' as const } : {}) };
  });

  return (
    <aside
      className="lab-panel lesson-panel pane"
      aria-label="Lesson"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        p.leave();
      }}
    >
      <header className="lab-head">
        <div className="lab-kicker">
          <span>Lesson</span>
          <Dots n={p.lab.difficulty} of={5} />
          <span>about {p.lab.targetMinutes} min</span>
          {p.done ? <span className="pill pill-ok">done</span> : null}
          <TranslationNote translation={p.lab.translation} lang={p.lang} />
        </div>
        <h1 className="lab-title">
          <T t={p.lab.title} lang={p.lang} inline />
        </h1>
        <div className="lab-id">
          {p.lab.id} · seed {p.lab.seed}
        </div>
      </header>
      <TabStrip tabs={tabs} active={pageId(at)} onSelect={(id) => p.setPage(Number(id.slice(1)))} label="The lesson's steps" prefix={PREFIX} />
      <div className="lab-tabpanels">
        <div role="tabpanel" id={panelDomId(PREFIX, pageId(at))} aria-labelledby={tabDomId(PREFIX, pageId(at))} className="lab-scroll is-active" tabIndex={0} ref={scroller}>
          {locked ? (
            <Empty icon="lock" title="Not yet">
              This step opens when the one before it is done.
            </Empty>
          ) : (
            <div className="lesson-page">
              {page?.steps.map((i) => {
                const s = steps[i] as LessonStep;
                if (s.kind === 'text') return <T key={i} t={s.text} lang={p.lang} />;
                if (s.kind === 'figure') {
                  const block = p.state.figures?.[i] ?? s.block;
                  return 'text' in block ? null : <FigureBlock key={i} block={block} lang={p.lang} reducedMotion={p.reducedMotion} />;
                }
                if (s.kind === 'predict') return <Prediction key={i} step={s} index={i} answered={predictions?.[i]} lang={p.lang} say={p.say} />;
                const t = tasks?.[i];
                return (
                  <section key={i} className={`task${t?.passed ? ' is-done' : ''}`} aria-label="Guided task">
                    <div className="predict-kicker">
                      <Icon name="terminal" size={14} />
                      Your turn, in the terminal
                    </div>
                    <T t={s.text} lang={p.lang} />
                    {t && t.hints.length > 0 ? (
                      <ol className="hints">
                        {t.hints.map((h, k) => (
                          <li key={k}>
                            <span className="hint-n" aria-hidden="true">
                              {k + 1}
                            </span>
                            <T t={h} lang={p.lang} />
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    {t?.report ? <Report r={t.report} titles={p.lab.checkTitles} lang={p.lang} verdict={t.report.passed ? <strong>Done. On to the next step.</strong> : 'Not there yet. Look at what the check found, or take a hint.'} /> : t?.passed ? <p className="task-passed">✓ Done.</p> : null}
                  </section>
                );
              })}
              {p.done && at === pages.length - 1 ? (
                <section className="lesson-done" aria-live="polite">
                  <h2>Lesson complete</h2>
                  <p>A lesson is done once and does not come back for review. What it taught returns as drills, labs and cards on the same skills.</p>
                  <NextButton next={p.next} />
                </section>
              ) : null}
            </div>
          )}
        </div>
      </div>
      <footer className="lab-actions">
        {resetting ? (
          <div className="confirm" role="alertdialog" aria-label="Reset the world">
            <p>This starts the lesson's world again from its initial state. Tasks you finished stay finished.</p>
            <div className="confirm-buttons">
              <Button
                variant="danger"
                small
                onClick={() => {
                  setResetting(false);
                  p.act('reset');
                }}
              >
                Reset the world
              </Button>
              <Button variant="ghost" small onClick={() => setResetting(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        {p.note && !resetting ? <p className="action-note">{p.note}</p> : null}
        <div className="action-row">
          {task && !task.state?.passed && !locked ? (
            <>
              <Button variant="primary" shortcut="Ctrl+Shift+Enter" title="Check this task against the world as it is now" disabled={p.busy === 'check'} onClick={() => p.act('check', task.step)}>
                <Icon name="check" />
                {p.busy === 'check' ? 'Checking…' : 'Check'}
              </Button>
              <Button shortcut="Ctrl+Shift+H" title="The next hint for this task (recorded)" disabled={(task.state?.hints.length ?? 0) >= task.info.hintCount} onClick={() => p.act('hint', task.step)}>
                <Icon name="hint" />
                {(task.state?.hints.length ?? 0) >= task.info.hintCount ? (task.info.hintCount === 0 ? 'No hints' : 'Hints used') : `Hint ${(task.state?.hints.length ?? 0) + 1}/${task.info.hintCount}`}
              </Button>
            </>
          ) : at < pages.length - 1 ? (
            <Button variant="primary" disabled={!pageDone || locked} title={pageDone ? 'The next step' : 'Lock in the prediction to go on'} onClick={() => p.setPage(at + 1)}>
              Continue
              <Icon name="next" />
            </Button>
          ) : (
            <NextButton next={p.done ? p.next : undefined} />
          )}
          <span className="spacer" />
          <Button variant="ghost" title="Reset: start the world again from its initial state" aria-label="Reset" onClick={() => setResetting(true)}>
            <Icon name="reset" />
            <span className="label">Reset</span>
          </Button>
        </div>
      </footer>
    </aside>
  );
}
