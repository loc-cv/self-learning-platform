# Phase 11 — Learning core: content model, progress, skills, scheduling, persistence

**Milestone** M2 · **Needs** 10c and Checkpoint A2 · Follow the session protocol in `CLAUDE.md`.

## Goal

The half of the product that makes knowledge stick. Build the domain-agnostic logic that decides
what I practice and when, records what happened, and stores it durably. No UI in this phase: pure,
heavily tested logic plus a tiny local server.

## Read first

`PLAN.md` §5, §8. `docs/SCENARIO_FORMAT.md` (figures included).

## Build

- **Content model for every item type**: `lesson` (ordered steps: prose, figure or scene,
  prediction prompt, guided task with checks), `drill`, `lab`, `incident`, `card` (prompt, an
  optional figure, expected answer, optional auto-check by choice or by command), `exam`
  (definition only, no figures; the mode comes in phase 31). Pack
  manifest, tracks (ordered paths through items), skills with prerequisites. Extend the schema,
  loader and `content:check`. Write `docs/LEARNING_MODEL.md`.
- **Vietnamese sidecars**: `<id>.vi.yaml` per item with a source hash per text unit (figure
  captions, notes and alt texts are text units); resolution
  with fallback to English and a status (translated, missing, outdated); `npm run content:i18n`
  prints a report and never fails the gate.
- **Progress log**: append-only events (attempt started and finished, check results, hints,
  X-ray opened, solution viewed, prediction answers, confidence, self-explanation, rating, card
  reviews), with a
  schema version. A reducer derives everything else: per-item scheduling state, per-skill mastery,
  mistake counts, streaks, per-domain statistics.
- **Scheduling**: FSRS through a maintained library, target retention configurable (default 0.9).
  Automatic rating from performance (passed, time against target, hints, X-ray use, solution
  viewed) with a
  manual override. A new variant seed on every review.
- **Daily queue**: due reviews first, then new items from the active track whose prerequisites are
  met; interleaved across skills; no two consecutive items on one skill; fitted to a time box using
  target times; skills with recent mistakes get priority.
- **Time**: the learning layer takes "now" as an input everywhere, so tests can simulate months.
- **`apps/server`**: a minimal Node HTTP server that serves the built web app and persists to
  plain files under `data/`: the progress log, attempt input logs for replay, the gap log, settings.
  Atomic appends, no database. `npm start` uses it; `npm run dev` proxies to it.

## Not in this phase

Any screen (phase 12). New content beyond fixtures needed for tests.

## Exit criteria

- A simulated learner test runs ninety days of daily sessions against a fixture pack and shows:
  intervals grow after successes and shrink after failures, the queue respects the time box and the
  interleaving rule, prerequisites gate new items, and state rebuilt from the log equals live state.
- Deleting derived state and replaying the log reproduces it exactly.
- Killing the server mid-write never corrupts the log (tested).
- Sidecar status detection works for translated, missing and outdated text.
- `packages/learn` still imports no domain package.
