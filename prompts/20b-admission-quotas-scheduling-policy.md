# Phase 20b — Admission, quotas, Pod Security, scheduling policy

**Milestone** M3 · **Needs** 20a · Follow the session protocol in `CLAUDE.md`.

## Goal

What the API server changes or refuses on the way in, and the scheduling rules beyond the basics.
After this phase a quota can reject a Pod, a namespace can enforce a security level, and Pods can
attract, repel and preempt each other.

## Read first

`PLAN.md` §7. The admission hooks in the request pipeline. The oracle runs real admission plugins
and a real scheduler: capture golden cases for every rejection, warning and scheduling message here.

## Build

- **Admission chain** in the real order, with mutating before validating:
  - LimitRange: default requests and limits, minimum, maximum and ratio bounds, for containers,
    Pods and claims.
  - ResourceQuota: compute and object-count quotas, scopes, status with used amounts, the
    requirement to set requests when a compute quota exists, and the real rejection text.
  - Pod Security admission: the three levels checked against the official policy tables, in
    enforce, warn and audit modes by namespace label, with version pinning; warnings shown by
    kubectl the way it shows them; workload controllers' Pods rejected at creation with events on
    the ReplicaSet.
  - NamespaceLifecycle, ServiceAccount, default toleration seconds, default StorageClass, Priority.
  - The API server's enabled-plugins list is data, so phase 27 can tie it to the component's flags.
- **Scheduling policy**: inter-Pod affinity and anti-affinity, topology spread constraints,
  PriorityClass with preemption (victim selection and the events on both sides), nominated node,
  PodDisruptionBudget with its status (the eviction API's use of it arrives with `drain` in phase 26b).
  Each new filter adds its real reason string to `FailedScheduling`.
- **kubectl**: `create quota`, `create priorityclass`, `create poddisruptionbudget`; printers and
  describers for LimitRange, ResourceQuota, PriorityClass and PodDisruptionBudget, and the quota
  and limits sections in `describe namespace`.
- X-ray: admission decisions and preemption in the trace. Add six items across quotas and
  LimitRange, Pod Security, affinity and spread, and an incident where a Deployment has zero Pods
  and no obvious error because a quota rejects them.

## Not in this phase

Admission webhooks and ValidatingAdmissionPolicy (a notice unless cheap). CRDs (phase 20c).

## Exit criteria

- Golden cases pass for quota exceeded, missing requests under a quota, LimitRange violations and
  injected defaults, and Pod Security rejections and warnings at each level.
- A table-driven Pod Security suite covers each control of the baseline and restricted levels.
- Simulation tests: anti-affinity spreads replicas one per node and leaves the extra Pending with
  the real message; a topology spread constraint is honored; a higher-priority Pod preempts and the
  victim is rescheduled or stays Pending.
- A quota blocks a ReplicaSet's Pods and the ReplicaSet events say so.
- The new items pass `content:check`.
