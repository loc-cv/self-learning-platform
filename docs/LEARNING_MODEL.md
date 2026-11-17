# Learning model

What decides what is practiced and when, what is recorded, and how it is stored. `PLAN.md` §5 is
the design; this document is the contract for the learning screens (phase 12), the content runs
(R1, R2), exam mode (phase 31) and anything else that reads or writes progress. Everything here
is in `packages/learn` and knows no domain: it works from item metadata, a catalog and an event
log. Lab-like items (`lab`, `drill`, `incident`) are specified in `docs/SCENARIO_FORMAT.md`; this
document adds the other kinds and everything around items.

| Part | Code |
|---|---|
| Item kinds, schema, variants, validation | `packages/learn/src/item/`, `validate.ts` |
| Pack manifest, catalog | `packages/learn/src/pack.ts` |
| Text units, sidecars | `packages/learn/src/i18n/` |
| Events, reducer, rating, FSRS, seeds, queue, statistics, simulated learner | `packages/learn/src/progress/` |
| Files under `data/` and the API | `apps/server/src/` |
| `content:check`, `content:i18n`, `content:schema` | `tools/src/content/` |

Time is always an argument. Nothing in `packages/learn` reads a clock: every function that needs
"now" takes it in milliseconds since the epoch, and every event carries the time it was recorded
at. Tests therefore simulate months in milliseconds (§11).

## 1. Item kinds

| Kind | What it is | Scheduled | Specified in |
|---|---|---|---|
| `lab`, `drill`, `incident` | A world, a ticket, checks, solutions, a debrief | yes | `docs/SCENARIO_FORMAT.md` |
| `lesson` | Ordered steps beside a live terminal: prose, figures, predictions, guided tasks | no: done once (D-141) | §2.1 |
| `card` | A retrieval question, optionally checked by choice or by command | yes | §2.2 |
| `exam` | A definition: weighted tasks, a duration, a pass mark | no | §2.3 |

One file per item, as before; `kind` decides the layout. The machine-readable form is
`docs/schema/item.schema.json`: the kind selects one of `$defs.scenarioItem`, `lessonItem`,
`cardItem` and `examItem`, which share `$defs.header` (`id`, `title`, `skills`, `curriculum`,
`difficulty`, `targetMinutes`), `$defs.world`, `figure`, `check`, `steps` and `when`. In code,
`Item` is the lab-like item; `LessonItem`, `CardItem` and `ExamItem` are the others, and `AnyItem`
is any of them (D-140).

Lessons and cards take parameters, placeholders, `when`, steps, checks and figures exactly as
`docs/SCENARIO_FORMAT.md` §4 to §11 define them. Unknown fields are errors.

## 2. Lessons, cards, exams

### 2.1 Lesson

```yaml
id: k8s.workloads.scaling-lesson-01
kind: lesson
title: A replica count is a wish the Deployment keeps granting
skills: [k8s.workloads.deployments]
curriculum: [cka.workloads.deployments-rollouts]
difficulty: 1
targetMinutes: 6
world: { topology: kubeadm-1cp-2w, params: { … }, setup: [ … ] }
steps:
  - text: |                      # prose
      A Deployment does not run Pods itself. …
  - figure: { kind: view, of: start, … }       # a figure or a scene (SCENARIO_FORMAT §11)
  - predict:                     # a prediction prompt
      prompt: You set `replicas` to {{replicas}}. Which object creates the new Pods?
      choices: [The Deployment, The ReplicaSet it owns, The scheduler]
      answer: 1                  # index of the correct choice
      explain: The Deployment only sizes its ReplicaSet. …
  - task:                        # a guided task in the live world
      text: Scale `web` in namespace `{{ns}}` to {{replicas}} replicas.
      hints: [ "`kubectl scale` changes `spec.replicas` without an editor." ]
      checks: [ { id: scaled, title: …, assert: k8s.podsReady, with: { … }, within: 2m } ]
      solution: [ { run: "kubectl -n {{ns}} scale deployment web --replicas={{replicas}}" } ]
```

| Step | Fields | Meaning |
|---|---|---|
| `text` | Markdown | Prose. Keep it short: a lesson is mostly doing |
| `figure` | a figure | `start` is the world after setup, `solved` the world after every task's solution, `now` the learner's world |
| `predict` | `prompt`, `explain`, optional `choices` with `answer` | Asked before the learner sees what happens. With choices the answer is checked; without, the learner compares with `explain` |
| `task` | `text`, `checks`, `solution`, optional `hints` | The learner does it in the terminal; the lesson advances when the checks pass |

Every step takes `when`. A lesson has one world for all its steps: a later task starts where the
earlier ones ended.

### 2.2 Card

```yaml
id: k8s.workloads.owner-card-01
kind: card
title: Who creates a Deployment's Pods
skills: [k8s.workloads.deployments]
curriculum: [cka.workloads.deployments-rollouts]
difficulty: 1
targetMinutes: 0.5
prompt: "A Deployment has `replicas: 3` and only two Pods exist. Which controller creates the third?"
figure: { kind: diagram, … }     # optional
answer: The ReplicaSet controller. The Deployment controller only sizes ReplicaSets.
choices: [The Deployment controller, The ReplicaSet controller, The kubelet]   # optional
correct: 1
```

`answer` is the expected answer, shown on reveal, whatever the way of checking:

| Way | Fields | Grade |
|---|---|---|
| Self-graded | none | The learner rates Again, Hard, Good or Easy after the reveal |
| By choice | `choices`, `correct` | Right is Good, wrong is Again |
| By command | `world`, `checks`, `solution` | The learner works in the card's world and the checks grade its **state**, as for a lab (hard rule 6, D-150). `solution` proves the checks can pass |

A card without `world` has no parameters and can show only a `diagram`. A figure of a world
(`view`, `compare`, `scene`) needs `world`; one that names `solved` needs `solution`.

### 2.3 Exam

```yaml
id: k8s.exams.cka-short-01
kind: exam
title: CKA, short practice exam
minutes: 40
passPercent: 66
tasks:
  - { item: k8s.scheduling.pending-pods-01, weight: 8 }
  - { item: k8s.troubleshooting.broken-rollout-01, weight: 12 }
```

A definition only: phase 31 builds the mode that runs it and the score report. A task is a lab, a
drill or an incident by id; `weight` is its share of the score. In an exam a task shows its
ticket's prose and nothing else: no figures, no hints, no debrief until the report (D-148). An
exam has no skills or curriculum of its own (they follow from its tasks), is not in the catalog
and is never scheduled.

### 2.4 Validation

`npm run content:check` applies `docs/SCENARIO_FORMAT.md` §12 to every kind, with these
differences. A problem is reported with the item's id; any problem fails the gate.

| Kind | Static | Per seed |
|---|---|---|
| `lesson` | A prediction with `choices` has `answer` inside them, and none without. Check ids are unique across the lesson. Task solutions inject no faults | At least one task and one figure apply (show, then tell). Setup completes without a gap. **In order**, each task's checks fail before its solution (at least one fails, none errors) and all pass after it, in the world the earlier tasks left. Every figure resolves |
| `card` | `choices` and `correct` go together; `checks` and `solution` go together and need `world`; never both ways of checking; a non-diagram figure needs `world` | With checks: the untouched world fails, the solution passes. The figure resolves |
| `exam` | Every task names an existing lab, drill or incident, each once | nothing runs |

## 3. Packs

`packages/content/<pack>/pack.yaml`; schema `docs/schema/pack.schema.json`.

```yaml
id: k8s
title: Kubernetes (CKA and CKAD, v1.37)
description: Practice for the CKA and CKAD exams on a simulated kubeadm cluster.
skills:
  - id: k8s.workloads.deployments
    title: Create and configure Deployments
    description: …                         # optional
  - id: k8s.workloads.scaling
    title: Scale a Deployment
    requires: [k8s.workloads.deployments]  # prerequisites
tracks:
  - id: k8s.track.first-labs
    title: First labs
    items: [k8s.workloads.deployment-service-01, k8s.scheduling.pending-pods-01]
```

- A **skill** is a small unit an item practices. An item's first skill is its **primary** skill,
  which is what interleaving compares (§8).
- **`requires`** lists skills that must be *met* before an item on this skill is offered as new. A
  skill is met when at least one item that lists it has been passed. A prerequisite the item
  itself practices does not gate it: a lesson on `deployments` and `scaling` is how `scaling`
  starts.
- A **track** is an ordered path through items: the order new material is offered in. Exams are
  not track items.
- The **catalog** (`buildCatalog`) is what the learning layer works from: per item its kind,
  skills, curriculum, difficulty and target time; the skills; the tracks. It holds no worlds,
  tickets or checks.

`content:check` (`catalogProblems`) refuses: an id defined twice (pack, skill, track, item); a
prerequisite that names no skill, itself, or a cycle; a track that names no item or an exam; and a
track item one of whose prerequisites is practiced by no earlier item of the track, since it
would never be offered.

## 4. Translations

`docs/SCENARIO_FORMAT.md` §13 is the specification: `<id>.vi.yaml` next to the item, one entry per
text unit with the hash of the English it was translated from. The keys of lessons and cards:

| Key | Unit |
|---|---|
| `steps.<n>` | A lesson's prose step |
| `steps.<n>.caption`, `.alt`, `.notes.<m>`, … | The texts of a figure step (the same suffixes as in a ticket or debrief) |
| `steps.<n>.prompt`, `steps.<n>.choices.<m>`, `steps.<n>.explain` | A prediction |
| `steps.<n>.text`, `steps.<n>.hints.<m>`, `steps.<n>.checks.<id>.title` | A guided task |
| `prompt`, `answer`, `choices.<n>` | A card |
| `figure.caption`, `figure.alt`, … | A card's figure |

- `textUnits(item)` lists the units of any item with their keys and where they sit in the item.
- `resolveSidecar(item, sidecar?)` gives every unit a state: **current** (translated from this
  English), **outdated** (from an earlier English), **missing**. It also lists **orphaned** keys
  and **violations**: a current translation that lost a code span, a code block or a placeholder
  of its source.
- `localize(item, resolution)` returns the item with every current translation in place. Outdated
  and missing units stay English. The result has the item's shape, so variants, labs and figures
  work on it unchanged.
- `npm run content:i18n` prints the report: per item `current/total`, outdated and missing
  counts, orphans, violations, sidecars that fail their schema or name another item, sidecars
  with no item. With `-v` it lists every unit that is not current with the hash a translation must
  record (`source: sha256:…`), which is how a translation run gets its hashes. Its exit status is
  always 0: translation never fails the gate.

## 5. Progress log

`data/progress.jsonl`: one JSON object per line, appended and never rewritten. It is the only
thing stored about learning; everything else is derived from it (§5.2). Back it up by copying the
file.

### 5.1 Events

Every event has `v` (the schema version, now `1`), `type` and `at` (wall-clock milliseconds since
the epoch, given by whoever records it). `eventProblem(e)` says why something is not an event; the
server asks it before appending (§10). An event with a higher `v` is refused, not guessed at.

| `type` | Fields | When |
|---|---|---|
| `settings.changed` | `settings` (any of `retention`, `dailyMinutes`, `activeTrack`, `utcOffsetMinutes`, `dayStartHour`) | The learner changes what scheduling depends on (D-144) |
| `attempt.started` | `attempt`, `item`, `seed`, `mode` (`review`, `new`, `free`) | An item opens. `attempt` is an id the app makes up, also the name of its input log (§10) |
| `attempt.check` | `attempt`, `passed`, `score`, `checks` (`id`, `status`), optional `step` | Check is pressed. `step` is the lesson step of a guided task |
| `attempt.hint` | `attempt`, `index`, optional `step` | A rung of the hint ladder is shown |
| `attempt.xray` | `attempt`, `open` | The live view of the world opens or closes |
| `attempt.solution` | `attempt` | The reference solution is viewed |
| `attempt.prediction` | `attempt`, `step`, optional `choice`, `text`, `correct` | A prediction prompt is answered |
| `attempt.confidence` | `attempt`, `confidence` 1 to 5 | Before checking |
| `attempt.explanation` | `attempt`, `text` | The root cause in the learner's words, before the debrief |
| `attempt.finished` | `attempt`, `outcome` (`passed`, `failed`, `abandoned`), `activeMs` | The attempt ends. `activeMs` is the time spent working |
| `card.reviewed` | `attempt`, `item`, `seed`, `outcome` (`passed`, `failed`), `activeMs`, optional `choice` | A card is answered: one event for the whole attempt |
| `rating` | `attempt`, `item`, `rating` 1 to 4, `source` (`auto`, `manual`), optional `reasons` | The grade FSRS gets for an attempt (§6) |

Writing them: the app appends events as they happen. When an attempt ends,
`finishAttempt(state, meta, { attempt, at, outcome, activeMs, hintCount })` returns
`attempt.finished` and, for a scheduled item that was not abandoned, the automatic `rating`;
`cardReview({ … })` returns `card.reviewed` and its `rating`. The automatic rating is **in the
log**, so changing the rating rules later never rewrites history (D-143).

### 5.2 The reducer

`applyEvent(state, event)` returns the next `ProgressState`; `replay(events)` folds a whole log,
and `replay(events, saved)` continues from a saved state. The state is plain serializable data,
and the same events in the same order always give the same state: deleting everything derived and
replaying the log reproduces it exactly. The reducer reads no clock, no random source and no
content.

| Part of the state | Holds |
|---|---|
| `settings` | The learner's settings in force (defaults: retention 0.9, 30 minutes a day, UTC, day starts at 04:00) |
| `open[attempt]` | Attempts started and not finished: hints, failed checks, X-ray, solution, predictions, confidence |
| `items[id]` | Attempts, passes, the last attempt, the schedule (§7), reviews, lapses, mistake counts and mistakes per day, time spent |
| `days[day]` | Per learner's day: finished attempts, passes, time spent |
| `lastFinished` | The item finished last, for interleaving |

Rules worth knowing:

- An event for an attempt that is not open changes nothing (it still counts in `events`).
- Help counts until the first passed check. The X-ray or the solution opened afterwards is study.
- A `rating` applies only to its item's **last finished** attempt. A second rating for the same
  attempt (the manual override) replaces the first: the schedule is recomputed from where the item
  stood before that attempt, at the time the attempt ended. A rating for an older attempt is stale
  and ignored.
- An abandoned attempt counts as an attempt and changes no schedule.
- The state knows items, not skills: skill and domain views are computed with the catalog (§9),
  so they follow the content as it is now (D-145).

## 6. Rating

`autoRating(performance)` is a pure function; the learner can override its result.

| Grade | When |
|---|---|
| Again (1) | Not passed; or the solution was viewed before passing; or the whole hint ladder was used when it has three rungs or more (its last rung is the exact command) |
| Hard (2) | Passed, and any of: a hint used; the X-ray opened before passing; slower than 1.5 × the target time; two or more failed checks |
| Easy (4) | Passed on the first check, unaided, within 0.6 × the target time |
| Good (3) | Passed, otherwise |

The event carries `reasons` (`failed`, `solution-viewed`, `all-hints`, `hints`, `xray`, `slow`,
`failed-checks`, `fast`, `clean`) so the debrief can say why. A drill's single hint is a nudge and
costs Hard, not Again. Lessons are not rated.

## 7. Scheduling

FSRS through the library `ts-fsrs` (pinned; `packages/learn/src/progress/fsrs.ts`), its default
model FSRS-7 with its default weights (D-142). Per item the state keeps the model's memory
(stability, difficulty, …), when it was last reviewed, when it is due and the interval.

- **Target retention** is `settings.retention`, default 0.9, between 0.7 and 0.97. The value in
  force at a review decides that review's interval; changing it is an event and does not move what
  was already scheduled.
- **No item comes back the same day.** The model's interval is used as is, with a floor of one
  day: the daily session is the unit, and a 10-minute lab is not repeated ten minutes later. The
  model still gets the real time between reviews, so its memory stays honest.
- **Due** means the due moment falls on or before the learner's current day (§8), not "at this
  exact minute".
- **A new variant on every review.** `reviewSeed(item, attempts, lastSeed)` is a function of the
  item and of how often it was attempted; where the item has parameters it picks a seed whose
  parameters differ from the last attempt's. `buildQueue` gives every entry its seed.
- Intervals grow after Good and Easy and shrink after Again; what FSRS asks for after Hard can go
  either way. `retrievability(memory, elapsedDays)` is the estimated recall at any moment.

The weights are FSRS's defaults, fitted to flashcard reviews. They are a starting point for labs;
fitting them to the owner's own log is possible once it holds a few hundred reviews (§13).

## 8. The daily queue

`buildQueue(state, catalog, now, { items? })` is a pure function, rebuilt after every finished
item. It returns the entries to do now, in order, each with its reason (`review` or `new`), seed,
target minutes and primary skill.

**The learner's day.** `dayIndex(at, settings)`: days in local time (`utcOffsetMinutes`), a day
starting at `dayStartHour` (default 04:00), so a session past midnight belongs to the evening.
Due dates, the time box and streaks count in these days.

**Candidates.**

1. *Due reviews*: scheduled items of the catalog whose due day has come. Most urgent first: items
   whose skills had mistakes in the last 7 days (failed attempts, failed checks, hints, solutions
   viewed), then the lowest estimated recall.
2. *New items*: the items of `settings.activeTrack`, in track order, that were never rated (a
   lesson: never passed) and whose prerequisites are met (§3). With no active track the queue
   holds reviews only.

**The time box.** `settings.dailyMinutes` minus the time already spent today is what is left.
Reviews are taken by urgency; one that does not fit is skipped so a shorter one can be taken. New
items are then taken in track order and stop at the first that does not fit, so the track is never
skipped ahead. Two consequences: new material appears only when the due reviews that fit are in;
and the first item of a day is always offered, even when it alone is longer than the box. When
the box is spent the queue is empty: done for today. `waiting` counts what did not fit.

**Interleaving.** The chosen entries are ordered so that an entry's primary skill differs from
the one before it (and from the item finished last today): always the most urgent entry left with
a different primary skill. When every entry left has the same primary skill there is nothing to
interleave with; they follow each other, marked `repeatsSkill` (D-146). This happens at the start
of a track, where a lesson and its first drill share a skill on purpose (faded guidance).

A new item whose prerequisite is met by something earlier in today's queue appears when the queue
is rebuilt after that item is passed.

## 9. Derived views

Functions of the state, the catalog and now (`packages/learn/src/progress/stats.ts`):

| Function | Gives |
|---|---|
| `itemStatus` | `new`, `learning`, `due`, `mastered` (a passed lesson, or an interval of 21 days or more) |
| `skillStats` | Per skill: items, attempted, passed, mastery (the estimated recall now, averaged over the skill's scheduled items; an unrated item counts 0), mistakes, recent mistakes, status (`locked`, `new`, `learning`, `mastered` at 0.8) |
| `domainStats` | Per curriculum domain (the first two segments of a competency id): items, attempted, passed, attempts, pass rate, mastery, time spent |
| `streak` | Consecutive learner's days with a finished attempt, the longest run, whether today counts |
| `metSkills`, `recentMistakes`, `itemRecall` | The parts the queue uses |

## 10. Persistence

`apps/server` is the only writer of `data/` (`npm start`; `npm run dev` runs the same server with
Vite as middleware, so the API is identical). Plain files, no database; it listens on 127.0.0.1.

| File | Request | Body or answer |
|---|---|---|
| `data/progress.jsonl` | `GET /api/progress` | The log as NDJSON (empty when absent) |
| | `POST /api/progress` | `{ "events": [...] }`; each must pass `eventProblem`; 204 |
| `data/attempts/<id>.jsonl` | `GET /api/attempts/<id>` | An attempt's input log as NDJSON; 404 when absent |
| | `POST /api/attempts/<id>` | `{ "records": [...] }` (JSON objects, not interpreted); 204 |
| `data/settings.json` | `GET /api/settings` | The object, `{}` when absent |
| | `PUT /api/settings` | A JSON object; replaces the file; 204 |
| `data/gaps.jsonl` | `POST /api/gaps` | `{ "records": [...] }` (`docs/FIDELITY.md` §4.4) |

- A refused request (400, with a one-line reason) writes nothing of its batch.
- **Appends** (`appendLines`): the lines of one request go out in one `write` on an append
  descriptor and are synced before the answer is sent. A process killed in the middle leaves at
  most a fragment after the last newline. Readers ignore such a fragment and the next append
  removes it, so a log is always whole lines only. Tests kill a writer with SIGKILL twenty times
  and cut lines by hand (D-149).
- **Settings** are replaced through a temporary file and a rename. `settings.json` is for the
  interface (language, theme, layout). What scheduling depends on is not there: it is in the log
  as `settings.changed` events, so a replay sees each change when it happened.
- Attempt ids are file names: 1 to 128 letters, digits, dots, dashes or underscores, not starting
  with a dot.

## 11. The simulated learner and the fixtures

- `simulateLearner(catalog, { days, seed, start, track, … })` plays daily sessions with a seeded
  PRNG and returns a real log, the state kept live while writing it, every queue it was shown and
  every review. `demoCatalog()` is a pack of metadata for it: ten skills in a graph of
  prerequisites, 43 items. The ninety-day test
  (`packages/learn/src/progress/learner.test.ts`) asserts on it what phase 11 promised: intervals
  grow after successes and shrink after failures, every queue fits the time box and the
  interleaving rule, prerequisites gate new items, and the state rebuilt from the log equals the
  live state. It is also a way to give the interface a history to draw.
- `packages/content/fixtures/learning/` is a pack with one item of each new kind on the real
  Kubernetes simulator (a lesson, two cards, a drill, an exam) and two sidecars, one of them in
  every state on purpose. The apps do not load it (`loadPacks()` reads `packages/content/<pack>/`
  only); `tools/src/content/learning.test.ts` validates it with the code behind `content:check`
  and `content:i18n`. Copy from it when writing the first real lesson or card.

## 12. For the learning screens (phase 12)

- Load: `GET /api/progress`, `parseLog`, `replay`. Keep the state; apply each event you post.
- A session: `buildQueue(state, catalog, Date.now(), { items })`; open the first entry with its
  seed; rebuild after it ends.
- An attempt of a lab: `attempt.started`, then the lab's events as they happen (a `LabEvent` of
  kind `hint`, `check`, `solution`, `view` maps to `attempt.hint`, `attempt.check`,
  `attempt.solution`, `attempt.xray`), then `finishAttempt`. The override button posts one
  `rating` with `source: manual`.
- The web bundle (`virtual:simlab/content`) carries every item; the workspace today filters to
  lab-like kinds, and sidecars are not bundled yet.
- A lesson's guided task is graded like a lab: `grade(kernel, task.checks, env)` on the session
  world of a baseline built from `scenarioShape(...)`; content validation does exactly this.

## 13. Not covered yet

| Topic | Phase |
|---|---|
| Screens for the queue, lessons, cards, ratings, languages | 12 |
| The debrief's replay of an attempt from its input log | 13 |
| The curriculum map over competencies; the authoring guide for lessons and cards | 14 |
| Exam mode, scoring per domain | 31 |
| Repeated command errors as mistakes (`PLAN.md` §5): no event records them yet | 12 or 13, with the command history |
| FSRS weights fitted to the owner's log (needs the optimizer, a separate package) | a candidate, once the log is large enough |
