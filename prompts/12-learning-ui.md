# Phase 12 — Learning UI: home, item flows, hints, prediction, debrief, languages

**Milestone** M2 · **Needs** 11 · Follow the session protocol in `CLAUDE.md`.

## Goal

Put the learning loop on screen. I open the app, press one button and work through today's
session; each item gives me the right amount of help, and each ends with feedback that deepens
understanding. The interface should get out of the way of practice.

## Read first

`PLAN.md` §5, §10. `docs/LEARNING_MODEL.md`.

## Build

- **Home**: start today's session (time box selectable), due and new counts, mastery by curriculum
  domain and by skill, recent mistakes, streak, and what the session will contain.
- **Session runner**: presents queued items one after another, shows progress and remaining time,
  allows skip and stop, and survives a reload.
- **Item views**:
  - Lesson: steps with prose beside the live terminal; guided tasks advance when their checks pass.
  - Drill, lab, incident: the workspace from phase 10 with target time, confidence prompt before
    checking, and a "give up and see the solution" path that is recorded.
  - Card: prompt, answer entry or reveal, self-rating or auto-check.
- **Prediction prompts**: ask before a marked step, lock in the answer, then show what happened.
- **Hints**: the ladder, one rung at a time, each use recorded and reflected in the rating.
- **Debrief**: check results with explanations, my command history beside the reference solution,
  the self-explanation prompt (written before the model answer is revealed), the mental model and
  "in reality" notes, the derived rating with a one-click override, and the next review date.
- **Languages**: a global EN / VI / side-by-side setting for all prose, remembered; badges for
  missing or outdated Vietnamese; terminal output untouched.
- **Content browser**: free practice with filters by track, skill, curriculum competency, type and
  state (new, learning, due, mastered).
- **Resume**: an unfinished attempt reopens by replay from the server-stored input log.
- Playwright tests for a full session of mixed item types and for the language toggle.

## Not in this phase

The X-ray view and the causal trace in the debrief (phase 13). Exam mode (phase 31). Authoring new
content (phase 14 and R1).

## Exit criteria

- Starting from an empty `data/`, I can run a daily session end to end on the existing content, and
  the next day's queue reflects my results (simulate the date change in a test).
- Hints, give-up, confidence and rating override all change the recorded events as specified.
- Side-by-side language view aligns each text unit and shows badges correctly.
- Everything is reachable by keyboard. Include screenshots of home, a lab in progress and a debrief.
