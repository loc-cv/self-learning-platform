// The content browser (PLAN.md §10): every item of the catalog for free practice, with where it
// stands for the learner, filtered by track, skill, curriculum domain, kind and state. It replaces
// the lab list (ItemPicker) and lies over the workspace when one is open.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Catalog, ProgressState } from '@simlab/learn';
import { domainInfo, type Practiced } from '../content.ts';
import { ItemTitle, StatusChip } from './charts.tsx';
import { ALL, formatMinutes, itemCards, KIND_LABEL, matches, NO_FILTERS, STATUSES, type Filters, type ItemCard, type Kind } from './homeModel.ts';
import type { Lang } from './storage.ts';
import { Button, Dots, Icon, Select } from './ui.tsx';

export interface BrowserProps {
  state: ProgressState;
  catalog: Catalog;
  items: Readonly<Record<string, Practiced>>;
  now: number;
  lang: Lang;
  resumable: { item: string; attempt: string; startedAt: number }[];
  /** The item open in the workspace, if any. */
  current?: string;
  openItem(item: string, opts: { fresh: boolean }): void;
  /** Present when the browser lies over the workspace. */
  onClose?: () => void;
}

const KINDS: readonly Kind[] = ['lesson', 'drill', 'lab', 'incident', 'card'];

/** `cka.troubleshooting` → "CKA · Troubleshooting"; a domain no curriculum lists keeps its id. */
function domainLabel(id: string): string {
  const d = domainInfo(id);
  return d ? `${d.exam.id.toUpperCase()} · ${d.title}` : id;
}

export function Browser(p: BrowserProps) {
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const cards = useMemo(() => itemCards(p.state, p.catalog, p.now, p.resumable), [p.state, p.catalog, p.now, p.resumable]);
  const shown = cards.filter((c) => matches(c, f));
  const filtered = Object.values(f).some((v) => v !== ALL);
  const set = (k: keyof Filters) => (v: string) => setF({ ...f, [k]: v });
  const all = (label: string) => ({ value: ALL, label });
  const domains = [...new Set(cards.flatMap((c) => c.domains))].sort();
  const kinds = KINDS.filter((k) => cards.some((c) => c.kind === k));
  const skillIds = Object.keys(p.catalog.skills).filter((s) => cards.some((c) => c.skills.includes(s)));
  const trackIds = Object.keys(p.catalog.tracks);
  const sheet = useRef<HTMLDivElement>(null);
  const overlay = p.onClose !== undefined;
  // Over the workspace the browser is a dialog: the keyboard starts inside it, not in the terminal.
  useEffect(() => {
    if (overlay) sheet.current?.focus();
  }, [overlay]);
  return (
    <div
      className={`browser${p.onClose ? ' is-overlay' : ''}`}
      onKeyDown={(e) => {
        // A select that is open takes its own Escape first (ui.tsx stops it there).
        if (e.key === 'Escape' && p.onClose) {
          e.preventDefault();
          p.onClose();
        }
      }}
    >
      <div className="browser-inner" ref={sheet} tabIndex={overlay ? -1 : undefined} role={overlay ? 'dialog' : undefined} aria-modal={p.onClose ? true : undefined} aria-labelledby="browser-title">
        <header className="browser-head">
          <div>
            <h1 id="browser-title">All items</h1>
            <p>Practice anything, outside today's session. Grading reads the final state of the world, never the commands you typed.</p>
          </div>
          {p.onClose ? (
            <Button variant="ghost" title="Back to the workspace (Escape)" onClick={p.onClose}>
              <Icon name="close" size={14} />
              Close
            </Button>
          ) : null}
        </header>
        <div className="browser-filters" role="group" aria-label="Filters">
          {trackIds.length > 1 ? <Facet label="Track" value={f.track} options={[all('Any track'), ...trackIds.map((t) => ({ value: t, label: p.catalog.tracks[t]?.title ?? t }))]} onChange={set('track')} /> : null}
          <Facet label="Skill" value={f.skill} options={[all('Any skill'), ...skillIds.map((s) => ({ value: s, label: p.catalog.skills[s]?.title ?? s }))]} onChange={set('skill')} />
          <Facet label="Curriculum" value={f.domain} options={[all('Any domain'), ...domains.map((d) => ({ value: d, label: domainLabel(d) }))]} onChange={set('domain')} />
          <Facet label="Type" value={f.kind} options={[all('Any type'), ...kinds.map((k) => ({ value: k, label: KIND_LABEL[k] }))]} onChange={set('kind')} />
          <Facet label="State" value={f.status} options={[all('Any state'), ...STATUSES.map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))]} onChange={set('status')} />
        </div>
        <div className="browser-count">
          <span role="status">
            <span className="num">{shown.length}</span> of <span className="num">{cards.length}</span> items
          </span>
          {filtered ? (
            <Button small variant="ghost" onClick={() => setF(NO_FILTERS)}>
              Clear filters
            </Button>
          ) : null}
        </div>
        {shown.length === 0 ? (
          <div className="browser-empty">
            <p>No item matches these filters.</p>
            <Button onClick={() => setF(NO_FILTERS)}>Clear filters</Button>
          </div>
        ) : (
          <ul className="browser-list">
            {shown.map((c) => (
              <Card key={c.item} card={c} {...p} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Facet({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange(v: string): void }) {
  return (
    <div className={`facet${value !== ALL ? ' is-set' : ''}`}>
      <span className="facet-label" aria-hidden="true">
        {label}
      </span>
      <Select label={label} value={value} options={options} onChange={onChange} />
    </div>
  );
}

function Card({ card: c, ...p }: BrowserProps & { card: ItemCard }) {
  const current = p.current === c.item;
  return (
    <li className={`bcard${current ? ' is-current' : ''}`}>
      <div className="bcard-top">
        <span className="kind-tag">{KIND_LABEL[c.kind]}</span>
        <StatusChip state={c.status} title={c.date}>
          {c.detail}
        </StatusChip>
        {current ? <span className="bcard-here">open now</span> : c.attempt ? <span className="bcard-here">unfinished</span> : null}
      </div>
      <div className="bcard-title">
        <ItemTitle id={c.item} title={c.title} lang={p.lang} />
      </div>
      <div className="bcard-meta">
        <Dots n={c.difficulty} of={5} />
        <span>about {formatMinutes(c.minutes)}</span>
        <span className="bcard-id">{c.item}</span>
      </div>
      <div className="bcard-foot">
        <div className="chips">
          {c.skills.map((s) => (
            <span key={s} className="chip">
              {p.catalog.skills[s]?.title ?? s}
            </span>
          ))}
        </div>
        <div className="bcard-actions">
          {current || c.attempt ? (
            <>
              {c.attempt ? (
                <Button small variant="ghost" title="Another variant; the attempt in progress is discarded" onClick={() => p.openItem(c.item, { fresh: true })}>
                  New variant
                </Button>
              ) : null}
              <Button small variant="primary" onClick={() => p.openItem(c.item, { fresh: false })}>
                {current ? 'Back to it' : 'Resume'}
              </Button>
            </>
          ) : (
            <Button small variant="primary" onClick={() => p.openItem(c.item, { fresh: true })}>
              Start
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}
