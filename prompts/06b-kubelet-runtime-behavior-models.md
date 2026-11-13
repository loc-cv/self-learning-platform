# Phase 06b — Kubelet, container runtime, behavior models

**Milestone** M1 · **Needs** 06a · Follow the session protocol in `CLAUDE.md`.

## Goal

Make Pods live. Images get pulled, containers start, crash and back off on a realistic timeline,
and every step leaves the status, events and logs the real system leaves. This is where the
simulator starts to feel like a cluster.

## Read first

`PLAN.md` §6.3, §7. `docs/ARCHITECTURE.md` Kubernetes sections. No oracle exists for kubelet
strings yet, so read them from the upstream kubelet sources in `.upstream/` (search; don't read
whole files) and tag them `source-derived`.

## Build

- **Image registry and runtime**: a catalog of common images and tags with sizes and pull times;
  unknown repositories and tags fail with the real error texts; `ErrImagePull` then
  `ImagePullBackOff` with the real backoff; `imagePullPolicy` behavior; an image cache per node.
- **Behavior model format**: declarative and documented in `docs/BEHAVIOR_MODELS.md`. A model
  yields lifecycle, listening ports, log lines over time and exit codes from the container's
  resolved command, arguments and environment. Later phases extend the format; design for that.
- **Models v1**: `pause`, `nginx`, `httpd`, `redis`, and `busybox` and `alpine` running shell
  commands (sleep, echo, exit with a code, simple loops, a missing executable).
- **Kubelet per node**: sync on Pods bound to the node; sandbox and Pod IP from the node's Pod
  CIDR; container create and start; restart policy; `CrashLoopBackOff` with the real backoff
  sequence and reset; container states and reasons; Pod phase and conditions; ready when running
  (probes come in phase 16b); graceful termination; events (`Scheduled` comes from the scheduler;
  `Pulling`, `Pulled`, `Created`, `Started`, `BackOff`, `Failed`, `Killing` from the kubelet) with
  upstream messages; container logs written into the node's VFS under `/var/log/pods`; node
  heartbeat, Lease and Ready condition. Each kubelet can be stopped and started.
- Realistic latencies for each step, drawn from named PRNG streams, in one tunable table.
- Trace records for each transition with its cause.

## Not in this phase

kubectl. Probes, volumes, environment from ConfigMaps and Secrets, init containers (16a, 16b).
The kubelet as a systemd unit with real failure modes (phase 26a).

## Exit criteria

Simulation tests in virtual time, asserting on status, events and trace:
- A three-replica Deployment reaches Running across the worker nodes within a realistic number of seconds.
- A wrong image tag walks through `ErrImagePull` and `ImagePullBackOff` with the right timing and messages.
- A container that exits non-zero shows rising restart counts and the real backoff intervals; one
  that exits zero under `restartPolicy: Never` ends `Completed`.
- Deleting a Pod terminates it gracefully and the ReplicaSet replaces it.
- With a kubelet stopped, its Pods' status stops changing.
- Logs appear in the node VFS; the world hash is stable across runs.
