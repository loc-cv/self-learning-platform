# Phase 16a — Pod configuration, volumes, multi-container Pods

**Milestone** M3 · **Needs** 08 · Follow the session protocol in `CLAUDE.md`.

## Goal

How a Pod gets its configuration and files, and how several containers cooperate in one Pod. This
is a large share of CKAD and the source of many real incidents, so each reference must have its real
consequence: a missing ConfigMap key blocks the container with the real message.

## Read first

`PLAN.md` §6.3, §7. The behavior model documentation from phase 06b. Upstream kubelet sources for
event and status strings (search; don't read whole files). Capture new golden cases with the oracle
where the API server is the source of the behavior.

## Build

- **Configuration**: environment from literals, ConfigMaps, Secrets, the downward API and
  `envFrom`; missing references produce `CreateContainerConfigError` with the real messages; optional
  references; immutable ConfigMaps and Secrets; updates propagate to mounted volumes after the real
  delay and never to environment variables.
- **Volumes**: `emptyDir`, `configMap`, `secret`, `projected`, `downwardAPI`, `hostPath` (backed by
  the node's VFS), with `subPath`, `items`, modes and read-only mounts. Each container gets a
  filesystem view made of its image content plus mounts. Missing volume sources hold the Pod in
  `ContainerCreating` with the real events.
- **Multi-container**: init containers in order with their statuses and the `Init:` forms in the
  STATUS column; sidecars as restartable init containers; volumes shared between containers.
- **ServiceAccounts**: assignment, automount and the projected token volume.
- **Behavior models**: extend the catalog so models read environment, files and arguments (an app
  that needs a variable, a database that needs a password, a web server whose config file is
  mounted, a sidecar that tails a shared log file).
- **kubectl**: whatever `describe pod` and `get` need to show the new states; `create configmap`
  and `create secret` sources (`--from-literal`, `--from-file`, `--from-env-file`) if not complete.
- Extend the X-ray view provider. Add four items (drills and labs) on configuration and
  multi-container Pods.

## Not in this phase

Probes, resources, security context, lifecycle hooks (phase 16b). `kubectl exec` (phase 17).
PersistentVolumes (phase 21).

## Exit criteria

- Simulation tests for each failure family above assert status, events and timing.
- STATUS column values for init and config-error states match golden or upstream sources.
- A ConfigMap change reaches a mounted file after the modeled delay and leaves environment untouched.
- The new items pass `content:check`; `docs/COVERAGE.md` and the divergence register are current.
