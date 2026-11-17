// The X-ray: the live view of the world (PLAN.md §6.5), docked beside the terminal or floating over
// the workspace. The worker sends view models while it is open; the canvas diffs and animates
// them. A filter by scope, a selection whose facts and relations read on a card over the drawing,
// and the zoom controls. Opening it is help, and the worker records it as a lab event.
//
// Floating (docs/DESIGN.md §7): moved by its header, resized from its edges and corners, by
// pointer and by keyboard, always wholly inside the workspace (floating.ts). Nothing here takes
// focus from the terminal unless the drawing or a control is used with the keyboard.
//
// Like the renderer it names no domain: kind names, scope names and the words of states come from
// the view model.

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { RelationType, ViewModel, ViewState } from '@simlab/kernel';
import { Glyph, ViewCanvas, type CanvasHandle } from '../view/ViewCanvas.tsx';
import { scopeKind, scopes, type ScopeFilter } from '../view/filter.ts';
import { clampRect, defaultFloat, EDGES, FLOAT_STEP, moveRect, resizeRect, type Edge, type Rect, type Size } from './floating.ts';
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

export function XRay({ model, reducedMotion, mode, setMode, rect: stored, setRect, close, done }: XRayProps) {
  const floating = mode === 'floating';
  const float = useFloat(floating, stored, setRect, done);

  const [filter, setFilter] = useState<ScopeFilter>('mine');
  const [selected, setSelected] = useState<string>();
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
      <div className="xray-body">
        {model ? (
          <ViewCanvas
            model={model}
            filter={filter}
            {...(selected !== undefined && byId.has(selected) ? { selected } : {})}
            onSelect={setSelected}
            reducedMotion={reducedMotion}
            handle={(h) => {
              canvas.current = h;
            }}
            label="The simulated world: select an entity with the arrow keys or Tab, Enter to read its facts"
          />
        ) : (
          <div className="xray-empty">Reading the world…</div>
        )}
        {entity ? (
          <div className="xray-detail" aria-live="polite">
            <div className="xray-detail-head">
              <span className={`state-chip state-${entity.state}`}>{entity.status ?? entity.state}</span>
              <strong>{entity.label}</strong>
              <span className="xray-kind">{kinds.get(entity.kind)?.label}</span>
              <Button variant="ghost" small className="xray-focus" title="Zoom to it (F)" onClick={() => canvas.current?.focusSelected()}>
                Focus
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
          </div>
        ) : null}
      </div>
      <footer className="xray-foot">
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
}

function FactRow({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children ?? <code>{value}</code>}</dd>
    </>
  );
}
