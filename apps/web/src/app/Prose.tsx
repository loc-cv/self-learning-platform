// Content prose in the language the learner chose (PLAN.md §5 "Languages"): English, Vietnamese,
// or both side by side, one row per text unit so the two stay aligned. A unit with no current
// Vietnamese shows its English with a badge; nothing is ever hidden or blocked by a translation.
// An item with no sidecar at all says so once, in its header, not on every paragraph.

import { useMemo, type ReactNode } from 'react';
import type { PBlock, Text } from '../protocol.ts';
import { Figure } from './Figure.tsx';
import { renderInline, renderMarkdown } from './markdown.ts';
import type { Lang } from './storage.ts';

const GAP = {
  missing: { label: 'EN only', title: 'This text has no Vietnamese translation yet' },
  outdated: { label: 'VI outdated', title: 'The English changed after this was translated; the English is shown' },
} as const;

export function GapBadge({ gap }: { gap: 'missing' | 'outdated' }) {
  return (
    <span className={`lang-badge is-${gap}`} title={GAP[gap].title}>
      {GAP[gap].label}
    </span>
  );
}

/** What an item's header says about its translation, when the learner reads Vietnamese. */
export function TranslationNote({ translation, lang }: { translation: 'none' | 'partial' | 'full'; lang: Lang }) {
  if (lang === 'en' || translation === 'full') return null;
  return (
    <span className="lang-badge is-missing" title={translation === 'none' ? 'This item has no Vietnamese translation yet' : 'Parts of this item are not translated, or their English changed since'}>
      {translation === 'none' ? 'English only' : 'VI partial'}
    </span>
  );
}

/** A text unit. `inline` renders one line without a paragraph (titles, choices). */
export function T({ t, lang, inline, className }: { t: Text; lang: Lang; inline?: boolean; className?: string }) {
  const html = useMemo(() => {
    const render = inline ? renderInline : renderMarkdown;
    return { en: render(t.en), vi: t.vi === undefined ? undefined : render(t.vi) };
  }, [t, inline]);
  const Tag = inline ? 'span' : 'div';
  const cls = `${inline ? '' : 'markdown'}${className ? ` ${className}` : ''}`.trim();
  const en = <Tag className={cls} lang="en" dangerouslySetInnerHTML={{ __html: html.en }} />;
  if (lang === 'en' || (html.vi === undefined && t.gap === undefined)) return en;
  const vi = html.vi === undefined ? undefined : <Tag className={cls} lang="vi" dangerouslySetInnerHTML={{ __html: html.vi }} />;
  if (lang === 'vi') {
    if (vi) return vi;
    return (
      <Tag className="lang-fallback">
        {en}
        {t.gap ? <GapBadge gap={t.gap} /> : null}
      </Tag>
    );
  }
  return (
    <Tag className={`bi${inline ? ' bi-inline' : ''}`}>
      <Tag className="bi-en">{en}</Tag>
      <Tag className="bi-vi">{vi ?? (t.gap ? <GapBadge gap={t.gap} /> : null)}</Tag>
    </Tag>
  );
}

/** One figure: drawn in the chosen language, with the other language's captions under its own when side by side. */
export function FigureBlock({ block, lang, reducedMotion }: { block: Exclude<PBlock, { text: Text }>; lang: Lang; reducedMotion: boolean }) {
  if ('failed' in block)
    return (
      <figure className="figure is-failed">
        <figcaption className="figure-caption">{block.failed.caption}</figcaption>
        <p>This figure could not be built: {block.failed.problems.join('; ')}</p>
        <p className="figure-alt">{block.failed.alt}</p>
      </figure>
    );
  const badge: ReactNode = lang !== 'en' && block.gap ? <GapBadge gap={block.gap} /> : null;
  if (lang === 'vi') return <Figure figure={block.vi ?? block.figure} reducedMotion={reducedMotion} badge={badge} />;
  return <Figure figure={block.figure} second={lang === 'both' ? block.vi : undefined} reducedMotion={reducedMotion} badge={badge} />;
}

/** Prose and figures in order; a figure that could not be built says so in its place. */
export function Blocks({ blocks, lang, reducedMotion }: { blocks: readonly PBlock[]; lang: Lang; reducedMotion: boolean }) {
  return <>{blocks.map((b, i) => ('text' in b ? <T key={i} t={b.text} lang={lang} /> : <FigureBlock key={i} block={b} lang={lang} reducedMotion={reducedMotion} />))}</>;
}
