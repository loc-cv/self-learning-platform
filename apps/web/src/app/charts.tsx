// The small drawings of the home screen and the content browser: meters, the session's bar, the
// due forecast, the activity strip, an exam's domains, state glyphs and an item's title in the
// chosen language. Plain elements and SVG, every color and size a token (learning.css); each
// drawing carries a text alternative, and no state is shown by color alone (docs/DESIGN.md §5).

import type { ReactNode } from 'react';
import type { ItemStatus, SkillStatus } from '@simlab/learn';
import { titleVi } from '../content.ts';
import type { ActivityDay, DomainRow, ForecastDay, SessionPlan } from './homeModel.ts';
import { dayDate, formatMinutes, formatMs, percent, relativeDay } from './homeModel.ts';
import type { Lang } from './storage.ts';

// ---------- states ----------

export type LearnState = ItemStatus | SkillStatus;

/** The state colors the learning statuses borrow, with the glyph each state has in a view. */
const GLYPH: Record<LearnState, 'dot' | 'arc' | 'triangle' | 'ring' | 'lock'> = { mastered: 'dot', learning: 'arc', due: 'triangle', new: 'ring', locked: 'lock' };

export function StateGlyph({ state }: { state: LearnState }) {
  const g = GLYPH[state];
  return (
    <svg className="lglyph" viewBox="-6 -6 12 12" aria-hidden="true">
      {g === 'dot' ? <circle r="4" className="lglyph-fill" /> : null}
      {g === 'arc' ? <path d="M 0 -4 A 4 4 0 1 1 -4 0" className="lglyph-line" /> : null}
      {g === 'triangle' ? <path d="M 0 -4.5 L 4.5 3.5 L -4.5 3.5 Z" className="lglyph-fill" /> : null}
      {g === 'ring' ? <circle r="3.6" className="lglyph-line" /> : null}
      {g === 'lock' ? (
        <>
          <rect x="-3.8" y="-0.8" width="7.6" height="5.6" rx="1.2" className="lglyph-fill" />
          <path d="M -2.2 -0.8 V -2.4 A 2.2 2.2 0 0 1 2.2 -2.4 V -0.8" className="lglyph-line" />
        </>
      ) : null}
    </svg>
  );
}

/** A status as a chip: glyph, then words. */
export function StatusChip({ state, children, title }: { state: LearnState; children?: ReactNode; title?: string | undefined }) {
  return (
    <span className={`lstatus ls-${state}`} title={title}>
      <StateGlyph state={state} />
      {children ?? state}
    </span>
  );
}

// ---------- meters ----------

/** A share from 0 to 1 as a bar; the accent unless a state is given. */
export function Meter({ value, label, state }: { value: number; label: string; state?: LearnState | undefined }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <span className={`lmeter${state ? ` ls-${state}` : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-label={label}>
      <span className="lmeter-fill" style={{ width: `${v * 100}%` }} />
    </span>
  );
}

// ---------- titles in the chosen language ----------

/** An item's title: English, Vietnamese when its translation is current, or both. */
export function ItemTitle({ id, title, lang }: { id: string; title: string; lang: Lang }) {
  const vi = lang === 'en' ? undefined : titleVi(id);
  if (lang === 'vi') {
    if (vi) return <span lang="vi">{vi}</span>;
    return (
      <>
        {title}{' '}
        <span className="lang-badge" title="Not translated yet">
          EN<span className="sr-only">, not translated yet</span>
        </span>
      </>
    );
  }
  if (lang === 'both' && vi)
    return (
      <>
        <span className="title-en">{title}</span>
        <span className="title-vi" lang="vi">
          {vi}
        </span>
      </>
    );
  return <>{title}</>;
}

// ---------- today's session as a bar ----------

/** The session laid on the time box: what was spent today, then each entry by its target time. */
export function SessionBar({ plan }: { plan: SessionPlan }) {
  const box = plan.box / plan.scale;
  const summary = `${plan.spent > 0 ? `${formatMinutes(plan.spent)} already spent; ` : ''}${plan.entries.length} items, ${formatMinutes(plan.minutes)}, in a time box of ${plan.box} minutes${plan.scale > plan.box ? '; the first item alone is longer than what is left' : ''}.`;
  return (
    <div className="seqbar" role="img" aria-label={summary}>
      <div className="seqbar-track">
        {plan.spent > 0 ? <span className="seqbar-seg is-spent" style={{ left: '0%', width: `${(plan.spent / plan.scale) * 100}%` }} title={`${formatMinutes(plan.spent)} spent today`} /> : null}
        {plan.entries.map((e, i) => (
          <span key={e.item} className={`seqbar-seg is-${e.reason}`} style={{ left: `${e.from * 100}%`, width: `${(e.to - e.from) * 100}%` }} title={`${i + 1}. ${e.title}: ${e.reason}, ${formatMinutes(e.minutes)}`} />
        ))}
        <span className="seqbar-box" style={{ left: `${box * 100}%` }} />
      </div>
      <div className="seqbar-axis" aria-hidden="true">
        <span>0</span>
        <span className="seqbar-box-label" style={{ left: `${box * 100}%` }}>
          {plan.box} min
        </span>
      </div>
    </div>
  );
}

// ---------- the due forecast ----------

export function Forecast({ days, today }: { days: ForecastDay[]; today: number }) {
  const max = Math.max(1, ...days.map((d) => d.count));
  const said = days.filter((d) => d.count > 0).map((d) => `${relativeDay(d.day, today)} ${d.count}${d.overdue > 0 ? ` (${d.overdue} overdue)` : ''}`);
  const summary = said.length === 0 ? 'No reviews due in the next 14 days.' : `Reviews due: ${said.join(', ')}; no other day has any.`;
  const last = days.at(-1);
  return (
    <div className="forecast">
      <div className="forecast-plot" role="img" aria-label={summary}>
        {days.map((d) => {
          const date = dayDate(d.day);
          const tip = `${date.long}: ${d.count === 0 ? 'nothing due' : `${d.count} due, about ${formatMinutes(d.minutes)}`}${d.overdue > 0 ? `, ${d.overdue} of them overdue` : ''}`;
          return (
            <div key={d.day} className={`forecast-col${d.day === today ? ' is-today' : ''}`} title={tip}>
              <span className="forecast-n">{d.count > 0 ? d.count : ''}</span>
              <span className={`forecast-bar${d.count === 0 ? ' is-zero' : ''}`} style={d.count > 0 ? { height: `${(d.count / max) * 100}%` } : undefined}>
                {d.overdue > 0 ? <span className="forecast-overdue" style={{ height: `${(d.overdue / d.count) * 100}%` }} /> : null}
              </span>
              <span className="forecast-day">{date.weekday.slice(0, 1)}</span>
            </div>
          );
        })}
      </div>
      <div className="chart-axis" aria-hidden="true">
        <span>today</span>
        <span>{last ? dayDate(last.day).label : ''}</span>
      </div>
      {days[0] && days[0].overdue > 0 ? (
        <p className="chart-legend" aria-hidden="true">
          <span className="chart-swatch is-overdue" /> overdue, counted on today
        </p>
      ) : null}
    </div>
  );
}

// ---------- activity ----------

export function ActivityStrip({ days, box }: { days: ActivityDay[]; box: number }) {
  const active = days.filter((d) => d.attempts > 0);
  const summary = `Active on ${active.length} of the last ${days.length} days, ${formatMs(active.reduce((n, d) => n + d.activeMs, 0))} in all.`;
  return (
    <div className="activity">
      <div className="activity-cells" role="img" aria-label={summary}>
        {days.map((d) => {
          const date = dayDate(d.day).long;
          return <span key={d.day} className={`activity-cell is-l${d.level}`} title={d.attempts === 0 ? `${date}: nothing` : `${date}: ${d.attempts} finished, ${d.passes} passed, ${formatMs(d.activeMs)}`} />;
        })}
      </div>
      <div className="chart-axis" aria-hidden="true">
        <span>{days.length / 7} weeks ago</span>
        <span>today</span>
      </div>
      <p className="chart-legend">
        <span className="chart-swatch activity-cell is-l4" aria-hidden="true" /> a full cell is the time box ({box} min); fainter is less.
      </p>
    </div>
  );
}

// ---------- an exam's domains ----------

/** One bar for the exam: each domain as wide as its share, filled from below to its mastery. */
export function ExamStrip({ domains, title }: { domains: DomainRow[]; title: string }) {
  const summary = `${title}: ${domains.map((d) => `${d.title}, ${d.weight ?? 0}% of the exam, ${d.items === 0 ? 'no items yet' : `mastery ${percent(d.mastery)}`}`).join('; ')}.`;
  return (
    <div className="examstrip" role="img" aria-label={summary}>
      {domains.map((d) => (
        <span key={d.domain} className={`examstrip-seg${d.items === 0 ? ' is-empty' : ''}`} style={{ flexGrow: d.weight ?? 1 }} title={`${d.title}: ${d.weight ?? 0}% of the exam, ${d.items === 0 ? 'no items yet' : `mastery ${percent(d.mastery)}`}`}>
          <span className="examstrip-fill" style={{ height: `${Math.max(0, Math.min(1, d.mastery)) * 100}%` }} />
        </span>
      ))}
    </div>
  );
}
