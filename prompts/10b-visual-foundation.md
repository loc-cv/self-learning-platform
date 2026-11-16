# Phase 10b — Visual foundation: design language, view model, renderer, live X-ray

**Milestone** M1 · **Needs** 10 and the R3 run after Checkpoint A · Follow the session protocol in `CLAUDE.md`.

## Goal

My verdict at Checkpoint A (`docs/feedback-log.md`, 2026-11-17): the terminal feels real, but the
product is all text, it looks bland, and nothing shows the system. A simulator holds the whole
world as data, so it can show what a real cluster hides. Build the layer that does: one
domain-agnostic view model, one renderer, and the first surface, a live view of the world beside
the terminal. Give the app its look in the same phase, because the views will carry most of it.

## Read first

`PLAN.md` §5 ("Show, then tell"), §6.5, §9 ("Views are output too"), §10. `docs/ARCHITECTURE.md`
§2.9 (trace), §2.11 (registry kinds: `visualizer` is the placeholder this phase replaces).
`docs/feedback-log.md`. `apps/web/src/app/` as it stands.

## Build

- **Design language, `docs/DESIGN.md`.** What I said is wrong with the look: dull type and
  spacing; flat, no depth; nothing shows the system. Color was not the complaint. Define tokens
  for the type scale and weights, the spacing rhythm, surface levels and elevation, radii, motion
  (durations, easing, what may move and what never does), and the colors of states shared by the
  interface and the views (healthy, progressing, degraded, failed, unknown, selected), in the dark
  and the light theme. Early in the session, show me two directions as screenshots of the real
  workspace running a lab, not mock-ups, and let me choose. Then apply the chosen one to every
  existing screen. The terminal's own colors and font stay a terminal's.
- **View contract** in `kernel` (registry kind `view`, replacing `visualizer`). A provider is a
  pure function from a world to a serializable view model:
  - entities: a stable id, a kind, a label, the entity that contains it, a state, and a few facts
    (label and value) worth showing;
  - relations: typed links between entities (owns, runs on, selects, routes to, mounts, …);
  - kind descriptions: each kind names one shape from a small fixed vocabulary the renderer knows
    (a container of other things, a workload, a process, an endpoint, a store, a rule, …). Decide
    the vocabulary from what Kubernetes, a Linux host, a load balancer and a network path need,
    and write the reasoning down; adding a domain must not require a new shape for every kind.

  The same function serves the live world, a fork and a replayed world. Nothing in `kernel`,
  `learn` or the renderer names a domain concept (hard rule 8). Output order is defined (rule 4).
- **Providers.** Host: machines with their role. Kubernetes: nodes and the Pods on them, Pods
  that have no node yet, namespaces, the ownership chain (Deployment, ReplicaSet, Pod), Services
  with their endpoints, the state of each, and taints, labels, selectors and requests as facts.
  Words a real tool also prints (a Pod's status, a condition) come from the code that prints
  them for kubectl, not from a second implementation.
- **Renderer** in `apps/web`: SVG, drawn by our own code. Containment and layered relations;
  state styled from the tokens; an entity keeps its place while others come and go; zoom to fit
  and focus on a selection; reachable by keyboard; readable in both themes. Change is motion: an
  entity that appears, leaves, changes state or moves to another container animates, and nothing
  else moves. A reduced-motion setting turns animation into instant change. Prefer our own layout
  code; a layout dependency needs a recorded decision and must be bundled.
- **Live X-ray.** A third pane in the workspace with a toggle and a chord. The worker sends view
  models at a throttled rate; the page diffs and animates. Filter by namespace; select an entity
  to read its facts. Closed by default. Opening it is help: record it as a lab event so phase 11
  can rate it. No "why" yet (phase 13).
- **Tests.** Provider tests from worlds to view models; a simulation test that follows a rollout
  as a sequence of view models; a test that a view agrees with `kubectl get` on the same world
  (same Pods, same nodes, same statuses); browser tests that the scheduling lab shows its Pending
  Pods outside the nodes and, after the fix, on the right node.

## Not in this phase

Figures in content and scenes (phase 10c). The causal trace, the "Why?" inspector, the timeline,
speed controls and assist levels in the rating (phase 13). The home screen and the other learning
screens (phase 12), though the tokens must already cover what they will need.

If the phase does not fit one session, stop once the renderer shows the live world in the chosen
look, with the gate green, and record the rest as carry-over.

## Exit criteria

- I chose the look from two directions shown as screenshots, and every existing screen uses it.
  `docs/DESIGN.md` records the tokens and the rules for motion.
- In the scheduling lab, the X-ray shows three Pending Pods that belong to no node; after I fix
  the Deployment in the terminal, they appear on the right node without a reload.
- The view agrees with `kubectl get pods -A -o wide` and `kubectl get nodes` on the same world,
  by test.
- The renderer and the view contract contain no Kubernetes name; a test or lint rule says so.
- The page stays responsive while a 30-Pod rollout runs; reduced motion works.
- `npm run e2e` passes, the latency numbers of phase 10 still hold with the X-ray open, and the
  build still works offline. Include screenshots of the workspace with the X-ray open and closed,
  in both themes.
