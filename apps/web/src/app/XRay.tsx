// The X-ray: the live view of the world (PLAN.md §6.5), docked beside the terminal or floating over
// the workspace. The worker sends view models while it is open; the canvas diffs and animates
// them. A filter by scope, a selection whose facts and relations read on a card over the drawing,
// and the zoom controls. Opening it is help, and the worker records it as a lab event.
//
// Floating (docs/DESIGN.md §7): moved by its header, resized from its edges and corners, by
// pointer and by keyboard, always wholly inside the workspace (floating.ts). Nothing here takes
// focus from the terminal unless the drawing or a control is used with the keyboard.
//
// At assist level full (docs/LEARNING_MODEL.md §13) it also explains: "Why?" on the selection asks
// the worker for the causal chain of its state, and the timeline shows the trace over virtual time;
// selecting a mark or dragging the playhead reads a past moment, rebuilt by replay and shown
// read-only until the learner returns to now. At level view it shows the world and says why it
// explains nothing; at level off there is no X-ray (App.tsx).
//
// Like the renderer it names no domain: kind names, scope names and the words of states come from
// the view model, and the words of events from the trace.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { RelationType, ViewEvent, ViewModel, ViewState, Why } from '@simlab/kernel';
import type { Assist } from '@simlab/learn';
import { Glyph, ViewCanvas, type CanvasHandle } from '../view/ViewCanvas.tsx';
import { scopeKind, scopes, type ScopeFilter } from '../view/filter.ts';
import { clampRect, defaultFloat, EDGES, FLOAT_STEP, moveRect, resizeRect, type Edge, type Rect, type Size } from './floating.ts';
import { itemKey, markText, Timeline } from './Timeline.tsx';
import { formatOffset, timelineItems, type TimelineItem, type TraceState } from './timeline.ts';
import { EventLine, SimTag, WhyChain } from './Trace.tsx';
import { Button, Icon, Select } from './ui.tsx';

export type XRayMode = 'docked' | 'floating';

export interface XRayProps {
  model?: ViewModel;
  reducedMotion: boolean;
  mode: XRayMode;
  setMode(mode: XRayMode): void;
  /** Where it floats, as last left; undefined until it has floated once. */
  rect?: Rect;
  setRect(rect: Rect): void;
  close(): void;
  /** After a drag: focus goes back where typing goes. */
  done(): void;
  /** The attempt's assist level: `full` adds "Why?" and the timeline. */
  assist: Assist;
  /** The trace as the worker sent it (level full); undefined until it arrives. */
  trace?: TraceState | undefined;
  /** Virtual time now. */
  now?: number | undefined;
  /** The moment the learner reads, when it is a past one; and its view once the worker has rebuilt it. */
  at?: number | undefined;
  past?: { t: number; model: ViewModel } | undefined;
  /** Reads a past moment, or returns to now (undefined). */
  scrub(t: number | undefined): void;
  /** Asks why an entity is in its state (level full). */
  why(entity: string): Promise<Why | undefined>;
}

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * The floating panel's place: the stored rectangle fitted into the box it floats in (its offset
 * parent), again whenever that box changes size. A drag moves the element directly and stores
 * the result when the pointer is released.
 */
function useFloat(floating: boolean, stored: Rect | undefined, store: (r: Rect) => void, done: () => void) {
  const el = useRef<HTMLElement>(null);
  const [bounds, setBounds] = useState<Size>();
  useLayoutEffect(() => {
    const parent = floating ? (el.current?.offsetParent as HTMLElement | null) : null;
    if (!parent) {
      setBounds(undefined);
      return undefined;
    }
    const measure = (): void => setBounds((b) => (b && b.w === parent.clientWidth && b.h === parent.clientHeight ? b : { w: parent.clientWidth, h: parent.clientHeight }));
    measure();
    const o = new ResizeObserver(measure);
    o.observe(parent);
    return () => o.disconnect();
  }, [floating]);
  const rect = useMemo(() => (bounds ? clampRect(stored ?? defaultFloat(bounds), bounds) : undefined), [bounds, stored]);
  const live = useRef({ rect, bounds });
  live.current = { rect, bounds };

  /** The rectangle under the pointer during a drag: a render in between must not put the old one back. */
  const dragging = useRef<Rect | undefined>(undefined);
  useLayoutEffect(() => {
    if (dragging.current) place(dragging.current);
  });
  const place = (r: Rect): void => {
    const s = el.current?.style;
    if (!s) return;
    s.left = `${r.x}px`;
    s.top = `${r.y}px`;
    s.width = `${r.w}px`;
    s.height = `${r.h}px`;
  };
  /** Follows the pointer from a press on the header (`edge` undefined) or on a resize handle. */
  const drag = useCallback(
    (e: ReactPointerEvent<HTMLElement>, edge?: Edge): void => {
      const { rect: from, bounds: box } = live.current;
      if (!from || !box || e.button !== 0) return;
      e.preventDefault();
      const x0 = e.clientX;
      const y0 = e.clientY;
      let to = from;
      const move = (ev: PointerEvent): void => {
        to = edge ? resizeRect(from, edge, ev.clientX - x0, ev.clientY - y0, box) : moveRect(from, ev.clientX - x0, ev.clientY - y0, box);
        dragging.current = to;
        place(to);
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        dragging.current = undefined;
        document.body.classList.remove('is-floating-drag');
        document.body.style.removeProperty('--drag-cursor');
        if (to !== from) store(to);
        done();
      };
      document.body.classList.add('is-floating-drag');
      document.body.style.setProperty('--drag-cursor', edge ? `${edge}-resize` : 'grabbing');
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [store, done],
  );
  /** Arrow keys on the move handle: move, or with Shift resize by the bottom right corner. */
  const nudge = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>): void => {
      const d = ARROWS[e.key];
      const { rect: from, bounds: box } = live.current;
      if (!d || !from || !box) return;
      e.preventDefault();
      e.stopPropagation();
      const [dx, dy] = [d[0] * FLOAT_STEP, d[1] * FLOAT_STEP];
      store(e.shiftKey ? resizeRect(from, 'se', dx, dy, box) : moveRect(from, dx, dy, box));
    },
    [store],
  );
  return { el, rect, drag, nudge };
}

/** How a relation reads from each end. */
const RELATION_WORDS: Record<RelationType, [string, string]> = {
  owns: ['Owns', 'Owned by'],
  selects: ['Selects', 'Selected by'],
  routesTo: ['Routes to', 'Receives from'],
  runsOn: ['Runs on', 'Runs'],
  mounts: ['Mounts', 'Mounted by'],
  uses: ['Uses', 'Used by'],
};

const STATES: ViewState[] = ['healthy', 'progressing', 'degraded', 'failed', 'unknown'];

const filterValue = (f: ScopeFilter): string => (typeof f === 'string' ? f : `scope:${f.scope}`);
const parseFilter = (v: string): ScopeFilter => (v === 'all' || v === 'mine' ? v : { scope: v.slice('scope:'.length) });

/** "Why?" on the selection: asks when opened and again whenever the selection changes while it is open. */
function useWhy(open: boolean, entity: string | undefined, ask: (entity: string) => Promise<Why | undefined>) {
  const [answer, setAnswer] = useState<{ entity: string; why: Why | undefined }>();
  const asked = useRef(0);
  useEffect(() => {
    if (!open || entity === undefined) return;
    const n = ++asked.current;
    void ask(entity).then((why) => {
      if (n === asked.current) setAnswer({ entity, why });
    });
  }, [open, entity, ask]);
  return answer !== undefined && answer.entity === entity ? answer : undefined;
}

/** Memoized: the workspace renders on every message of the worker, the X-ray only when its props change. */
export const XRay = memo(function XRay({ model: live, reducedMotion, mode, setMode, rect: stored, setRect, close, done, assist, trace, now, at, past, scrub, why: askWhy }: XRayProps) {
  const floating = mode === 'floating';
  const float = useFloat(floating, stored, setRect, done);
  const full = assist === 'full';
  /** The drawing shows the past moment once the worker has rebuilt it, the world now otherwise. */
  const model = at !== undefined && past ? past.model : live;
  const inPast = at !== undefined;

  const [filter, setFilter] = useState<ScopeFilter>('mine');
  const [selected, setSelectedRaw] = useState<string>();
  /** The timeline item open on the card instead of an entity's facts. */
  const [eventKey, setEventKey] = useState<string>();
  const [whyOpen, setWhyOpen] = useState(false);
  const setSelected = useCallback((id: string | undefined) => {
    setSelectedRaw(id);
    if (id !== undefined) setEventKey(undefined);
  }, []);
  const canvas = useRef<CanvasHandle | undefined>(undefined);
  const scopeList = useMemo(() => (model ? scopes(model) : []), [model]);
  const scopeName = model ? scopeKind(model) : undefined;
  const byId = useMemo(() => new Map((model?.entities ?? []).map((e) => [e.id, e])), [model]);
  const kinds = useMemo(() => new Map((model?.kinds ?? []).map((k) => [k.kind, k])), [model]);
  const entity = selected === undefined ? undefined : byId.get(selected);
  const rels = useMemo(() => {
    if (!model || selected === undefined) return [];
    const out: { word: string; id: string }[] = [];
    for (const r of model.relations) {
      if (r.from === selected) out.push({ word: RELATION_WORDS[r.type][0], id: r.to });
      else if (r.to === selected) out.push({ word: RELATION_WORDS[r.type][1], id: r.from });
    }
    return out;
  }, [model, selected]);
  const groups = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of rels) m.set(r.word, [...(m.get(r.word) ?? []), r.id]);
    return [...m];
  }, [rels]);
  const container = entity?.container === undefined ? undefined : byId.get(entity.container);

  const items = useMemo(() => (trace ? timelineItems(trace, true) : []), [trace]);
  const item = eventKey === undefined ? undefined : items.find((i) => itemKey(i) === eventKey);
  const eventsById = useMemo(() => new Map((trace?.events ?? []).map((e) => [e.id, e])), [trace]);
  const event = item?.kind === 'event' ? item.event : undefined;
  /** Selecting a mark reads the world at its moment; the newest moment is now. */
  const selectItem = useCallback(
    (i: TimelineItem | undefined) => {
      setEventKey(i === undefined ? undefined : itemKey(i));
      if (i === undefined) return;
      setSelectedRaw(undefined);
      scrub(now !== undefined && i.t >= now ? undefined : i.t);
    },
    [scrub, now],
  );
  const selectEvent = (e: ViewEvent): void => selectItem({ kind: 'event', t: e.t, event: e });
  const answer = useWhy(full && whyOpen && !inPast, entity?.id, askWhy);
  // Stable props for the memoized drawing: it redraws only when what it shows changed.
  const highlightKey = event ? event.about.filter((id) => byId.has(id)).join('\u0000') : '';
  const marks = useMemo(() => (highlightKey === '' ? undefined : { highlight: highlightKey.split('\u0000') }), [highlightKey]);
  const linkKey = event?.link && byId.has(event.link.from) && byId.has(event.link.to) ? `${event.link.from}\u0000${event.link.to}` : '';
  const links = useMemo(() => (linkKey === '' ? undefined : [{ from: linkKey.split('\u0000')[0] as string, to: linkKey.split('\u0000')[1] as string }]), [linkKey]);
  const setHandle = useCallback((h: CanvasHandle) => {
    canvas.current = h;
  }, []);
  const nameOf = (id: string): string => {
    const e = byId.get(id);
    return e ? `${kinds.get(e.kind)?.label ?? ''} ${e.label}`.trim() : id;
  };

  const style = floating && float.rect ? { left: float.rect.x, top: float.rect.y, width: float.rect.w, height: float.rect.h } : undefined;
  return (
    <section ref={float.el} className={`xray pane${floating ? ' is-floating' : ' is-docked'}`} style={style} aria-label="X-ray: the simulated world" data-mode={mode}>
      <header
        className="xray-head"
        // Dragging the header moves a floating X-ray; its controls keep their own clicks.
        onMouseDown={(e) => {
          if (floating && !(e.target as HTMLElement).closest('button, .select')) e.preventDefault();
        }}
        onPointerDown={(e) => {
          if (floating && !(e.target as HTMLElement).closest('button, .select')) float.drag(e);
        }}
      >
        <div className="xray-title">
          {floating ? (
            <button type="button" className="xray-grip" aria-label="Move the X-ray" title="Drag to move. With the keyboard (Ctrl+Shift+G): arrow keys move, Shift+arrow keys resize, Escape returns to the terminal" onMouseDown={(e) => e.preventDefault()} onPointerDown={(e) => float.drag(e)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  done();
                } else float.nudge(e);
              }}
            >
              <Icon name="grip" size={16} />
            </button>
          ) : (
            <Icon name="xray" size={16} />
          )}
          <h2>X-ray</h2>
          <span className="xray-note" title="The X-ray is help: opening it is recorded with the attempt.">counts as help</span>
        </div>
        <div className="xray-tools">
          {scopeName ? (
            <Select
              className="xray-filter"
              label={`Filter by ${scopeName.label}`}
              value={filterValue(filter)}
              onChange={(v) => setFilter(parseFilter(v))}
              options={[{ value: 'mine', label: `All ${scopeName.plural.toLowerCase()} but the system’s` }, { value: 'all', label: `All ${scopeName.plural.toLowerCase()}` }, ...scopeList.map((s) => ({ value: `scope:${s.id}`, label: s.label }))]}
            />
          ) : null}
          <Button variant="ghost" small title="Zoom out (−)" aria-label="Zoom out" onClick={() => canvas.current?.zoom(1 / 1.2)}>
            <Icon name="minus" size={14} />
          </Button>
          <Button variant="ghost" small title="Zoom in (+)" aria-label="Zoom in" onClick={() => canvas.current?.zoom(1.2)}>
            <Icon name="plus" size={14} />
          </Button>
          <Button variant="ghost" small title="Fit everything (0)" aria-label="Fit everything" onClick={() => canvas.current?.fitAll()}>
            <Icon name="fit" size={14} />
          </Button>
          <Button variant="ghost" small title={floating ? 'Dock the X-ray beside the terminal' : 'Float the X-ray over the workspace'} aria-label={floating ? 'Dock the X-ray' : 'Float the X-ray'} onClick={() => setMode(floating ? 'docked' : 'floating')}>
            <Icon name={floating ? 'dock' : 'float'} size={14} />
          </Button>
          <Button variant="ghost" small title="Close the X-ray (Ctrl+Shift+Y)" aria-label="Close the X-ray" onClick={close}>
            <Icon name="close" size={14} />
          </Button>
        </div>
      </header>
      <div className={`xray-body${inPast ? ' is-past' : ''}`}>
        {inPast ? (
          <div className="xray-past" role="status">
            <Icon name="history" size={14} />
            <span>
              <strong>{trace ? formatOffset(at - trace.start) : 'A past moment'}</strong>
              {past && past.t === at ? ', read-only' : ', rebuilding it…'}
              <span className="xray-past-more">: the terminal and the world go on</span>
            </span>
            <Button variant="ghost" small className="xray-past-now" title="Show the world now (End on the timeline)" onClick={() => scrub(undefined)}>
              Back to now
            </Button>
          </div>
        ) : null}
        {model ? (
          <ViewCanvas
            model={model}
            filter={filter}
            {...(selected !== undefined && byId.has(selected) ? { selected } : {})}
            onSelect={setSelected}
            reducedMotion={reducedMotion}
            {...(marks ? { marks } : {})}
            {...(links ? { links, linksKey: eventKey ?? '' } : {})}
            handle={setHandle}
            label="The simulated world: select an entity with the arrow keys or Tab, Enter to read its facts"
          />
        ) : (
          <div className="xray-empty">Reading the world…</div>
        )}
        {item && trace ? (
          <div className="xray-detail xray-event" aria-live="polite">
            <div className="xray-detail-head">
              <span className="xray-kind">{item.kind === 'mark' ? 'You' : event?.input ? 'Command' : 'Event'}</span>
              <SimTag />
              <Button variant="ghost" small className="xray-focus" title="Close it" aria-label="Close the event" onClick={() => setEventKey(undefined)}>
                <Icon name="close" size={12} />
              </Button>
            </div>
            {event ? (
              <EventLine e={event} start={trace.start} select={setSelected}>
                {event.about.length > 0 ? (
                  <p className="trace-about">
                    <span>About</span>
                    {event.about.map((id, i) => (
                      <span key={id}>
                        {i > 0 ? ', ' : ''}
                        {byId.has(id) ? (
                          <button type="button" className="linklike" onClick={() => setSelected(id)}>
                            {nameOf(id)}
                          </button>
                        ) : (
                          <span className="trace-gone" title="Not in this drawing: gone at this moment, or hidden by the filter">
                            {id.split('/').pop()}
                          </span>
                        )}
                      </span>
                    ))}
                  </p>
                ) : null}
                {event.causes.length > 0 ? (
                  <div className="trace-causes">
                    <span className="trace-causes-title">Follows from</span>
                    <ul>
                      {event.causes.map((c) => {
                        const ce = eventsById.get(c);
                        return ce ? (
                          <li key={c}>
                            <button type="button" className="linklike" onClick={() => selectEvent(ce)}>
                              {formatOffset(ce.t - trace.start)} {ce.actor}: {ce.text}
                            </button>
                          </li>
                        ) : null;
                      })}
                    </ul>
                  </div>
                ) : null}
              </EventLine>
            ) : item.kind === 'mark' ? (
              <p className="trace-text">
                {formatOffset(item.t - trace.start)} {markText(item)}
              </p>
            ) : null}
          </div>
        ) : entity ? (
          <div className={`xray-detail${whyOpen && full ? ' has-why' : ''}`} aria-live="polite">
            <div className="xray-detail-head">
              <span className={`state-chip state-${entity.state}`}>{entity.status ?? entity.state}</span>
              <strong>{entity.label}</strong>
              <span className="xray-kind">{kinds.get(entity.kind)?.label}</span>
              {full ? (
                <Button variant="ghost" small className={`xray-focus xray-why${whyOpen ? ' is-on' : ''}`} title={inPast ? 'Why? explains the world now: go back to now to ask' : 'Why is it in this state? From the trace (asking is recorded with the attempt)'} aria-pressed={whyOpen} disabled={inPast} onClick={() => setWhyOpen((v) => !v)}>
                  <Icon name="why" size={14} />
                  Why?
                </Button>
              ) : null}
              <Button variant="ghost" small className={full ? undefined : 'xray-focus'} title="Zoom to it (F)" aria-label="Zoom to it" onClick={() => canvas.current?.focusSelected()}>
                <Icon name="fit" size={14} />
              </Button>
              <Button variant="ghost" small title="Clear the selection (Escape)" aria-label="Clear the selection" onClick={() => setSelected(undefined)}>
                <Icon name="close" size={12} />
              </Button>
            </div>
            <dl className="xray-facts">
              {container ? (
                <>
                  <dt>In</dt>
                  <dd>
                    <button type="button" className="linklike" onClick={() => setSelected(container.id)}>
                      {kinds.get(container.kind)?.label} {container.label}
                    </button>
                  </dd>
                </>
              ) : null}
              {entity.facts.map((f) => (
                <FactRow key={f.label} label={f.label} value={f.value} />
              ))}
              {groups.map(([word, ids]) => (
                <FactRow key={word} label={word}>
                  {ids.map((id, i) => {
                    const e = byId.get(id);
                    return (
                      <span key={id}>
                        {i > 0 ? ', ' : ''}
                        <button type="button" className="linklike" onClick={() => setSelected(id)}>
                          {e ? `${kinds.get(e.kind)?.label ?? ''} ${e.label}` : id}
                        </button>
                      </span>
                    );
                  })}
                </FactRow>
              ))}
            </dl>
            {full && whyOpen && !inPast ? (
              answer === undefined ? (
                <p className="why-wait">Reading the trace…</p>
              ) : answer.why ? (
                <WhyChain
                  why={answer.why}
                  start={trace?.start}
                  select={setSelected}
                  heading={
                    <div className="why-head">
                      <span className="why-title">Why</span>
                      <SimTag />
                      <span className="xray-note">recorded as help</span>
                    </div>
                  }
                />
              ) : (
                <div className="why">
                  <div className="why-head">
                    <span className="why-title">Why</span>
                    <SimTag />
                  </div>
                  <p className="why-none">Nothing recorded about this.</p>
                </div>
              )
            ) : null}
          </div>
        ) : null}
      </div>
      {full && trace && now !== undefined ? <Timeline trace={trace} now={now} at={at} selected={eventKey} scrub={scrub} select={selectItem} /> : null}
      <footer className="xray-foot">
        {assist === 'view' ? <p className="xray-level">Assist level View: the X-ray shows the world as it is, without Why? or the timeline.</p> : null}
        <ul className="xray-legend" aria-label="States">
          {STATES.map((s) => (
            <li key={s} className={`state-${s}`}>
              <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true">
                <Glyph state={s} x={0} y={0} />
              </svg>
              {s}
            </li>
          ))}
        </ul>
      </footer>
      {/* Pointer handles on every edge and corner; the keyboard resizes from the move handle. */}
      {floating ? EDGES.map((edge) => <div key={edge} className={`xray-resize xray-resize-${edge}`} aria-hidden="true" onMouseDown={(e) => e.preventDefault()} onPointerDown={(e) => float.drag(e, edge)} />) : null}
    </section>
  );
});

function FactRow({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children ?? <code>{value}</code>}</dd>
    </>
  );
}
