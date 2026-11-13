# Phase 06a — Cluster topology and scheduler

**Milestone** M1 · **Needs** 05b · Follow the session protocol in `CLAUDE.md`.

## Goal

A cluster to work in and a scheduler that places Pods for real reasons. When a Pod stays Pending,
the event must say exactly what a real scheduler says, because reading that message is the skill.

## Read first

`PLAN.md` §7. Golden fixtures for scheduling failures (phase 04). Upstream scheduler plugin sources
for the reason strings (search; don't read whole files).

## Build

- **Topology `kubeadm-1cp-2w`**: machines `controlplane`, `node01`, `node02` with a kubeadm-style
  file layout as far as exists so far; Node objects with capacity, allocatable, labels, addresses,
  Pod CIDRs, node info and the control-plane taint; the usual `kube-system` workloads as real
  objects; a kubeconfig for the default user. The terminal starts on `controlplane`.
- Until their own phases exist, control-plane components and DaemonSet-owned Pods are seeded as
  running objects. List every such shortcut in `STATUS.md` with the phase that removes it
  (DaemonSet: 18a; components: 26a, 27).
- **Scheduler**: a queue with retry when relevant cluster state changes; filters for node name,
  unschedulable nodes, taints and tolerations, node selector, required node affinity, resource fit
  (CPU, memory, Pod count, extended resources), host ports; preferred affinity and deterministic
  scoring; binding; `FailedScheduling` events in the exact upstream format, including how per-node
  reasons are counted, ordered and summarized. The scheduler can be stopped and started.
- Trace records for every decision: per node, which filter rejected it and why.
- A second small topology (single node) to prove topologies are data, not code paths.

## Not in this phase

Kubelet and container runtime (phase 06b): Pods get bound but don't run yet. Inter-Pod affinity
and topology spread (add them here only if the session has room; otherwise phase 20b). Preemption (20b).

## Exit criteria

- Simulation tests: an untolerated taint, an unmatched node selector, an unsatisfied required
  affinity, insufficient CPU, insufficient memory and a combination across nodes each leave the Pod
  Pending with a `FailedScheduling` message equal to the golden fixture.
- Fixing the cause (removing the taint, adding a toleration, freeing resources) schedules the Pod
  with no further input.
- With the scheduler stopped, new Pods stay Pending with no events, as in reality.
- Placement is deterministic for a seed and spreads replicas plausibly across workers.
- The topology's Node objects equal real ones in shape (compare with an oracle fake Node and
  upstream defaults).
