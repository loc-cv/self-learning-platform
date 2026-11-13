# Phase 18a — Job, CronJob, DaemonSet, StatefulSet

**Milestone** M3 · **Needs** 16b · Follow the session protocol in `CLAUDE.md`.

## Goal

The remaining workload kinds, so that "choose and use the right workload resource" can be practiced
for real.

## Read first

`PLAN.md` §7. Upstream controller sources for conditions and event strings (search; don't read
whole files). These controllers run for real in the oracle: capture golden cases for their objects,
events and kubectl output.

## Build

- **Job**: completions, parallelism, backoff limit, active deadline, completion modes, Pod failure
  handling, TTL after finished, suspend; the real conditions and events.
- **CronJob**: schedules evaluated against the virtual clock, concurrency policy, starting
  deadline, history limits, suspend, time zone; `kubectl create job --from=cronjob/…`.
- **DaemonSet**: one Pod per eligible node with the scheduling rules it really uses, its default
  tolerations, rolling update. Replace the DaemonSet shortcuts seeded in phase 06a.
- **StatefulSet**: ordered and parallel Pod management, stable names, headless Service identity in
  DNS, rolling update with partition, `volumeClaimTemplates` accepted (binding arrives with phase 21).
- **kubectl**: printers and describers for the four kinds; `create job`, `create cronjob`;
  `rollout` for DaemonSet and StatefulSet; `scale` for the kinds that support it; `logs job/…`.
- Extend the X-ray view provider. Add four items, including one that asks me to pick the right
  kind for a requirement and one with a failing Job.

## Not in this phase

Deployment strategies, metrics, autoscaling (phase 18b). Persistent storage for StatefulSets (21).

## Exit criteria

- Simulation tests for each controller's main and failure paths in virtual time, including a
  CronJob over several simulated hours with each concurrency policy.
- Golden cases for each kind's table and `describe` output pass or are in the divergence register.
- No seeded DaemonSet shortcut remains; `STATUS.md` reflects that.
- The new items pass `content:check`.
