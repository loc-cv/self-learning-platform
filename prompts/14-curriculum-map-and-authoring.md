# Phase 14 — Curriculum map, skill graph, authoring guide, content tooling

**Milestone** M2 · **Needs** 11 · Follow the session protocol in `CLAUDE.md`.

## Goal

Decide what must be learned and how good content is written, before content is produced in volume.
The map guarantees nothing in the exams is missed; the guide and tooling guarantee that items
written in later sessions are consistent and teach well.

## Read first

`PLAN.md` §4.1, §5, §6.5, §8. `docs/curriculum/`. `docs/LEARNING_MODEL.md`.
`docs/SCENARIO_FORMAT.md`. The "Figures" guide phase 10c left in `docs/AUTHORING.md`.
Re-check the official CKA and CKAD curricula on the web and update `docs/curriculum/` if they changed.

## Build

- **Competency IDs**: one stable ID per official competency (for example
  `cka.troubleshooting.cluster-components`), stored as data that content validation uses.
- **Skill graph**: break each competency into small, practicable skills with prerequisites, plus
  cross-cutting fluency skills (kubectl output shaping, YAML generation, editing speed, log reading).
  Include the real-world operations skills from `PLAN.md` §4.1 that the exams don't list. Store it as
  data in the Kubernetes content pack.
- **`docs/CURRICULUM_MAP.md`**: for every competency, its skills, the engine features each skill
  needs and the phase that delivers them, the planned items by type, and a simulation-difficulty
  flag. For each skill, name its picture: the view or scene that makes its mental model visible,
  and whether the view provider can draw it yet. Call out what the simulator can only approximate
  and how the content will say so.
- **Tracks**: a CKAD path and a CKA path as ordered sequences respecting prerequisites, with their
  shared trunk, and a real-world operations track.
- **`docs/AUTHORING.md`**: how to write each item type. Tickets that state a goal or a symptom and
  never leak the method; hint ladders; debriefs (root cause, mental model, why the solution works,
  "in reality" notes); figures (show, then tell: which kind for which idea, what a ticket's
  figure may show, the debrief opening with the cause as a picture, how little prose may remain,
  scenes for anything that unfolds in time); prediction prompts; choosing parameters so variants
  differ meaningfully;
  difficulty and target-time calibration; cards that test understanding and not trivia; common
  mistakes; Vietnamese translation rules. Include one exemplary item of each type.
- **Tooling**: `npm run content:new` scaffolds an item; `npm run content:coverage` reports
  competencies and skills against existing items and shows gaps; lint rules for the mechanical parts
  of the guide (missing debrief sections, a lesson, lab or incident without a figure, a debrief
  over its word budget, a ticket containing a solution command, no parameters, target time
  missing, unknown skill or competency ID). `content:coverage` also lists items without figures.

## Not in this phase

Writing the content itself. That is `prompts/R1-content-pack.md`, run once per domain.

## Exit criteria

- Every official competency of both exams maps to at least one skill, and every skill to planned
  items; `content:coverage` shows the full matrix with today's gaps.
- The three existing labs pass the new lint rules, or were fixed to pass.
- Tracks load in the app and gate items by prerequisites.
- `STATUS.md` lists the R1 runs to do, in a sensible order, marking which are possible with the
  engine features that exist now.
