# Phase 16b — Probes, resources, security context, lifecycle

**Milestone** M3 · **Needs** 16a · Follow the session protocol in `CLAUDE.md`.

## Goal

The Pod settings that decide whether a workload stays healthy: probes, resource limits, security
settings and lifecycle hooks. Stuck rollouts, restart loops and OOM kills come from here, in exams
and in production.

## Read first

`PLAN.md` §6.3, §7. Upstream kubelet sources for probe, OOM and security-context event and status
strings (search; don't read whole files).

## Build

- **Probes**: startup, liveness and readiness with HTTP, TCP, exec and gRPC handlers and all timing
  fields, evaluated against behavior models; the resulting restarts, readiness changes, `Unhealthy`
  events with real messages, and endpoint updates. Until phase 17, probes reach only their own
  container's listeners.
- **Resources**: requests and limits, QoS classes, `OOMKilled` when a model's memory use exceeds
  its limit (exit code 137 and the real status), CPU limits affecting behavior only where a model
  declares it.
- **Security context**: user and group IDs, `runAsNonRoot` with its real failure, `fsGroup`,
  read-only root filesystem, capabilities, privileged and privilege escalation settings. Behavior
  models react: an nginx that can't bind port 80 as non-root, or can't write its cache directory on a
  read-only filesystem, fails the way it really does.
- **Lifecycle**: `postStart` and `preStop` hooks, termination grace period, `restartPolicy` for bare
  Pods, and the `kubectl get` STATUS value for every state reachable above.
- **Rollouts and health**: a rollout whose new Pods never become ready stalls;
  `progressDeadlineSeconds`; `minReadySeconds`; `rollout status` reports each case the real way.
- **Behavior models**: declare health endpoints, startup time, memory use over time and failure
  modes; add a few application-like models (a web API with `/healthz` and a slow start, a worker that
  leaks memory).
- Extend the X-ray view provider. Add four items on probes, stuck rollouts and resource limits.

## Not in this phase

LimitRange, ResourceQuota, Pod Security admission (phase 20b). Metrics and autoscaling (phase 18b).

## Exit criteria

- Simulation tests: a failing liveness probe restarts the container on the real schedule; a failing
  readiness probe removes the Pod from endpoints without restarting it; a slow starter survives only
  with a startup probe; memory over the limit ends in `OOMKilled` and backoff.
- A stalled rollout exceeds its progress deadline and both `rollout status` and the Deployment
  conditions say so in the real words.
- Security-context failures show the real status and log lines.
- The new items pass `content:check`; `docs/COVERAGE.md` and the divergence register are current.
