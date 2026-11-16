// The X-ray: the live view of the world beside the terminal (PLAN.md §6.5). The worker sends view
// models while it is open; the canvas diffs and animates them. A filter by scope, a selection
// whose facts and relations read below the drawing, and the zoom controls. Opening it is help, and
// the worker records it as a lab event.
//
// Like the renderer it names no domain: kind names, scope names and the words of states come from
// the view model.

import { useMemo, useRef, useState } from 'react';
import type { RelationType, ViewModel, ViewState } from '@simlab/kernel';
import { Glyph, ViewCanvas, type CanvasHandle } from '../view/ViewCanvas.tsx';
import { scopeKind, scopes, type ScopeFilter } from '../view/filter.ts';
import { Button, Icon } from './ui.tsx';

export interface XRayProps {
  model?: ViewModel;
  reducedMotion: boolean;
  close(): void;
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

export function XRay({ model, reducedMotion, close }: XRayProps) {
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

  return (
    <section className="xray" aria-label="X-ray: the simulated world">
      <header className="xray-head">
        <div className="xray-title">
          <Icon name="xray" size={16} />
          <h2>X-ray</h2>
          <span className="xray-note" title="The X-ray is help: opening it is recorded with the attempt.">counts as help</span>
        </div>
        <div className="xray-tools">
          {scopeName ? (
            <label className="xray-filter">
              <span className="sr-only">{scopeName.label}</span>
              <select value={filterValue(filter)} onChange={(e) => setFilter(parseFilter(e.target.value))} aria-label={`Filter by ${scopeName.label}`}>
                <option value="mine">All {scopeName.plural.toLowerCase()} but the system’s</option>
                <option value="all">All {scopeName.plural.toLowerCase()}</option>
                {scopeList.map((s) => (
                  <option key={s.id} value={`scope:${s.id}`}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
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
      </div>
      <footer className="xray-foot">
        {entity ? (
          <div className="xray-detail" aria-live="polite">
            <div className="xray-detail-head">
              <span className={`state-chip state-${entity.state}`}>{entity.status ?? entity.state}</span>
              <strong>{entity.label}</strong>
              <span className="xray-kind">{kinds.get(entity.kind)?.label}</span>
              <Button variant="ghost" small className="xray-focus" title="Zoom to it (F)" onClick={() => canvas.current?.focusSelected()}>
                Focus
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
        ) : (
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
        )}
      </footer>
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
