# Phase 10c — Figures in content: views, comparisons, diagrams, scenes

**Milestone** M1 · **Needs** 10b · Follow the session protocol in `CLAUDE.md`.

## Goal

Make content show before it tells. At Checkpoint A the debriefs were 300 to 500 words of prose
with nothing to look at; I called them boring and no different from other labs. Put figures into
the content format, rendered by the view layer of phase 10b from simulated worlds, so a picture
cannot drift from what the simulator does. Then rewrite the three labs around them.

## Read first

`PLAN.md` §5 ("Show, then tell"), §6.5, §8. `docs/SCENARIO_FORMAT.md` §10 and §11.
`docs/DESIGN.md`. The three labs in `packages/content/k8s/`.

## Build

- **Figure blocks** in the scenario format, allowed in the ticket, in debrief blocks and in
  lesson steps (lessons arrive in phase 11; define the block so they can use it). Every figure
  has a `caption` and an `alt` text, takes `when`, and substitutes parameters. Kinds:
  - `view`: one world through the view provider. `of` names the world: `start` (after setup),
    `solved` (after the first reference solution) or `now` (my world when the figure is shown).
    `focus` selects entities, `show` names the facts to display, `highlight` and `notes` point at
    entities.
  - `compare`: two views side by side with the differences marked (start and solved; mine and
    solved).
  - `scene`: a scripted run. A world (the item's baseline or a small one declared in the
    figure), steps in the vocabulary of setup and solutions, and a caption per frame. The engine
    runs it for real on a fork; the renderer animates from frame to frame; I step forward and
    back and can replay. Nothing plays by itself under reduced motion.
  - `diagram`: entities and relations written by hand in the renderer's shape vocabulary, for
    ideas that are not world state (the scheduler filtering, then scoring).
- **Worlds for figures.** `start` and `solved` are computed in the worker on forks; a scene runs
  on its own fork. None of them touches my session or its input log.
- **What a figure may show.** A ticket's figure shows only what the ticket states, never the
  cause: `show` is explicit so a reviewer can see that at a glance. A debrief may show
  everything. Exam items carry no figures. Views follow `PLAN.md` §6.5 "Honesty": no decorative
  motion, and a note with the divergence id where the model is coarser than reality.
- **Validation** in `npm run content:check`, per sampled seed and variant: every figure
  resolves; `focus` selects at least one entity; highlighted and noted entities exist; a scene
  runs without a gap and each frame differs from the one before; a figure under `when` is checked
  with that variant. Extend the generated schema.
- **Translation.** Captions, notes and alt texts are text units like any other prose.
- **Lab panel.** Figures render in the ticket and the debrief; the debrief opens with them.
  `npm run lab` in a terminal prints the caption and the alt text instead.
- **The three labs, rewritten.** Each debrief leads with figures for every cause variant, and at
  least one lab uses a scene. Cut the prose to what a figure cannot say, and account for every
  idea the old text taught: in a figure, in a caption, or kept as text. Suggested: the scheduling
  lab compares start and solved with taints, labels and requests shown; the broken rollout shows
  the Service selecting nothing, and a scene of a rollout stalling on a bad image while the old
  ReplicaSet keeps serving; the build lab shows the ownership chain and the Service's endpoints.
- **Docs.** `docs/SCENARIO_FORMAT.md` gains the figures section and loses the row in §14. A
  short "Figures" guide (when a figure, which kind, how much text may remain) goes into
  `docs/AUTHORING.md`, which phase 14 completes.

## Not in this phase

The replay of my own attempt, scenes anchored to trace records, and the timeline (phase 13).
Lesson and card items (phase 11). New content beyond the three labs.

## Exit criteria

- Each of the three labs opens its debrief with figures, for every variant, and one has a scene I
  can step through. Each debrief's prose is at most half its length before this phase; your
  summary says where each idea of the old text went.
- `content:check` fails on a figure whose focus selects nothing and on a scene with a gap
  (tests), and passes the three labs on five seeds.
- A `view` figure of `now` agrees with what `kubectl` prints for the same world, by test.
- No ticket figure shows state the ticket does not state; list each one and what it shows.
- Checks still grade state, and every reference solution still passes.
- Include screenshots of each debrief. Then tell me to play the labs again: **Checkpoint A2**.
