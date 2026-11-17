// The home screen (PLAN.md §10, docs/LEARNING_MODEL.md §8, §9): today's session and what it will
// hold, mastery by curriculum domain and by skill, the due forecast, the streak, recent mistakes
// and unfinished attempts. Everything drawn comes from homeModel.ts; this file lays it out.

import type { Catalog, ProgressState, Queue } from '@simlab/learn';
import { dayIndex, RECENT_MISTAKE_DAYS, streak } from '@simlab/learn';
import { CURRICULUM, type Practiced } from '../content.ts';
import { ActivityStrip, ExamStrip, Forecast, ItemTitle, Meter, SessionBar, StateGlyph, StatusChip } from './charts.tsx';
import { TIME_BOXES, type DailySession } from './daily.ts';
import { activity, ago, dayDate, examGroups, forecast, formatMinutes, formatMs, isFirstRun, KIND_LABEL, mistakeKinds, mistakeRows, percent, relativeDay, sessionMode, sessionPlan, skillRows, type ExamGroup, type ForecastDay, type SessionPlan, type SkillRow } from './homeModel.ts';
import type { SyncState } from './progress.ts';
import type { Lang } from './storage.ts';
import { Button, Icon, Segmented, Select } from './ui.tsx';

export interface HomeProps {
  state: ProgressState;
  catalog: Catalog;
  items: Readonly<Record<string, Practiced>>;
  /** Milliseconds since the epoch; the screen never reads a clock. */
  now: number;
  /** Today's queue, skipped entries already removed. */
  queue: Queue;
  session: DailySession;
  /** Unfinished attempts, newest first. */
  resumable: { item: string; attempt: string; startedAt: number }[];
  lang: Lang;
  sync: SyncState;
  startSession(): void;
  setDailyMinutes(minutes: number): void;
  setTrack(id: string): void;
  openItem(item: string, opts: { fresh: boolean }): void;
  openBrowser(): void;
}

export function Home(p: HomeProps) {
  const today = dayIndex(p.now, p.state.settings);
  const first = isFirstRun(p.state);
  const days = forecast(p.state, p.catalog, p.now);
  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-head">
          <div>
            <h1>Today</h1>
            <p className="home-date">{dayDate(today).long}</p>
          </div>
          {p.sync === 'offline' ? (
            <p className="home-sync" role="status">
              Progress is kept in this browser until the server is back.
            </p>
          ) : null}
          <Button onClick={p.openBrowser}>
            <Icon name="list" size={14} />
            All items
          </Button>
        </header>
        <div className="home-grid">
          <div className="home-main">
            <SessionPane {...p} first={first} days={days} today={today} />
            <div className="home-exams">
              {examGroups(p.state, p.catalog, p.now, CURRICULUM).map((g) => (
                <ExamPane key={g.exam} group={g} first={first} />
              ))}
            </div>
            <SkillsPane rows={skillRows(p.state, p.catalog, p.now)} first={first} />
          </div>
          <div className="home-side">
            {p.resumable.length > 0 ? <ResumePane {...p} /> : null}
            {first ? (
              <FirstRunPane box={p.state.settings.dailyMinutes} />
            ) : (
              <>
                <StreakPane state={p.state} now={p.now} />
                <ForecastPane days={days} today={today} />
                <MistakesPane {...p} />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- today's session ----------

function SessionPane(p: HomeProps & { first: boolean; days: ForecastDay[]; today: number }) {
  const plan = sessionPlan(p.state, p.catalog, p.queue);
  const mode = sessionMode(p.state, p.queue, p.session);
  const trackIds = Object.keys(p.catalog.tracks);
  const active = p.state.settings.activeTrack;
  const track = active === undefined ? undefined : p.catalog.tracks[active];
  return (
    <section className="hpane home-session" aria-labelledby="home-session-title">
      <div className="hpane-head">
        <h2 id="home-session-title">Today's session</h2>
        <div className="home-box">
          <span className="home-box-label" id="home-box-label">
            Time box
          </span>
          <Segmented label="Time box in minutes" value={p.state.settings.dailyMinutes} options={TIME_BOXES.map((m) => ({ value: m, label: String(m), title: `${m} minutes a day` }))} onChange={p.setDailyMinutes} />
          <span className="home-box-unit">min</span>
        </div>
      </div>
      {mode === 'done' ? <DoneToday {...p} /> : mode === 'idle' ? <Idle {...p} trackTitle={track?.title} /> : <Plan {...p} plan={plan} mode={mode} trackTitle={track?.title} />}
      <div className="home-track">
        {trackIds.length > 1 ? (
          <>
            <span className="home-track-label">New items from</span>
            <Select label="Track" value={active ?? ''} options={trackIds.map((id) => ({ value: id, label: p.catalog.tracks[id]?.title ?? id }))} onChange={p.setTrack} />
          </>
        ) : track && !p.first ? (
          <span className="home-track-label">
            New items from the track <strong>{track.title}</strong>
          </span>
        ) : null}
      </div>
    </section>
  );
}

function Plan(p: HomeProps & { plan: SessionPlan; mode: 'start' | 'continue'; first: boolean; trackTitle: string | undefined }) {
  const { plan } = p;
  const n = plan.entries.length;
  return (
    <>
      <p className="home-lead">
        <span className="home-figure">
          {n} {n === 1 ? 'item' : 'items'}, about {formatMinutes(plan.minutes)}
        </span>
        <span className="home-counts">
          <span className="num">{plan.reviews}</span> {plan.reviews === 1 ? 'review' : 'reviews'} due · <span className="num">{plan.fresh}</span> new
          {plan.spent > 0 ? (
            <>
              {' '}
              · <span className="num">{formatMinutes(plan.spent)}</span> already spent today
            </>
          ) : null}
        </span>
      </p>
      {p.first ? (
        <p className="home-note">
          Your first session. New items come one after another from the track {p.trackTitle ? <strong>{p.trackTitle}</strong> : null}, fitted to {plan.box} minutes. Every item you finish is scheduled for review: sooner after a struggle, later after a clean pass. On later days the reviews come first.
        </p>
      ) : null}
      <SessionBar plan={plan} />
      <ol className="seq">
        {plan.entries.map((e, i) => (
          <li key={e.item} className="seq-item">
            <span className="seq-n">{i + 1}</span>
            <span className="kind-tag">{KIND_LABEL[e.kind]}</span>
            <span className="seq-title">
              <ItemTitle id={e.item} title={e.title} lang={p.lang} />
            </span>
            <span className={`seq-reason is-${e.reason}`}>
              <span className="seq-swatch" aria-hidden="true" />
              {e.reason}
            </span>
            <span className="seq-min num">{formatMinutes(e.minutes)}</span>
          </li>
        ))}
      </ol>
      {plan.waiting ? <p className="home-note">{plan.waiting}</p> : null}
      {p.session.skipped.length > 0 ? (
        <p className="home-note">
          {p.session.skipped.length} skipped today: {p.session.skipped.length === 1 ? 'it stays' : 'they stay'} due and {p.session.skipped.length === 1 ? 'comes' : 'come'} back tomorrow.
        </p>
      ) : null}
      <div className="home-actions">
        <Button variant="primary" className="home-start" onClick={p.startSession}>
          <Icon name="play" size={14} />
          {p.mode === 'continue' ? "Continue today's session" : "Start today's session"}
        </Button>
        {p.session.done.length > 0 ? <span className="home-note-inline">{p.session.done.length} done so far</span> : null}
      </div>
    </>
  );
}

const OUTCOME_MARK = { passed: '✓', failed: '✗', abandoned: '–' } as const;

function DoneToday(p: HomeProps & { days: ForecastDay[] }) {
  const d = p.state.days[String(p.queue.day)];
  const tomorrow = p.days[1]?.count ?? 0;
  return (
    <>
      <p className="home-lead">
        <span className="home-figure home-done">
          <StateGlyph state="mastered" />
          Done for today
        </span>
        {d ? (
          <span className="home-counts">
            <span className="num">{d.attempts}</span> finished · <span className="num">{d.passes}</span> passed · <span className="num">{formatMs(d.activeMs)}</span>
          </span>
        ) : null}
      </p>
      {p.session.done.length > 0 ? (
        <ol className="seq">
          {p.session.done.map((e, i) => (
            <li key={`${e.item}-${i}`} className="seq-item">
              <span className="seq-n">{i + 1}</span>
              <span className="kind-tag">{KIND_LABEL[p.catalog.items[e.item]?.kind ?? 'lab']}</span>
              <span className="seq-title">
                <ItemTitle id={e.item} title={p.catalog.items[e.item]?.title ?? e.item} lang={p.lang} />
              </span>
              <span className={`seq-outcome is-${e.outcome}`}>
                <span aria-hidden="true">{OUTCOME_MARK[e.outcome]}</span> {e.outcome}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      <p className="home-note">
        {tomorrow === 0 ? 'No review falls due tomorrow.' : `Tomorrow ${tomorrow} ${tomorrow === 1 ? 'review falls' : 'reviews fall'} due.`} A longer time box opens more of today's queue; free practice is in the content browser.
      </p>
      <div className="home-actions">
        <Button onClick={p.openBrowser}>
          <Icon name="list" size={14} />
          Practice more
        </Button>
      </div>
    </>
  );
}

function Idle(p: HomeProps & { days: ForecastDay[]; today: number; trackTitle: string | undefined }) {
  const next = p.days.find((d) => d.count > 0);
  return (
    <>
      <p className="home-lead">
        <span className="home-figure">Nothing to do today</span>
      </p>
      <p className="home-note">
        {p.trackTitle ? (
          <>
            No review is due, and <strong>{p.trackTitle}</strong> has no new item ready.
          </>
        ) : (
          'No review is due, and no track is chosen to take new items from.'
        )}{' '}
        {next ? `The next ${next.count === 1 ? 'review falls' : `${next.count} reviews fall`} due ${relativeDay(next.day, p.today)} (${dayDate(next.day).long}).` : ''}
      </p>
      <div className="home-actions">
        <Button onClick={p.openBrowser}>
          <Icon name="list" size={14} />
          Browse all items
        </Button>
      </div>
    </>
  );
}

// ---------- mastery ----------

function ExamPane({ group, first }: { group: ExamGroup; first: boolean }) {
  const id = `home-exam-${group.exam}`;
  return (
    <section className="hpane home-exam" aria-labelledby={id}>
      <div className="hpane-head">
        <h2 id={id}>{group.title}</h2>
      </div>
      {group.weighted !== undefined && !first ? (
        <p className="home-score">
          <span className="score num">{percent(group.weighted)}</span>
          <span className="home-score-label">mastery, weighted by each domain's share of the exam</span>
        </p>
      ) : first ? (
        <p className="home-note home-exam-lead">
          {group.items} {group.items === 1 ? 'item covers' : 'items cover'} this curriculum so far. Mastery shows here once you have finished some of them.
        </p>
      ) : null}
      {group.weighted !== undefined ? <ExamStrip domains={group.domains} title={group.title} /> : null}
      <table className="domains">
        <thead>
          <tr>
            <th scope="col">Domain</th>
            <th scope="col" className="domain-weight">
              {group.weighted !== undefined ? 'Share' : ''}
            </th>
            <th scope="col" className="domain-mastery">
              {first ? 'Items' : 'Mastery'}
            </th>
          </tr>
        </thead>
        <tbody>
          {group.domains.map((d) => (
            <tr key={d.domain} className={d.items === 0 ? 'is-empty' : undefined}>
              <th scope="row" className="domain-title">
                {d.title}
              </th>
              <td className="domain-weight num">{d.weight !== undefined ? `${d.weight}%` : ''}</td>
              <td className="domain-mastery">
                {d.items === 0 ? (
                  <span className="domain-none">no items yet</span>
                ) : first ? (
                  <span className="domain-none">
                    {d.items} {d.items === 1 ? 'item' : 'items'}
                  </span>
                ) : (
                  <span className="domain-bar" title={`${d.passed} of ${d.items} items passed; ${d.attempts} attempts, ${percent(d.passRate)} of them passed`}>
                    <Meter value={d.mastery} label={`${d.title}: mastery ${percent(d.mastery)}`} />
                    <span className="domain-num num">{percent(d.mastery)}</span>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const SKILL_WORD = { mastered: 'mastered', learning: 'learning', new: 'new', locked: 'locked' } as const;

function SkillsPane({ rows, first }: { rows: SkillRow[]; first: boolean }) {
  const count = (s: SkillRow['status']): number => rows.filter((r) => r.status === s).length;
  return (
    <section className="hpane home-skills" aria-labelledby="home-skills-title">
      <div className="hpane-head">
        <h2 id="home-skills-title">Skills</h2>
        <span className="hpane-meta">
          {(['mastered', 'learning', 'new', 'locked'] as const)
            .filter((s) => count(s) > 0)
            .map((s) => `${count(s)} ${SKILL_WORD[s]}`)
            .join(' · ')}
        </span>
      </div>
      <p className="home-caption">{first ? 'A skill opens once the skills it builds on have a passed item. ' : ''}Mastery is the estimated chance of recalling a skill's items now; a skill counts as mastered from 80%.</p>
      <ul className="skills">
        {rows.map((r) => (
          <li key={r.skill} className="skill">
            <span className="skill-title">{r.title}</span>
            {r.attempted > 0 ? <span className="skill-num num">{percent(r.mastery)}</span> : null}
            {r.attempted > 0 ? <Meter value={r.mastery} label={`${r.title}: mastery ${percent(r.mastery)}`} state={r.status === 'mastered' ? 'mastered' : undefined} /> : null}
            <span className="skill-sub">
              <StatusChip state={r.status}>{SKILL_WORD[r.status]}</StatusChip>
              <span>
                {r.attempted > 0 ? `${r.passed} of ${r.items} passed` : r.needs.length > 0 ? `needs ${r.needs.join(', ')}` : `${r.items} ${r.items === 1 ? 'item' : 'items'}, none tried yet`}
              </span>
              {r.recentMistakes > 0 ? (
                <span className="skill-mistakes">
                  <StateGlyph state="due" /> {r.recentMistakes} {r.recentMistakes === 1 ? 'mistake' : 'mistakes'} in {RECENT_MISTAKE_DAYS} days
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- the side column ----------

function ResumePane(p: HomeProps) {
  return (
    <section className="hpane home-resume" aria-labelledby="home-resume-title">
      <div className="hpane-head">
        <h2 id="home-resume-title">Unfinished</h2>
      </div>
      <ul className="rows">
        {p.resumable.map((r) => {
          const meta = p.catalog.items[r.item];
          return (
            <li key={r.attempt} className="row">
              <div className="row-main">
                <span className="row-title">
                  <ItemTitle id={r.item} title={meta?.title ?? r.item} lang={p.lang} />
                </span>
                <span className="row-sub">
                  {meta ? `${KIND_LABEL[meta.kind]} · ` : ''}started {ago(r.startedAt, p.now)}
                </span>
              </div>
              <Button small variant="primary" onClick={() => p.openItem(r.item, { fresh: false })}>
                Resume
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function StreakPane({ state, now }: { state: ProgressState; now: number }) {
  const s = streak(state, now);
  return (
    <section className="hpane home-streak" aria-labelledby="home-streak-title">
      <div className="hpane-head">
        <h2 id="home-streak-title">Streak</h2>
      </div>
      <p className="home-score">
        <span className="score num">{s.current}</span>
        <span className="home-score-label">
          {s.current === 1 ? 'day' : 'days'} in a row
          <br />
          longest {s.longest} · {s.today ? 'today counts' : s.current > 0 ? 'finish an item today to keep it' : 'finish an item to start one'}
        </span>
      </p>
      <ActivityStrip days={activity(state, now)} box={state.settings.dailyMinutes} />
    </section>
  );
}

function ForecastPane({ days, today }: { days: ForecastDay[]; today: number }) {
  const total = days.reduce((n, d) => n + d.count, 0);
  const overdue = days[0]?.overdue ?? 0;
  return (
    <section className="hpane home-forecast" aria-labelledby="home-forecast-title">
      <div className="hpane-head">
        <h2 id="home-forecast-title">Reviews due</h2>
        <span className="hpane-meta">
          <span className="num">{total}</span> in {days.length} days{overdue > 0 ? ` · ${overdue} overdue` : ''}
        </span>
      </div>
      {total === 0 ? <p className="home-note">No review falls due in the next {days.length} days.</p> : null}
      <Forecast days={days} today={today} />
    </section>
  );
}

function MistakesPane(p: HomeProps) {
  const rows = mistakeRows(p.state, p.catalog, p.now);
  const shown = rows.slice(0, 6);
  return (
    <section className="hpane home-mistakes" aria-labelledby="home-mistakes-title">
      <div className="hpane-head">
        <h2 id="home-mistakes-title">Recent mistakes</h2>
      </div>
      <p className="home-caption">Failed attempts, failed checks, hints and solutions viewed in the last {RECENT_MISTAKE_DAYS} days, most first. The breakdown under each counts all time.</p>
      {rows.length === 0 ? (
        <p className="home-note">None in the last {RECENT_MISTAKE_DAYS} days.</p>
      ) : (
        <ul className="rows">
          {shown.map((r) => (
            <li key={r.item} className="row">
              <span className="row-count num" title={`${r.recent} in the last ${RECENT_MISTAKE_DAYS} days`}>
                {r.recent}
              </span>
              <div className="row-main">
                <span className="row-title">
                  <ItemTitle id={r.item} title={r.title} lang={p.lang} />
                </span>
                <span className="row-sub">
                  {KIND_LABEL[r.kind]} · all time: {mistakeKinds(r.allTime)}
                </span>
              </div>
              <Button small variant="ghost" title="Practice it again, outside the session" onClick={() => p.openItem(r.item, { fresh: true })}>
                Practice
              </Button>
            </li>
          ))}
        </ul>
      )}
      {rows.length > shown.length ? <p className="home-caption">{rows.length - shown.length} more in the content browser.</p> : null}
    </section>
  );
}

function FirstRunPane({ box }: { box: number }) {
  return (
    <section className="hpane home-first" aria-labelledby="home-first-title">
      <div className="hpane-head">
        <h2 id="home-first-title">How this works</h2>
      </div>
      <ol className="steps">
        <li>
          <strong>Start today's session.</strong> Items run beside a terminal on a simulated cluster. A check grades the state of the world, not the commands you typed.
        </li>
        <li>
          <strong>Finish it, and it is scheduled.</strong> Help, failed checks and time decide when it comes back, as a new variant.
        </li>
        <li>
          <strong>Come back tomorrow.</strong> Due reviews come first, then new items, inside {box} minutes. Your streak, what falls due and where you make mistakes appear here.
        </li>
      </ol>
    </section>
  );
}
