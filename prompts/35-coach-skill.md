# Phase 35 — Coach: Claude Code skills that work from my learning data

**Milestone** M5 · **Needs** 12, 14 · Follow the session protocol in `CLAUDE.md`.

## Goal

The app makes no LLM calls, by design. But I use Claude Code, and my progress log, mistake records,
attempt replays and gap log are plain files. Build project skills that let a Claude Code session
act as my coach: analyze how I'm doing, explain what I keep getting wrong, and write new practice
aimed at my weak spots.

## Read first

`PLAN.md` §5. `docs/LEARNING_MODEL.md`. `docs/AUTHORING.md`. The Claude Code documentation for
project skills (check the current format; don't rely on memory).

## Build

- **Data access for a session**: a small CLI (`npm run learn:report -- <topic>`) that prints
  compact, structured summaries from `data/` so a session never has to read raw logs: skill
  mastery and trends, items failed or needing hints, time against target, recurring command errors,
  calibration (confidence versus result), my self-explanations beside the model answers, exam
  history per domain, and one attempt as a readable timeline (commands, outputs trimmed, checks,
  hints). Keep each report small enough to read at once.
- **Skill `coach-review`**: a weekly review. It reads the reports and tells me what improved, what
  is stuck and why it thinks so (with evidence from attempts), which misconceptions my
  self-explanations and errors suggest, and what to focus on next week. It may adjust the active
  track's priorities through a settings file the daily queue reads. It ends with at most three
  concrete recommendations.
- **Skill `coach-explain`**: for one attempt I name (or the last failed one), a walk-through: where
  my reasoning went wrong, what signal I missed in the output I had on screen, the mental model,
  and one follow-up question to test that I understood. It answers from the attempt timeline, the
  item's debrief and the simulator's trace, not from general knowledge alone.
- **Skill `coach-practice`**: writes new items for my weakest skills following `docs/AUTHORING.md`:
  variants of the fault families I fail, cards from my misconceptions, a mixed incident combining
  two weak skills. Every item must pass `npm run content:check` before it is offered, goes into a
  `personal` pack kept apart from the curated packs, and is marked as generated.
- **Skill `sim-gaps`**: reads the gap log, groups notices by command and frequency, and proposes
  what to implement next; a short version of `prompts/R3-feedback-and-gap-triage.md` for regular use.
- **Privacy and safety**: the skills read `data/` through the report CLI and write only through a
  small write CLI limited to the `personal` pack and the queue settings file. They never rewrite
  the progress log.
- Document the skills in `CLAUDE.md` (one line each) and in a short `docs/COACH.md` for me.

## Not in this phase

Any LLM call from the app or server. Automatic, unreviewed changes to curated content.

## Exit criteria

- Each skill runs end to end on fixture data representing a learner with clear weak spots, and its
  output cites specific attempts and numbers from the reports.
- `coach-practice` produces at least three items for the fixture learner that pass `content:check`
  and appear in the app under the personal pack.
- The reports stay within a stated size limit on a year of simulated data.
- Skills write only through a small CLI that refuses any path outside the personal pack and the
  queue settings file; a test proves it refuses the progress log.
