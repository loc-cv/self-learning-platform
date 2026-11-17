// Pieces the item panels share: a check's row and a report, what a tab says while it holds
// nothing, the rating with its one-click override, and the button that moves on.

import type { ReactNode } from 'react';
import type { CheckReport, GradeReport, Rating, RatingReason } from '@simlab/learn';
import type { Text } from '../protocol.ts';
import { RATING_NAMES, REASON_TEXT } from './flow.ts';
import { T } from './Prose.tsx';
import type { Lang } from './storage.ts';
import { Button, Icon } from './ui.tsx';

export function CheckRow({ c, title, lang }: { c: CheckReport; title?: Text | undefined; lang: Lang }) {
  const mark = c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '!';
  return (
    <li className={`check is-${c.status}`}>
      <span className="check-mark" aria-label={c.status}>
        {mark}
      </span>
      <div className="check-body">
        <div className="check-title">
          <T t={title ?? { en: c.title }} lang={lang} inline />
          {c.weight !== 1 ? <span className="check-weight">weight {c.weight}</span> : null}
        </div>
        {c.status === 'fail' ? (
          <dl className="check-detail">
            <dt>wanted</dt>
            <dd>{c.expected}</dd>
            <dt>found</dt>
            <dd>{c.observed}</dd>
          </dl>
        ) : null}
        {c.status === 'error' ? <div className="check-detail">could not be evaluated: {c.error ?? ''}</div> : null}
      </div>
    </li>
  );
}

/** A grade: the score, the meter and each check. `children` follows the verdict. */
export function Report({ r, titles, lang, verdict, children }: { r: GradeReport; titles: Readonly<Record<string, Text>>; lang: Lang; verdict?: ReactNode; children?: ReactNode }) {
  const passed = r.checks.filter((c) => c.status === 'pass').length;
  const pct = Math.round(r.score * 100);
  return (
    <section className={`report${r.passed ? ' is-solved' : ''}`} aria-live="polite">
      <header className="score">
        <span className="score-pct">{pct}%</span>
        <span className="score-count">
          {passed} of {r.checks.length} checks pass
        </span>
      </header>
      <div className="meter" aria-hidden="true">
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <ul className="checks">
        {r.checks.map((c) => (
          <CheckRow key={c.id} c={c} title={titles[c.id]} lang={lang} />
        ))}
      </ul>
      {verdict !== undefined ? <p className="verdict">{verdict}</p> : null}
      {children}
    </section>
  );
}

/** What a tab says while it holds nothing, and the question before something that gives the answer away. */
export function Empty({ icon, title, children, ask, onYes, busy }: { icon: string; title: string; children: ReactNode; ask?: { text: string; yes: string }; onYes?: () => void; busy?: boolean }) {
  return (
    <div className="tab-empty">
      <span className="tab-empty-icon">
        <Icon name={icon} size={20} />
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
      {ask ? (
        <div className="tab-ask">
          <p>{ask.text}</p>
          <Button variant="primary" disabled={busy} onClick={onYes}>
            {ask.yes}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export interface Rated {
  rating: Rating;
  source: 'auto' | 'manual';
  reasons?: RatingReason[];
}

export interface Review {
  text: string;
  date: string;
}

const RATINGS: Rating[] = [1, 2, 3, 4];

/**
 * The grade the schedule got and when the item comes back. The four grades are one click each: a
 * manual rating replaces the automatic one for this attempt (docs/LEARNING_MODEL.md §5.2).
 */
export function RatingStrip({ rated, review, rate, label = 'Rating' }: { rated: Rated; review?: Review | undefined; rate(r: Rating): void; label?: string }) {
  return (
    <section className="rating" aria-label={label}>
      <div className="rating-head">
        <span className="rating-label">{label}</span>
        <span className={`rating-name is-r${rated.rating}`}>{RATING_NAMES[rated.rating]}</span>
        <span className="rating-why">{rated.source === 'manual' ? 'set by you' : rated.reasons && rated.reasons.length > 0 ? rated.reasons.map((r) => REASON_TEXT[r]).join('; ') : 'from how the attempt went'}</span>
      </div>
      <div className="segmented rating-seg" role="radiogroup" aria-label="Change the rating">
        {RATINGS.map((r) => (
          <button key={r} type="button" role="radio" aria-checked={r === rated.rating} className={r === rated.rating ? 'is-on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => r !== rated.rating && rate(r)}>
            {RATING_NAMES[r]}
          </button>
        ))}
      </div>
      {review ? (
        <p className="rating-next">
          Next review <strong>{review.text}</strong>
          <span className="rating-date">{review.date}</span>
        </p>
      ) : null}
    </section>
  );
}

export interface NextStep {
  label: string;
  run(): void;
}

export function NextButton({ next }: { next?: NextStep | undefined }) {
  if (!next) return null;
  return (
    <Button variant="primary" className="next-button" onClick={next.run}>
      {next.label}
      <Icon name="next" />
    </Button>
  );
}
