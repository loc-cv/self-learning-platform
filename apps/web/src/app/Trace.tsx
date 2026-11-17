// The trace in words (PLAN.md §6.5, docs/DESIGN.md §7): an event as a line (when, who acted, what
// it did, its verdicts per candidate), and a "why" as a summary over the events that led there,
// oldest first. Shared by the X-ray's inspector, its timeline and the debrief's replay.
//
// Event text is the simulator's own vocabulary, never a real tool's output (docs/ARCHITECTURE.md
// §2.9), so it is set in the interface's type with a "simulator" tag, never like terminal output;
// only what the learner typed is in the code font. Like the renderer it names no domain.

import type { ViewEvent, ViewEventItem, ViewTone, Why } from '@simlab/kernel';
import { formatOffset } from './timeline.ts';

/** The words of a moment: an offset from `start` and, for the tooltip, the clock time. */
export function When({ t, start, until }: { t: number; start: number | undefined; until?: number | undefined }) {
  const clock = new Date(t).toLocaleTimeString([], { hour12: false });
  const ran = until !== undefined && until > t ? `, ran ${formatOffset(until - t).slice(1)}` : '';
  return (
    <time className="trace-when" dateTime={new Date(t).toISOString()} title={start === undefined ? clock : `${clock} (virtual time)${t < start ? ', before the attempt started' : ', from the attempt’s start'}${ran}`}>
      {start === undefined ? clock : formatOffset(t - start)}
    </time>
  );
}

const TONE_WORD: Record<ViewTone, string> = { good: 'helped', bad: 'hurt', neutral: 'happened' };

/** How an event or a verdict reads, as a glyph that does not need its color. */
export function ToneMark({ tone }: { tone: ViewTone }) {
  return (
    <span className={`trace-tone tone-${tone}`} role="img" aria-label={TONE_WORD[tone]}>
      {tone === 'good' ? '✓' : tone === 'bad' ? '✗' : '·'}
    </span>
  );
}

/** "Simulator": what follows is the simulator's account of what happened. */
export function SimTag() {
  return (
    <span className="sim-voice" title="The simulator's own account of what happened, not the output of a real tool">
      simulator
    </span>
  );
}

/** Per-candidate lines under an event. An item about an entity selects it when `select` is given. */
export function EventItems({ items, select }: { items: readonly ViewEventItem[]; select?: ((id: string) => void) | undefined }) {
  if (items.length === 0) return null;
  return (
    <ul className="trace-items">
      {items.map((i, n) => (
        <li key={n} className={`tone-${i.tone}`}>
          <ToneMark tone={i.tone} />
          {i.entity !== undefined && select ? (
            <button type="button" className="linklike trace-item-label" title="Select it in the drawing" onMouseDown={(e) => e.preventDefault()} onClick={() => select(i.entity as string)}>
              {i.label}
            </button>
          ) : (
            <span className="trace-item-label">{i.label}</span>
          )}
          {i.value !== '' ? <span className="trace-item-value">{i.value}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** One event: when, who, what; a command as the learner typed it. */
export function EventLine({ e, start, select, children }: { e: ViewEvent; start: number | undefined; select?: ((id: string) => void) | undefined; children?: React.ReactNode }) {
  return (
    <div className={`trace-event tone-${e.tone}${e.input ? ' is-input' : ''}${e.level === 'detail' ? ' is-detail' : ''}`}>
      <div className="trace-event-head">
        <When t={e.t} start={start} until={e.until} />
        <ToneMark tone={e.tone} />
        <span className="trace-actor">{e.actor}</span>
      </div>
      {e.input ? <code className="trace-input">{e.text}</code> : <p className="trace-text">{e.text}</p>}
      <EventItems items={e.items ?? []} select={select} />
      {children}
    </div>
  );
}

/** A "why": its summary, then the chain of events oldest first. */
export function WhyChain({ why, start, select, heading }: { why: Why; start: number | undefined; select?: ((id: string) => void) | undefined; heading?: React.ReactNode }) {
  return (
    <div className="why">
      {heading}
      <p className="why-summary">{why.summary}</p>
      {why.steps.length > 0 ? (
        <ol className="why-steps">
          {why.steps.map((e) => (
            <li key={e.id}>
              <EventLine e={e} start={start} select={select} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="why-none">The trace holds no event about it.</p>
      )}
    </div>
  );
}
