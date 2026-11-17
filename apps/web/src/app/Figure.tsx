// Figures in the lab panel (docs/SCENARIO_FORMAT.md §11, docs/DESIGN.md §6.5): views of simulated
// worlds drawn by the same renderer as the X-ray, in its still mode. A comparison draws two worlds
// with what differs marked; a scene steps through frames the engine ran, forward and back, and
// replays them; a figure opens larger in a dialog. Under reduced motion nothing plays by itself.
//
// Like the renderer it names no domain: what it draws comes from the rendered figure.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Panel, RenderedFigure } from '@simlab/learn';
import { ViewCanvas, type CanvasMarks } from '../view/ViewCanvas.tsx';
import { renderInline } from './markdown.ts';
import { Button, Icon } from './ui.tsx';

/** How long a replayed frame stays before the next (ms): long enough to read its caption. */
export const FRAME_MS = 2600;

function marksOf(p: Panel): CanvasMarks {
  const notes: Record<string, number[]> = {};
  for (const n of p.notes) for (const id of n.on) notes[id] = [...(notes[id] ?? []), n.n];
  return { highlight: p.highlight, notes, changes: p.changes };
}

/** The notes of some panels, each once. */
function notesOf(panels: readonly Panel[]): Panel['notes'] {
  const seen = new Set<number>();
  return panels.flatMap((p) => p.notes).filter((n) => (seen.has(n.n) ? false : (seen.add(n.n), true)));
}

/** `second`: the same panels with their texts in the other language, shown under each note. */
function Notes({ panels, second }: { panels: readonly Panel[]; second?: readonly Panel[] | undefined }) {
  const notes = notesOf(panels);
  const other = second ? notesOf(second) : [];
  if (notes.length === 0) return null;
  return (
    <ol className="figure-notes">
      {notes.map((n) => (
        <li key={n.n}>
          <span className="figure-note-n" aria-hidden={n.on.length === 0 ? undefined : true}>
            {n.on.length > 0 ? n.n : '·'}
          </span>
          <span>
            <span dangerouslySetInnerHTML={{ __html: renderInline(n.text) }} />
            {other.find((o) => o.n === n.n && o.text !== n.text) ? <span className="figure-second" lang="vi" dangerouslySetInnerHTML={{ __html: renderInline(other.find((o) => o.n === n.n)?.text ?? '') }} /> : null}
          </span>
          {n.divergence ? <span className="figure-divergence" title="Where the simulator is simpler than reality: docs/FIDELITY.md">{n.divergence}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function ChangeLegend({ panels }: { panels: readonly Panel[] }) {
  const kinds = new Set(panels.flatMap((p) => Object.values(p.changes)));
  if (kinds.size === 0) return null;
  return (
    <p className="figure-legend">
      {kinds.has('added') ? (
        <span>
          <span className="figure-change is-added">+</span> only on the right
        </span>
      ) : null}
      {kinds.has('changed') ? (
        <span>
          <span className="figure-change is-changed">•</span> changed
        </span>
      ) : null}
      {kinds.has('removed') ? (
        <span>
          <span className="figure-change is-removed">−</span> only on the left
        </span>
      ) : null}
    </p>
  );
}

function PanelView({ panel, label, reducedMotion }: { panel: Panel; label: string; reducedMotion: boolean }) {
  return (
    <div className="figure-panel">
      {panel.title ? <div className="figure-panel-title">{panel.title}</div> : null}
      <ViewCanvas model={panel.model} filter="all" still marks={marksOf(panel)} reducedMotion={reducedMotion} label={label} />
    </div>
  );
}

function Scene({ figure, second, reducedMotion }: { figure: Extract<RenderedFigure, { kind: 'scene' }>; second?: RenderedFigure | undefined; reducedMotion: boolean }) {
  const other = second?.kind === 'scene' ? second : undefined;
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const n = figure.frames.length;
  const frame = figure.frames[i] as (typeof figure.frames)[number];
  useEffect(() => {
    if (!playing) return;
    if (i >= n - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setI((x) => x + 1), FRAME_MS);
    return () => clearTimeout(t);
  }, [playing, i, n]);
  // Reduced motion: nothing plays by itself, even a replay already under way.
  useEffect(() => {
    if (reducedMotion) setPlaying(false);
  }, [reducedMotion]);
  const go = (to: number): void => {
    setPlaying(false);
    setI(Math.max(0, Math.min(n - 1, to)));
  };
  return (
    <>
      <PanelView panel={frame.panel} label={`Frame ${i + 1} of ${n}: ${frame.caption} ${figure.alt}`} reducedMotion={reducedMotion} />
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
        <ol className="scene-dots" aria-hidden="true">
          {figure.frames.map((_, k) => (
            <li key={k} className={k === i ? 'is-current' : k < i ? 'is-past' : ''} />
          ))}
        </ol>
      </div>
      <p className="scene-caption" aria-live="polite">
        <span className="scene-caption-n">{i + 1}</span>
        <span>
          <span dangerouslySetInnerHTML={{ __html: renderInline(frame.caption) }} />
          {other?.frames[i] && other.frames[i]?.caption !== frame.caption ? <span className="figure-second" lang="vi" dangerouslySetInnerHTML={{ __html: renderInline(other.frames[i]?.caption ?? '') }} /> : null}
        </span>
      </p>
      <Notes panels={[frame.panel]} second={other?.frames[i] ? [other.frames[i].panel] : undefined} />
    </>
  );
}

function Body({ figure, second, reducedMotion }: { figure: RenderedFigure; second?: RenderedFigure | undefined; reducedMotion: boolean }) {
  switch (figure.kind) {
    case 'compare':
      return (
        <>
          <div className="figure-pair">
            <PanelView panel={figure.left} label={`${figure.left.title ?? ''}. ${figure.alt}`} reducedMotion={reducedMotion} />
            <PanelView panel={figure.right} label={`${figure.right.title ?? ''}. ${figure.alt}`} reducedMotion={reducedMotion} />
          </div>
          <ChangeLegend panels={[figure.left, figure.right]} />
          <Notes panels={[figure.left, figure.right]} second={second?.kind === 'compare' ? [second.left, second.right] : undefined} />
        </>
      );
    case 'scene':
      return <Scene figure={figure} second={second} reducedMotion={reducedMotion} />;
    default:
      return (
        <>
          <PanelView panel={figure.panel} label={figure.alt} reducedMotion={reducedMotion} />
          <Notes panels={[figure.panel]} second={second && 'panel' in second ? [second.panel] : undefined} />
        </>
      );
  }
}

/**
 * `second` is the same figure with its texts in the other language (side by side): the drawing is
 * `figure`'s, and each caption and note carries the other text under it.
 */
export function Figure({ figure, second, reducedMotion, large, badge }: { figure: RenderedFigure; second?: RenderedFigure | undefined; reducedMotion: boolean; large?: boolean; badge?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <figure className={`figure figure-${figure.kind}${large ? ' is-large' : ''}`}>
      <figcaption className="figure-caption">
        <span>
          <span dangerouslySetInnerHTML={{ __html: renderInline(figure.caption) }} />
          {second && second.caption !== figure.caption ? <span className="figure-second" lang="vi" dangerouslySetInnerHTML={{ __html: renderInline(second.caption) }} /> : null}
          {badge}
        </span>
        {large ? null : (
          <Button small variant="ghost" className="figure-expand" title="Show larger" aria-label="Show larger" onClick={() => setOpen(true)}>
            <Icon name="enlarge" />
          </Button>
        )}
      </figcaption>
      <Body figure={figure} second={second} reducedMotion={reducedMotion} />
      {open ? <FigureDialog figure={figure} second={second} reducedMotion={reducedMotion} close={() => setOpen(false)} /> : null}
    </figure>
  );
}

function FigureDialog({ figure, second, reducedMotion, close }: { figure: RenderedFigure; second?: RenderedFigure | undefined; reducedMotion: boolean; close(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);
  // In the body, not inside the pane: a pane may become the containing block of fixed boxes.
  return createPortal(
    <div className="figure-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="figure-dialog" role="dialog" aria-modal="true" aria-label={figure.caption} tabIndex={-1} ref={ref}>
        <Button small variant="ghost" className="figure-dialog-close" title="Close (Escape)" aria-label="Close" onClick={close}>
          <Icon name="close" />
        </Button>
        <Figure figure={figure} second={second} reducedMotion={reducedMotion} large />
      </div>
    </div>,
    document.body,
  );
}
