// The X-ray's timeline (PLAN.md §6.5, docs/DESIGN.md §7): what happened over virtual time, from the
// attempt's start to now. The top row is the learner's (commands, checks, hints), the next what the
// system did (events of level key), and on request a quiet row of bookkeeping (level detail).
// Hovering names a mark; selecting one opens it on the X-ray and reads the world at that moment.
// The playhead is a slider: dragging it or moving it with the keyboard asks for the view of a past
// moment, which is rebuilt by replay and read-only (not time travel: the session goes on).
//
// Geometry, clusters and steps are pure (timeline.ts). Like the renderer it names no domain.

import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { cluster, formatOffset, hit, itemAt, scaleOf, stepTime, ticks, timelineItems, tOf, xOf, type Cluster, type Lane, type TimelineItem, type TraceState } from './timeline.ts';
import { SimTag } from './Trace.tsx';

/** A stable key for an item: an event's id, a lab action's time and kind. */
export const itemKey = (i: TimelineItem): string => (i.kind === 'event' ? `e${i.event.id}` : `m${i.t}:${i.mark.action}`);

const MARK_WORDS: Record<string, string> = { hint: 'You took a hint', solution: 'You opened the solutions', debrief: 'You opened the debrief' };

/** What a lab action of the learner was, in words. */
export function markText(i: Extract<TimelineItem, { kind: 'mark' }>): string {
  if (i.mark.action === 'check') return i.mark.passed ? 'You ran the check: every check passed' : 'You ran the check: not every check passed';
  return MARK_WORDS[i.mark.action] ?? i.mark.action;
}

/** One line for an item: who and what. */
export function itemLine(i: TimelineItem): { actor: string; text: string; input: boolean } {
  if (i.kind === 'mark') return { actor: 'you', text: markText(i), input: false };
  return { actor: i.event.actor, text: i.event.text, input: i.event.input === true };
}

const PAD_L = 52;
const PAD_R = 14;
const ROW: Record<Lane, number> = { input: 12, key: 30, detail: 44 };
const LANE_LABEL: Record<Lane, string> = { input: 'You', key: 'System', detail: 'Detail' };

export interface TimelineProps {
  trace: TraceState;
  /** Virtual time now. */
  now: number;
  /** The moment read, when it is a past one; undefined: now. */
  at?: number | undefined;
  /** The key of the selected item. */
  selected?: string | undefined;
  /** Moves the playhead: a past moment, or undefined for now. */
  scrub(t: number | undefined): void;
  /** Selects an item (and the moment it happened), or clears the selection. */
  select(i: TimelineItem | undefined): void;
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const o = new ResizeObserver(() => setW(el.clientWidth));
    o.observe(el);
    setW(el.clientWidth);
    return () => o.disconnect();
  }, []);
  return [ref, w];
}

function Marker({ c, selected, hovered, xAt }: { c: Cluster; selected: boolean; hovered: boolean; xAt(t: number): number }) {
  const y = ROW[c.lane];
  const many = c.items.length > 1;
  const ring = selected || hovered ? <circle className={`tl-ring${selected ? ' is-selected' : ''}`} cx={c.x} cy={y} r={many ? 8 : 7} /> : null;
  if (c.lane === 'detail') return <rect className={`tl-detail tone-${c.tone}`} x={c.x - 0.75} y={y - 3} width={1.5} height={6} />;
  if (c.lane === 'input') {
    const first = c.items[0] as TimelineItem;
    if (first.kind === 'mark' && !many) {
      // A lab action: a diamond.
      return (
        <g className={`tl-mark tone-${c.tone}`}>
          {ring}
          <path d={`M ${c.x} ${y - 5} L ${c.x + 5} ${y} L ${c.x} ${y + 5} L ${c.x - 5} ${y} Z`} />
        </g>
      );
    }
    // A command: a square, with a bar for the time it ran.
    const until = first.kind === 'event' && first.event.until !== undefined && !many ? first.event.until : undefined;
    return (
      <g className={`tl-input tone-${c.tone}${many ? ' is-many' : ''}`}>
        {ring}
        <rect x={c.x - 4} y={y - 4} width={8} height={8} rx={2} />
        {until !== undefined && xAt(until) > c.x + 5 ? <line className="tl-ran" x1={c.x + 4} x2={xAt(until)} y1={y} y2={y} /> : null}
      </g>
    );
  }
  return (
    <g className={`tl-event tone-${c.tone}${many ? ' is-many' : ''}`}>
      {ring}
      <circle cx={c.x} cy={y} r={many ? 5 : 4} />
    </g>
  );
}

export function Timeline({ trace, now, at, selected, scrub, select }: TimelineProps) {
  const [detail, setDetail] = useState(false);
  const [hoverKey, setHoverKey] = useState<string>();
  const [wrap, width] = useWidth();
  const items = useMemo(() => timelineItems(trace, detail), [trace, detail]);
  const s = useMemo(() => scaleOf(trace.start, now, width, 0), [trace.start, now, width]);
  const inner = useMemo(() => ({ ...s, x0: PAD_L, x1: Math.max(PAD_L + 1, width - PAD_R) }), [s, width]);
  const clusters = useMemo(() => cluster(items, inner), [items, inner]);
  const clusterKey = (c: Cluster): string => `${c.lane}:${c.t0}`;
  const hover = hoverKey === undefined ? undefined : clusters.find((c) => clusterKey(c) === hoverKey);
  const marks = useMemo(() => ticks(inner, 80), [inner]);
  const byKey = useMemo(() => new Map(items.map((i) => [itemKey(i), i])), [items]);
  const sel = selected === undefined ? undefined : byKey.get(selected);
  const head = at === undefined ? now : at;
  const headX = xOf(inner, head);
  const height = detail ? 66 : 52;
  const axisY = detail ? 54 : 40;

  /** What the readout names: the hovered mark, else the selection, else the newest thing at the playhead. */
  const shown: { items: TimelineItem[]; why: 'hover' | 'selected' | 'at' } | undefined = hover
    ? { items: hover.items, why: 'hover' }
    : sel
      ? { items: [sel], why: 'selected' }
      : at !== undefined
        ? (() => {
            const i = itemAt(items, at);
            return i ? { items: [i], why: 'at' as const } : undefined;
          })()
        : undefined;

  const laneAt = (y: number): Lane | undefined => (y < (ROW.input + ROW.key) / 2 ? 'input' : y < (ROW.key + ROW.detail) / 2 || !detail ? 'key' : 'detail');
  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = wrap.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const goTo = (t: number | undefined): void => {
    // The right end is now: reading it is reading the live world.
    scrub(t === undefined || t >= now ? undefined : t);
  };
  const choose = (c: Cluster): void => {
    const i = c.items[c.items.length - 1] as TimelineItem;
    select(i);
  };

  const dragging = useRef(false);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = local(e);
    const c = hit(clusters, p.x, laneAt(p.y));
    if (c) {
      choose(c);
      return;
    }
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    select(undefined);
    goTo(p.x >= inner.x1 - 1 ? undefined : tOf(inner, p.x));
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const p = local(e);
    if (dragging.current) {
      goTo(p.x >= inner.x1 - 1 ? undefined : tOf(inner, p.x));
      return;
    }
    const c = hit(clusters, p.x, laneAt(p.y));
    setHoverKey(c ? clusterKey(c) : undefined);
  };
  const onPointerUp = (): void => {
    dragging.current = false;
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const span = inner.end - inner.start;
    let handled = true;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      if (e.shiftKey) {
        select(undefined);
        goTo(Math.round(Math.min(now, Math.max(inner.start, head + (dir * span) / 20))));
      } else {
        const t = stepTime(items, at, dir);
        const i = t === undefined ? undefined : [...items].reverse().find((x) => x.t === t);
        if (i) select(i);
        else {
          select(undefined);
          goTo(undefined);
        }
      }
    } else if (e.key === 'Home') {
      select(undefined);
      goTo(inner.start);
    } else if (e.key === 'End' || (e.key === 'Escape' && (at !== undefined || sel !== undefined))) {
      select(undefined);
      goTo(undefined);
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const readout = shown ? itemLine(shown.items[shown.items.length - 1] as TimelineItem) : undefined;
  const readoutAt = shown ? (shown.items[shown.items.length - 1] as TimelineItem).t : undefined;
  const live = at === undefined;
  return (
    <div className="timeline" aria-label="Timeline">
      <div className="timeline-head">
        <span className="timeline-title">Timeline</span>
        <SimTag />
        <span className="timeline-span">
          {formatOffset(now - trace.start)}
          {live ? ' · now' : ''}
        </span>
        <div className="segmented timeline-density" role="radiogroup" aria-label="What the timeline shows">
          {(
            [
              [false, 'Key', 'What changed what you can see, or decided something'],
              [true, 'All', 'Also the bookkeeping around it'],
            ] as const
          ).map(([v, label, title]) => (
            <button key={label} type="button" role="radio" aria-checked={detail === v} title={title} className={detail === v ? 'is-on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => setDetail(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={wrap}
        className={`timeline-track${live ? '' : ' is-past'}`}
        role="slider"
        tabIndex={0}
        aria-label="The moment the X-ray shows: arrow keys go from mark to mark, Shift+arrows move freely, End returns to now"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, now - trace.start)}
        aria-valuenow={Math.max(0, head - trace.start)}
        aria-valuetext={live ? `now, ${formatOffset(now - trace.start)}` : `${formatOffset(head - trace.start)}, a past moment`}
        style={{ height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHoverKey(undefined)}
        onKeyDown={onKeyDown}
      >
        <svg width={width} height={height} aria-hidden="true">
          {(['input', 'key', ...(detail ? (['detail'] as const) : [])] as Lane[]).map((l) => (
            <g key={l}>
              <text className="tl-lane" x={6} y={ROW[l] + 3.5}>
                {LANE_LABEL[l]}
              </text>
              <line className="tl-row" x1={inner.x0} x2={inner.x1} y1={ROW[l]} y2={ROW[l]} />
            </g>
          ))}
          <line className="tl-axis" x1={inner.x0} x2={inner.x1} y1={axisY} y2={axisY} />
          {marks.map((m) => (
            <g key={m.t}>
              <line className="tl-tick" x1={m.x} x2={m.x} y1={axisY} y2={axisY + 3} />
              <text className="tl-tick-label" x={m.x} y={axisY + 11} textAnchor="middle">
                {m.label}
              </text>
            </g>
          ))}
          <g className="tl-marks">
            {clusters.map((c) => (
              <g key={clusterKey(c)} className={!live && c.t0 > head ? 'is-after' : undefined}>
                <Marker c={c} selected={sel !== undefined && c.items.includes(sel)} hovered={hover === c} xAt={(t) => xOf(inner, t)} />
              </g>
            ))}
          </g>
          <g className={`tl-head${live ? ' is-live' : ''}`}>
            <line x1={headX} x2={headX} y1={2} y2={axisY} />
            {live ? null : <circle cx={headX} cy={axisY} r={4} />}
          </g>
        </svg>
      </div>
      <p className="timeline-readout" aria-live="polite">
        {readout ? (
          <>
            <span className="trace-when">{formatOffset((readoutAt as number) - trace.start)}</span>
            <span className="trace-actor">{readout.actor}</span>
            {readout.input ? <code className="trace-input">{readout.text}</code> : <span className="timeline-text">{readout.text}</span>}
            {shown && shown.items.length > 1 ? <span className="timeline-more">and {shown.items.length - 1} more</span> : null}
          </>
        ) : (
          <span className="timeline-hint">{items.length === 0 ? 'Nothing recorded yet. Commands you run and what the system does appear here.' : 'Select a mark to read it and the world at that moment; drag to read any moment.'}</span>
        )}
      </p>
    </div>
  );
}
