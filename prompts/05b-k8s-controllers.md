# Phase 05b — Controller runtime and first controllers

**Milestone** M1 · **Needs** 05a · Follow the session protocol in `CLAUDE.md`.

## Goal

Reconciliation. After this phase a Deployment turns into a ReplicaSet and Pods, a Service gets
endpoints, and deleting an owner removes its dependents, all because controllers react to watch
events the way the real ones do. No kubelet yet.

## Read first

`PLAN.md` §7. `docs/ARCHITECTURE.md` controller runtime. Upstream controller sources for event
reasons and messages (search; don't read whole files). Golden fixtures for rollout objects and events.

## Build

- **Controller runtime**: watch-fed caches and work queues, processed in a deterministic order
  with modeled latency; a controller can be stopped and started (later tied to the
  controller-manager process); every action emits a trace record naming its cause.
- **Event recorder** that aggregates repeated events the way the real one does (count, first and
  last timestamps, series).
- **Deployment controller**: ReplicaSet creation with the pod-template-hash label, rolling update
  within surge and unavailable limits, revision annotations and history limit, rollback support,
  paused Deployments, status and conditions (`Available`, `Progressing`) with real reasons and messages.
- **ReplicaSet controller**: Pod creation and deletion with the real victim ordering, adoption and
  release by label changes, status.
- **Garbage collector**: owner references, background and foreground deletion, orphaning.
- **Namespace controller**: the default namespaces, content deletion when a namespace terminates.
- **ServiceAccount controller**: the `default` account per namespace.
- **EndpointSlice and Endpoints controllers**: from selectors and Pod readiness, including
  not-ready addresses and named ports.
- A test helper that plays kubelet: marks scheduled Pods running and ready, or failing.

## Not in this phase

Scheduler, kubelet, real Pod status. StatefulSet, DaemonSet, Job, CronJob (phase 18a). HPA (18b).

## Exit criteria

Simulation tests in virtual time, asserting on objects, events and trace:
- Creating a Deployment yields a ReplicaSet and the right number of Pods; scaling up and down works.
- A template change rolls out through a new ReplicaSet and never violates the surge and unavailable
  limits at any step; a rollback restores the previous template.
- A rollout with Pods that never become ready stops where the real one stops.
- Deleting a Deployment cascades; orphan deletion leaves the ReplicaSet.
- A Service has endpoints exactly for the ready Pods matching its selector, and relabeling a Pod
  moves it in and out.
- Deployment conditions and events equal the golden fixtures.
- Runs are deterministic: same seed, same world hash.
