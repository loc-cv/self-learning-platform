# Phase 13 — X-ray view, causal trace, time controls

**Milestone** M2 · **Needs** 12 · Follow the session protocol in `CLAUDE.md`.

## Goal

Show what a real cluster hides. A simulator can display cause and effect directly: which
controller created what, why the scheduler rejected each node, why a Service has no endpoints.
Seeing that builds mental models faster than output alone. It must also be possible to switch it
all off, because the exam gives no such help.

## Read first

`PLAN.md` §5, §6.1 (trace bus), §10. `docs/ARCHITECTURE.md` trace records.

## Build

- **View provider contract**: a plugin supplies a serializable view model of its world (entities,
  relations, health) and trace lookups. The UI renders view models and knows no domain. The
  Kubernetes plugin provides nodes with their Pods, ownership chains (Deployment, ReplicaSet, Pod),
  Services with their endpoints, and health states.
- **X-ray panel**: a live view of the world, updated from the worker at a throttled rate; filter by
  namespace; select an entity to see its key state.
- **"Why?" inspector**: for a selected entity, the causal chain from the trace. A Pending Pod shows
  each node and the reason it was rejected; a Pod in backoff shows the exit and the timer; a Service
  shows which Pods matched and which were not ready.
- **Timeline**: trace and event records over virtual time, scrubbable for reading (not time travel).
- **Time controls**: pause, 1×, 2×, 5×, 10×, and "skip to next event". The terminal stays
  consistent at every speed.
- **Assist levels**: per item and as a global setting: full X-ray, view without "why", or off.
  Using X-ray during an attempt is recorded and counts as help in the rating. Exam items force it off.
- **Debrief integration**: the debrief shows the causal chain of the scenario's faults and how the
  world changed when I fixed them.
- Audit trace coverage: every scheduler decision, controller action, kubelet transition and
  endpoint change built so far emits a record with a cause. Fill the holes you find.

## Not in this phase

View providers for features that don't exist yet. Each later engine phase extends the provider
for what it adds.

## Exit criteria

- In the scheduling lab, "Why?" on a Pending Pod names the same reasons as the `FailedScheduling`
  event, per node.
- Skipping to the next event during a backoff jumps exactly to the restart.
- With X-ray off, no part of the UI reveals world state beyond the terminal.
- Trace coverage tests exist for the components above.
- The UI stays responsive while a 30-Pod rollout runs at 10×. Include screenshots.
