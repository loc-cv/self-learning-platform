# Phase 09 — Scenario runner, checks, grader, three labs

**Milestone** M1 · **Needs** 08 · Follow the session protocol in `CLAUDE.md`.

## Goal

Turn the simulator into something that poses a task and judges the result. Grading reads the final
state and observable behavior, so any valid way of solving a lab passes. Three real labs prove the
format.

## Read first

`PLAN.md` §5, §8. `docs/SCENARIO_FORMAT.md` (refine it if implementing reveals a flaw, and record why).

## Build

- **`packages/learn`, runner**: load and validate a scenario against the schema; resolve seeded
  parameters; build the world from a topology and setup steps (apply manifests, run simulator
  commands, inject faults, advance time); hide setup traces from my shell history; expose the ticket.
  The runner knows nothing about Kubernetes; plugins register topologies, checks and faults.
- **Checks and grader**: evaluate checks on a fork of the world; per-check result with a
  human-readable explanation of what was expected and found; weights and partial credit; constraint
  checks ("must not be recreated", "must not be modified").
- **Check catalog v1**, registered by plugins: Kubernetes object exists or is absent, field
  conditions, Pods ready by selector, rollout complete, Service has endpoints, object unchanged or
  not recreated, node has taint; host file exists or contains; and the generic `shell.exec`.
- **Hints, reset, solution**: a hint ladder with use recorded; reset to the initial state; reference
  solutions as scripts.
- **`npm run content:check`**: for every item and several seeds, assert the schema is valid, the
  checks fail on the untouched world, and each reference solution passes. Part of `npm run check`.
- **`npm run lab -- <id> [--seed N]`**: the terminal player with a ticket, plus `check`, `hint`,
  `reset` and `solution` commands outside the simulated shell.
- **Three labs** in `packages/content/k8s/`, each with parameters, three hints, a debrief and at
  least one reference solution (two where there are clearly different valid approaches):
  1. A build task: create a Deployment and Service to a specification.
  2. A scheduling problem: Pods Pending for a reason drawn from a family (taint, node selector,
     resource request); the constraint forbids the lazy fix.
  3. A broken rollout: a bad image and a Service whose selector matches nothing, chained.

## Not in this phase

Spaced repetition, progress storage, lessons, drills, cards (phase 11). The web UI (phase 10).

## Exit criteria

- `npm run content:check` passes for all three labs on at least five seeds each.
- A test proves a lab passes when solved by a different valid path than the reference solution.
- A test proves checks don't mutate the session world.
- I can play each lab in my terminal with `npm run lab`, get stuck, take hints, check, and read a
  debrief. Show one full session.
