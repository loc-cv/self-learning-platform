# Phase 31 — Exam mode

**Milestone** M5 · **Needs** 12, 14 · Useful once enough content exists (after several R1 runs) · Follow the session protocol in `CLAUDE.md`.

## Goal

Practice under exam conditions: a fixed time, a set of weighted tasks across the curriculum
domains, no help, and a score report that tells me where I'm weak. Results flow back into the
scheduler so weak areas come up for review.

## Read first

`PLAN.md` §5, §10. `docs/LEARNING_MODEL.md`. The official exam pages and candidate handbook for
the current format (duration, task count, passing score, environment); re-check them on the web and
record the date.

## Build

- **Exam definitions**: a blueprint (duration, passing score, weight per curriculum domain, task
  count) and an assembler that draws tasks from the item pool by competency and difficulty with a
  seed, avoiding items reviewed in the last few days. Fixed, hand-curated exams are possible too.
  Blueprints for CKA and CKAD at full length and a short form (30 to 40 minutes).
- **Task worlds**: each task has its own world, as in the real exam where each task names the host
  to connect to. Switching tasks keeps each world's state and terminal history; time passes only in
  the task being worked on, or globally, according to the blueprint.
- **Exam UI**: countdown, task list with weights, flag for review, a notepad, next and previous,
  the task text beside the terminal; no hints, no X-ray, no figures, no solution, no check button;
  a confirm
  step before finishing; automatic finish at time zero.
- **Reference material**: `kubectl explain` and `--help` work as usual. State clearly in the UI
  that the real exam allows the official documentation in a browser, and that this platform doesn't
  bundle it.
- **Scoring**: grade every task at the end from final state, with partial credit per check; a
  report with total, pass or fail, score per curriculum domain, per-task check results, time spent
  per task, and the debrief for each task available afterward.
- **Feedback into learning**: each task counts as a review of its item and skills with a rating
  derived from its result; missed tasks get priority in the next sessions; exam history with a trend
  per domain on the home screen.
- **Resilience**: an exam survives a reload and a restart of the app by replay, without the clock
  cheating either way.
- **Terminal player**: `npm run exam -- <blueprint> [--seed N]` for a headless run with reference
  solutions, used by tests.
- Playwright test for a short exam from start to report.

## Not in this phase

Imitating the remote-desktop environment of the real exam. Writing new tasks (R1).

## Exit criteria

- A headless run of each blueprint with reference solutions scores 100%, and with no input scores 0%.
- The assembler respects domain weights within a tolerance and is deterministic for a seed; it
  reports clearly when the pool is too small for a blueprint, listing the missing competencies.
- Nothing in exam mode reveals state beyond the terminal, verified by a test of the worker protocol.
- Reloading mid-exam resumes with the right remaining time and every task's state.
- After an exam, the next daily queue prioritizes the skills of failed tasks.
