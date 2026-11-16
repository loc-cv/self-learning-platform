# Phase 13 — Causal trace, replay of my attempt, time controls

**Milestone** M2 · **Needs** 12, 10b, 10c · Follow the session protocol in `CLAUDE.md`.

## Goal

Show cause, not only state. Phase 10b shows what the world is and phase 10c puts figures into
content. This phase shows why the world is as it is and how it got there: which controller created
what, why the scheduler rejected each node, why a Service has no endpoints, and what changed when
my fix landed. Seeing that builds mental models faster than output alone. It must also be possible
to switch it all off, because the exam gives no such help.

## Read first

`PLAN.md` §5, §6.1 (trace bus), §6.5, §10. `docs/ARCHITECTURE.md` trace records and the view
contract. `docs/DESIGN.md`.

## Build

- **Trace audit.** Every scheduler decision, controller action, kubelet transition and endpoint
  change built so far emits a record with a cause. Fill the holes you find. The view provider
  gains trace lookups: for an entity, the records that explain its state.
- **"Why?" inspector** on the X-ray: for a selected entity, the causal chain from the trace. A
  Pending Pod shows each node and the reason it was rejected; a Pod in backoff shows the exit and
  the timer; a Service shows which Pods matched and which were not ready.
- **Timeline.** Trace and event records over virtual time, with my inputs as markers, scrubbable
  for reading. A view of a past moment comes from replay; this is not time travel.
- **Replay in the debrief.** My attempt played from its input log as a scene: the world at the
  start with the causal chain of the scenario's faults, the moment each of my changes landed, and
  how the world converged. On request, the reference solution's run beside it.
- **Scenes with causes.** A scene's frames can anchor to trace records ("when the scheduler
  rejects node01") and its captions can quote the cause. Motion along a relation means a recorded
  cause (a controller creating, the scheduler binding, a probe failing), never decoration.
- **Time controls.** Pause, 1×, 2×, 5×, 10×, and "skip to next event". The terminal stays
  consistent at every speed.
- **Assist levels**, per item and as a global setting: full X-ray, view without "why", or off.
  Using the X-ray during an attempt is recorded (phase 10b records the event) and counts as help
  in the rating. Exam items force it off.

## Not in this phase

View providers for features that don't exist yet. Each later engine phase extends the provider
for what it adds.

## Exit criteria

- In the scheduling lab, "Why?" on a Pending Pod names the same reasons as the `FailedScheduling`
  event, per node.
- The debrief of a solved attempt replays it: the fault's cause, my fix, the convergence, each at
  the virtual time it happened, by test against the input log.
- Skipping to the next event during a backoff jumps exactly to the restart.
- With X-ray off, no part of the workspace reveals world state beyond the terminal and the
  ticket's own figures.
- Trace coverage tests exist for the components above.
- The UI stays responsive while a 30-Pod rollout runs at 10×. Include screenshots.
