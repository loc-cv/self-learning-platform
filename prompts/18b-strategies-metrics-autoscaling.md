# Phase 18b — Deployment strategies, metrics, autoscaling

**Milestone** M3 · **Needs** 18a, 17 · Follow the session protocol in `CLAUDE.md`.

## Goal

Rolling out safely and scaling on load: blue/green and canary from plain primitives, resource
metrics, and the HorizontalPodAutoscaler with its real algorithm.

## Read first

`PLAN.md` §6.3, §7. Upstream HPA controller source and official documentation for the algorithm
and status conditions. Golden cases from the oracle for objects and kubectl output.

## Build

- **Strategies**: `Recreate`; surge and unavailable arithmetic with percentages and rounding checked
  against golden cases; pause and resume mid-rollout; blue/green by switching a Service selector;
  canary by replica ratio across two Deployments behind one Service, observable with repeated `curl`.
- **Load and usage**: behavior models report CPU and memory as a function of load; a scenario step
  and a simple in-cluster load generator can drive requests at a workload through the network model.
- **Metrics pipeline**: metrics exist only while a metrics-server workload runs and is reachable;
  `kubectl top pods` and `top nodes` (`--containers`, `--sort-by`, `-A`, `-l`) with their real
  output and their real errors when metrics are unavailable or not yet collected.
- **HorizontalPodAutoscaler**: `autoscaling/v2` with resource metrics (utilization and average
  value), the real replica calculation with tolerance, missing-metric handling, min and max,
  stabilization windows and scaling policies under `behavior`, status and conditions with real
  reasons; `kubectl autoscale`; the printer with its `TARGETS` column in every state.
- Extend the X-ray view provider with usage and HPA decisions (the trace explains each scale
  decision with its numbers). Add four items: a canary rollout, a blue/green switch, an HPA that
  doesn't scale because requests are missing, and reading `kubectl top` to find a hungry Pod.

## Not in this phase

Custom and external metrics, VPA, cluster autoscaling: explain in content; record the omission.

## Exit criteria

- Simulation tests: an HPA scales up under load and back down after the stabilization window, with
  replica counts matching the documented formula at each step.
- An HPA targeting Pods without CPU requests reports the real condition and `<unknown>` target.
- `kubectl top` fails the real way without metrics-server and works shortly after it starts.
- A canary at 25% receives roughly a quarter of requests over a seeded run.
- The new items pass `content:check`.
