// The replay of a run in the debrief (PLAN.md §5 "Feedback that explains", §6.5 surface 3): the
// world at the start with why each broken thing is broken, the moment each change landed with the
// commands as they were typed, and how the world went on by itself, each at the virtual time it
// happened. Stepped like a scene (Figure.tsx): previous, next, replay, one dot per frame. The
// changes since the frame before are marked as in a comparison, and the causes that travelled
// between two drawn entities move along their pair once. Then every command of the run, also the
// ones that changed nothing, with what the trace says of how each ended.
//
// It reads frames, panels and events from the replay and names no domain.

import { useEffect, useMemo, useState } from 'react';
import type { ViewEvent, Why } from '@simlab/kernel';
import type { Panel, Replay, ReplayFrame } from '@simlab/learn';
import { ViewCanvas, type CanvasMarks } from '../view/ViewCanvas.tsx';
import { FRAME_MS } from './Figure.tsx';
import { formatOffset } from './timeline.ts';
import { EventItems, EventLine, SimTag, ToneMark, When, WhyChain } from './Trace.tsx';
import { Button, Icon } from './ui.tsx';

const KIND_WORD: Record<ReplayFrame['kind'], string> = { start: 'At the start', change: 'Your change landed', settled: 'The world went on' };
/** More dots than this would not fit a narrow panel: the count says it alone. */
const MAX_DOTS = 24;
/** Events of a frame shown before "Show all". */
const FIRST_EVENTS = 6;

function marksOf(p: Panel): CanvasMarks {
  const notes: Record<string, number[]> = {};
  for (const n of p.notes) for (const id of n.on) notes[id] = [...(notes[id] ?? []), n.n];
  return { highlight: p.highlight, notes, changes: p.changes };
}

/** What the marks of a replayed frame mean: each frame is compared with the one before it. */
function ChangeLegend({ panel }: { panel: Panel }) {
  const kinds = new Set(Object.values(panel.changes));
  if (kinds.size === 0 && !(panel.links && panel.links.length > 0)) return null;
  return (
    <p className="figure-legend">
      {kinds.has('added') ? (
        <span>
          <span className="figure-change is-added">+</span> new since the frame before
        </span>
      ) : null}
      {kinds.has('changed') ? (
        <span>
          <span className="figure-change is-changed">•</span> changed
        </span>
      ) : null}
      {panel.links && panel.links.length > 0 ? (
        <span>
          <span className="replay-cause-key" aria-hidden="true" /> a cause the trace recorded
        </span>
      ) : null}
    </p>
  );
}

/** A frame's events, the first few and the rest on request. */
function Events({ events, start }: { events: readonly ViewEvent[]; start: number }) {
  const [all, setAll] = useState(false);
  if (events.length === 0) return <p className="replay-none">Nothing the drawing shows was recorded between these moments.</p>;
  const shown = all ? events : events.slice(0, FIRST_EVENTS);
  return (
    <>
      <ol className="replay-events">
        {shown.map((e) => (
          <li key={e.id}>
            <EventLine e={e} start={start} />
          </li>
        ))}
      </ol>
      {events.length > shown.length ? (
        <Button variant="ghost" small onClick={() => setAll(true)}>
          Show all {events.length}
        </Button>
      ) : null}
    </>
  );
}

function Causes({ causes, frame, start }: { causes: readonly Why[]; frame: ReplayFrame; start: number }) {
  if (causes.length === 0) return <p className="replay-none">Nothing in the drawing was broken when the run started.</p>;
  const title = (id: string): string => {
    const e = frame.panel.model.entities.find((x) => x.id === id);
    const k = e ? frame.panel.model.kinds.find((x) => x.kind === e.kind) : undefined;
    return e ? `Why ${k?.label ?? ''} ${e.label} is ${e.state}`.replace(/\s+/g, ' ') : `Why ${id.split('/').pop() ?? id} is so`;
  };
  return (
    <ul className="replay-causes">
      {causes.map((w) => (
        <li key={w.entity}>
          <WhyChain why={w} start={start} heading={<h4 className="replay-cause-title">{title(w.entity)}</h4>} />
        </li>
      ))}
    </ul>
  );
}

/** One run, stepped frame by frame. */
export function ReplayStepper({ replay, title, reducedMotion }: { replay: Replay; title: string; reducedMotion: boolean }) {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const n = replay.frames.length;
  const frame = replay.frames[Math.min(i, n - 1)];
  const marks = useMemo(() => (frame ? marksOf(frame.panel) : undefined), [frame]);
  useEffect(() => {
    if (!playing) return;
    if (i >= n - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setI((x) => x + 1), FRAME_MS);
    return () => clearTimeout(t);
  }, [playing, i, n]);
  // Reduced motion: nothing plays by itself (docs/DESIGN.md §4).
  useEffect(() => {
    if (reducedMotion) setPlaying(false);
  }, [reducedMotion]);
  if (!frame) return null;
  const go = (to: number): void => {
    setPlaying(false);
    setI(Math.max(0, Math.min(n - 1, to)));
  };
  const at = formatOffset(frame.t - replay.start);
  return (
    <figure className="replay" aria-label={title}>
      <figcaption className="figure-caption">
        <span>
          {title}
          <span className="replay-span">
            {n} {n === 1 ? 'frame' : 'frames'}, {formatOffset(0)} to {formatOffset(replay.end - replay.start)}
          </span>
        </span>
      </figcaption>
      <div className="figure-panel">
        <ViewCanvas
          model={frame.panel.model}
          filter="all"
          still
          {...(marks ? { marks } : {})}
          {...(frame.panel.links ? { links: frame.panel.links, linksKey: i } : {})}
          reducedMotion={reducedMotion}
          label={`Frame ${i + 1} of ${n}, ${at}: ${KIND_WORD[frame.kind]}. ${title}`}
        />
      </div>
      <ChangeLegend panel={frame.panel} />
      <div className="scene-bar">
        <Button small variant="ghost" title="Previous frame" aria-label="Previous frame" disabled={i === 0} onClick={() => go(i - 1)}>
          <Icon name="prev" />
        </Button>
        <span className="scene-count" aria-hidden="true">
          {i + 1} / {n}
        </span>
        <Button small variant="ghost" title="Next frame" aria-label="Next frame" disabled={i === n - 1} onClick={() => go(i + 1)}>
          <Icon name="next" />
        </Button>
        <Button
          small
          variant="ghost"
          title={reducedMotion ? 'Back to the first frame' : 'Replay from the first frame'}
          aria-label="Replay"
          onClick={() => {
            setI(0);
            setPlaying(!reducedMotion);
          }}
        >
          <Icon name="reset" />
          <span className="label">Replay</span>
        </Button>
        {n <= MAX_DOTS ? (
          <ol className="scene-dots" aria-hidden="true">
            {replay.frames.map((f, k) => (
              <li key={k} className={`${k === i ? 'is-current' : k < i ? 'is-past' : ''} is-${f.kind}`} />
            ))}
          </ol>
        ) : null}
      </div>
      <div className="replay-frame" aria-live="polite">
        <p className="replay-frame-head">
          <span className={`replay-kind is-${frame.kind}`}>{KIND_WORD[frame.kind]}</span>
          <When t={frame.t} start={replay.start} />
          {frame.kind !== 'change' ? <SimTag /> : null}
        </p>
        {frame.kind === 'start' ? <Causes causes={replay.causes} frame={frame} start={replay.start} /> : null}
        {frame.kind === 'change' ? (
          <pre className="replay-labels" aria-label="What was typed">
            <code>{frame.labels.join('\n')}</code>
          </pre>
        ) : null}
        {frame.kind !== 'start' ? <Events key={i} events={frame.events} start={replay.start} /> : null}
      </div>
      {replay.omitted > 0 ? (
        <p className="replay-omitted">
          {replay.omitted} {replay.omitted === 1 ? 'frame' : 'frames'} in the middle of the run {replay.omitted === 1 ? 'is' : 'are'} left out; the first and the last ones are shown.
        </p>
      ) : null}
    </figure>
  );
}

/** Every command of a run, in order, with how each ended as the trace recorded it. */
export function ReplayInputs({ inputs, start, label }: { inputs: readonly ViewEvent[]; start: number; label: string }) {
  if (inputs.length === 0) return <p className="versus-none">No command was run.</p>;
  return (
    <ol className="replay-inputs" aria-label={label}>
      {inputs.map((e) => (
        <li key={e.id} className={`tone-${e.tone}`}>
          <When t={e.t} start={start} until={e.until} />
          <ToneMark tone={e.tone} />
          <code className="trace-input">{e.text}</code>
          {e.items && e.items.length > 0 ? <EventItems items={e.items} /> : null}
        </li>
      ))}
    </ol>
  );
}
