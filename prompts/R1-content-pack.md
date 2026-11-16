# R1 — Content pack for one area (repeatable)

**Needs** phase 14 · Run once per target below · Follow the session protocol in `CLAUDE.md`.

**Target for this run:** `<replace with one target from the list, or leave blank to take the next one listed in STATUS.md>`

## Goal

Write the learning content for one area of the curriculum, to the standard of `docs/AUTHORING.md`.
Content is the product: an item that is vague, leaks its answer, or teaches something the simulator
gets wrong does harm. Prefer fewer excellent items to many average ones.

## Targets

Kubernetes pack, in a sensible order (the engine features each needs are in `docs/CURRICULUM_MAP.md`):

1. `k8s-foundations` — kubectl fluency, Pods, Deployments, Services, basic scheduling (possible after phase 10)
2. `ckad-design-build` 3. `ckad-deployment` 4. `ckad-observability` 5. `ckad-config-security`
6. `ckad-services-networking`
7. `cka-workloads-scheduling` 8. `cka-services-networking` 9. `cka-storage`
10. `cka-architecture-install` 11. `cka-troubleshooting`
12. `incidents-apps` — real-world application incidents with chained faults
13. `incidents-cluster` — real-world cluster and node incidents with chained faults
14. `mock-exams` — curated exam sets and extra exam-grade tasks to fill blueprint gaps

Other packs name their own targets (for example `linux-networking`).

## Read first

`docs/AUTHORING.md`, `docs/SCENARIO_FORMAT.md`, `docs/LEARNING_MODEL.md`, the target's rows in
`docs/CURRICULUM_MAP.md`, `npm run content:coverage` output, and two or three existing items as
style references. Check `docs/FIDELITY.md`'s divergence register for the features you will use.

## Do

1. **Plan before writing.** From the coverage report, list the skills of this target that lack
   items, and propose the set for this run: about 12 to 18 items, mixing lessons, drills, labs,
   incidents and cards so every skill gets a first exposure, fluency practice and one
   troubleshooting item. Check each planned item against the engine: if a needed feature isn't
   simulated or is only `approximate`, don't write around it. Drop the item and record the gap in
   `STATUS.md`.
2. **Write each item completely**: parameters that produce meaningfully different variants;
   a ticket that states a goal or a symptom the way a real ticket would; a three-rung hint ladder;
   checks on state and behavior, with constraints that rule out lazy fixes; at least one reference
   solution, and a second where a different valid approach exists; target time and difficulty;
   prediction prompts where an outcome is surprising; a debrief with the root cause, the mental
   model, why the solution works, common wrong turns, and "in reality" notes (including where a real
   distribution such as RKE2 differs, when I'd meet it at work). Show, then tell: every lesson,
   lab and incident has figures, the debrief opens with the cause as a picture, anything that
   unfolds in time is a scene, and the prose keeps only what a figure cannot say. If the view
   provider cannot draw what an item needs, extend it or record the gap; don't fall back to text.
3. **Play each item** through script mode or the terminal player, on at least two seeds: solve it a
   second way than the reference solution, try the lazy fix the constraints should block, and read
   the ticket as someone who doesn't know the answer. Look at every figure in the browser, in each
   variant: it must be readable at the panel's width and must not give the cause away in the
   ticket. Fix what you find.
4. **Sequence**: place the items in the track with prerequisites, so the worked example comes
   before the bare ticket and the bare ticket before the incident.
5. **Validate**: `npm run content:check` on five seeds per item, the authoring lint, and
   `content:coverage` again to show what this run closed.

Use subagents to draft items in parallel only after the plan is fixed, and review every draft
yourself against the authoring guide before accepting it. Don't translate; that is `R2`.

## Exit criteria

- Every item passes `content:check` on five seeds and the authoring lint with no waivers.
- Each item was played, not only validated; your summary names the alternative solution you tried
  for each lab and incident.
- Every lesson, lab and incident has at least one figure, and your summary includes screenshots of
  three debriefs.
- Coverage for the target's competencies is shown before and after.
- Engine gaps met while writing are in `STATUS.md` with the item idea that needs them.
- `STATUS.md` records this run under R1.
